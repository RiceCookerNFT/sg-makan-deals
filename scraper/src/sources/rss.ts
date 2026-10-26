// Reads deal articles from RSS feeds. Many Singapore sites run WordPress, which
// publishes a feed at /feed/ with the full article text, so no browser is needed:
// faster, cheaper and gentler on the site than scraping pages.

import { XMLParser } from 'fast-xml-parser';
import { addDays, htmlToText, normalize } from '../text';
import type { Article, FetchLike } from '../types';

export interface RssSource {
  name: string;
  url: string;
  enabled?: boolean;
  categories?: string[];   // keep items in any of these categories...
  keywords?: string[];     // ...or whose title contains one of these words
  maxAgeDays?: number;     // ignore older items (default 21)
  maxItems?: number;       // per run (default 25)
}

const DEFAULT_KEYWORDS = ['deal', '1-for-1', '1 for 1', 'promo', 'promotion', '% off', 'discount', 'buffet', 'freebie', 'free ', 'cheap', 'under s$', 'from s$'];

export async function fetchRss(src: RssSource, fetchImpl: FetchLike, today: string, userAgent: string): Promise<{ articles: Article[]; needsBrowser: Article[] }> {
  const res = await fetchImpl(src.url, { headers: { 'user-agent': userAgent, accept: 'application/rss+xml, application/xml' } });
  if (!res.ok) throw new Error(`${src.name}: feed returned HTTP ${res.status}`);
  const xml = await res.text();

  const parser = new XMLParser({ ignoreAttributes: true, processEntities: false, isArray: (name) => name === 'item' || name === 'category' });
  const doc = parser.parse(xml);
  const items: Record<string, unknown>[] = doc?.rss?.channel?.item ?? [];
  if (!Array.isArray(items)) throw new Error(`${src.name}: not an RSS feed`);

  const cats = (src.categories ?? []).map(normalize);
  const keywords = (src.keywords ?? DEFAULT_KEYWORDS).map(normalize);
  const oldest = addDays(today, -(src.maxAgeDays ?? 21));

  const articles: Article[] = [];
  const needsBrowser: Article[] = [];
  for (const item of items) {
    const title = htmlToText(String(item.title ?? ''));
    const link = String(item.link ?? '').trim();
    if (!title || !link) continue;

    const published = item.pubDate ? new Date(String(item.pubDate)) : null;
    const publishedAt = published && !isNaN(published.getTime()) ? published.toISOString().slice(0, 10) : undefined;
    if (publishedAt && publishedAt < oldest) continue;

    const itemCats = ((item.category as unknown[]) ?? []).map((c) => normalize(String(c)));
    const inCategory = cats.length > 0 && itemCats.some((c) => cats.includes(c));
    const hasKeyword = keywords.some((k) => normalize(title).includes(k));
    if (!inCategory && !hasKeyword) continue;

    const html = String(item['content:encoded'] ?? '');
    const text = htmlToText(html || String(item.description ?? ''));
    const article: Article = { url: link, title, sourceName: src.name, official: false, publishedAt, text };
    // Feeds that only give a short summary: the full page is rendered with Playwright instead.
    if (text.length < 600) needsBrowser.push(article);
    else articles.push(article);
    if (articles.length + needsBrowser.length >= (src.maxItems ?? 25)) break;
  }
  return { articles, needsBrowser };
}
