// The whole scraping run, step by step. Everything outside (database, web,
// AI, browser) is passed in, so tests can run the exact same code with fakes.

import type { AiClient } from './ai';
import { mergeDeals } from './deals';
import { fetchMapData, locateDeal, type Geocoder, type MapData } from './locate';
import { fetchRss, type RssSource } from './sources/rss';
import type { PageSource } from './sources/pages';
import { cachedExtraction, rememberExtraction, saveDeal, saveHawkers } from './store';
import { chunkText, hashId } from './text';
import type { Article, CleanDeal, Db, FetchLike, RawDeal } from './types';
import { validateDeal } from './validate';

export interface SourcesConfig {
  rss: RssSource[];
  pages: PageSource[];
}

export interface PipelineDeps {
  db: Db;
  fetchImpl: FetchLike;
  ai: AiClient;
  geocoder: Geocoder;
  config: SourcesConfig;
  today: string;
  userAgent: string;
  renderPages?: (pages: PageSource[], toFill: Article[]) => Promise<{ articles: Article[]; errors: string[] }>;
  mapData?: MapData;           // tests pass this instead of downloading
  log?: (msg: string) => void;
}

export interface SourceReport { name: string; articles: number; deals: number; error?: string }

export interface RunReport {
  today: string;
  sources: SourceReport[];
  articles: number;
  aiArticles: number;
  cachedArticles: number;
  skippedForBudget: number;
  neurons: number;
  extracted: number;
  rejected: Record<string, number>;
  kept: number;
  merged: number;
  saved: { new: number; updated: number; unchanged: number };
  unlocated: string[];
  hawkers: number;
  hawkersSaved: boolean;
  outletsKnown: number;
  geocodeLookups: number;
  errors: string[];
}

export async function runPipeline(deps: PipelineDeps): Promise<RunReport> {
  const log = deps.log ?? (() => {});
  const r: RunReport = {
    today: deps.today, sources: [], articles: 0, aiArticles: 0, cachedArticles: 0, skippedForBudget: 0,
    neurons: 0, extracted: 0, rejected: {}, kept: 0, merged: 0, saved: { new: 0, updated: 0, unchanged: 0 },
    unlocated: [], hawkers: 0, hawkersSaved: false, outletsKnown: 0, geocodeLookups: 0, errors: [],
  };

  // 1. Map data: chain outlets + hawker centres.
  let map: MapData = deps.mapData ?? { byBrand: new Map(), byName: [], hawkers: [] };
  if (!deps.mapData) {
    try {
      map = await fetchMapData(deps.fetchImpl, deps.userAgent);
    } catch (err) {
      r.errors.push(`Map data: ${(err as Error).message}`);
    }
  }
  r.outletsKnown = map.byName.length;
  r.hawkers = map.hawkers.length;
  log(`map: ${map.byName.length} food places, ${map.hawkers.length} hawker centres`);

  // 2. Collect articles.
  const articles: Article[] = [];
  const needsBrowser: Article[] = [];
  const perSource = new Map<string, SourceReport>();
  for (const src of deps.config.rss.filter((s) => s.enabled !== false)) {
    const rep: SourceReport = { name: src.name, articles: 0, deals: 0 };
    perSource.set(src.name, rep);
    try {
      const got = await fetchRss(src, deps.fetchImpl, deps.today, deps.userAgent);
      articles.push(...got.articles);
      needsBrowser.push(...got.needsBrowser);
      rep.articles = got.articles.length + got.needsBrowser.length;
      log(`${src.name}: ${rep.articles} relevant items`);
    } catch (err) {
      rep.error = (err as Error).message;
    }
  }
  const pages = deps.config.pages.filter((p) => p.enabled !== false);
  for (const p of pages) perSource.set(p.name, { name: p.name, articles: 0, deals: 0 });
  if (pages.length || needsBrowser.length) {
    if (deps.renderPages) {
      const got = await deps.renderPages(pages, needsBrowser);
      articles.push(...got.articles);
      for (const a of got.articles) if (a.official || pages.some((p) => p.url === a.url)) perSource.get(a.sourceName)!.articles++;
      r.errors.push(...got.errors.map((e) => `Page: ${e}`));
    } else {
      r.errors.push(`${pages.length + needsBrowser.length} pages skipped (browser not available)`);
    }
  }
  r.articles = articles.length;

  // 3. AI extraction (cached per article), then 4. validation.
  const clean: CleanDeal[] = [];
  for (const article of articles) {
    const textHash = hashId(article.text);
    let raw = await cachedExtraction(deps.db, article.url, textHash);
    if (raw) {
      r.cachedArticles++;
    } else if (!deps.ai.budgetLeft()) {
      r.skippedForBudget++;
      continue;
    } else {
      try {
        raw = [];
        for (const chunk of chunkText(article.text)) raw.push(...(await deps.ai.extract(article, chunk, deps.today)));
        await rememberExtraction(deps.db, article.url, textHash, raw, deps.today);
        r.aiArticles++;
      } catch (err) {
        r.errors.push(`AI on "${article.title.slice(0, 60)}": ${(err as Error).message}`);
        continue;
      }
    }
    r.extracted += raw.length;
    for (const d of raw as RawDeal[]) {
      const v = validateDeal(d, article, deps.today);
      if (v.deal) {
        clean.push(v.deal);
        perSource.get(article.sourceName) && perSource.get(article.sourceName)!.deals++;
      } else {
        r.rejected[v.reason!] = (r.rejected[v.reason!] ?? 0) + 1;
      }
    }
  }
  r.kept = clean.length;
  r.neurons = deps.ai.neuronsUsed();

  // 5. Merge duplicates, 6. pin to places, 7. save.
  const merged = mergeDeals(clean);
  r.merged = merged.length;
  for (const deal of merged) {
    const outlets = await locateDeal(deal, map, deps.geocoder);
    if (!outlets.length) {
      r.unlocated.push(deal.brand);
      continue;
    }
    const status = await saveDeal(deps.db, deal, outlets, deps.today);
    r.saved[status]++;
  }
  r.geocodeLookups = deps.geocoder.lookups();
  r.hawkersSaved = await saveHawkers(deps.db, map.hawkers);
  r.sources = [...perSource.values()];
  return r;
}

/** Short summary for your Telegram and the GitHub run page. */
export function formatReport(r: RunReport): string {
  const live = r.saved.new + r.saved.updated + r.saved.unchanged;
  const lines = [
    `🧾 Scrape ${r.today}: ${live} deals live (${r.saved.new} new, ${r.saved.updated} updated)`,
    `Articles: ${r.articles} (${r.aiArticles} read by AI, ${r.cachedArticles} unchanged)${r.skippedForBudget ? `, ${r.skippedForBudget} left for next run (AI allowance)` : ''}`,
    `AI deals: ${r.extracted} found, ${r.kept} passed checks, ${r.merged} after merging duplicates`,
    `AI usage: ~${r.neurons} neurons (free: 10,000/day)`,
  ];
  const rej = Object.entries(r.rejected);
  if (rej.length) lines.push(`Rejected: ${rej.map(([k, v]) => `${v} ${k}`).join(', ')}`);
  if (r.unlocated.length) lines.push(`No location found for: ${[...new Set(r.unlocated)].slice(0, 10).join(', ')}`);
  lines.push(`Map: ${r.outletsKnown} food places, ${r.hawkers} hawker centres${r.hawkersSaved ? '' : ' (hawker list not updated)'}`);
  for (const s of r.sources) {
    const flag = s.error ? `❌ ${s.error}` : s.articles === 0 ? '⚠️ nothing found, check this source' : `${s.articles} articles, ${s.deals} deals`;
    lines.push(`• ${s.name}: ${flag}`);
  }
  if (r.errors.length) lines.push(`Problems:\n${r.errors.slice(0, 8).map((e) => `- ${e}`).join('\n')}`);
  return lines.join('\n');
}
