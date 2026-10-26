// Merging duplicates across sources and scoring deals.

import { words } from './locate';
import { hashId } from './text';
import type { CleanDeal } from './types';

export interface MergedDeal extends CleanDeal {
  id: string;
  sources: string[];
  score: number;
}

/** The same deal from several sites becomes one deal "confirmed by N sources". */
export function mergeDeals(deals: CleanDeal[]): MergedDeal[] {
  const groups = new Map<string, CleanDeal[]>();
  for (const d of deals) {
    const key = dedupeKey(d);
    const list = groups.get(key);
    if (list) list.push(d);
    else groups.set(key, [d]);
  }

  const out: MergedDeal[] = [];
  for (const [key, list] of groups) {
    // Prefer the brand's own page, then a deal with a real (not guessed) end date.
    list.sort((a, b) => Number(b.official) - Number(a.official) || Number(a.endDateGuessed) - Number(b.endDateGuessed));
    const primary = list[0];
    const sources = [...new Set(list.map((d) => d.sourceName))];
    const merged: MergedDeal = {
      ...primary,
      id: hashId(key),
      sources,
      conditions: [...new Set(list.flatMap((d) => d.conditions))],
      locations: [...new Set(list.flatMap((d) => d.locations))],
      score: 0,
    };
    merged.score = scoreDeal(merged);
    out.push(merged);
  }
  return out;
}

function dedupeKey(d: CleanDeal): string {
  const price = (d.priceText?.match(/\d+(?:\.\d+)?/g) ?? []).join('/');
  const what = price || words(d.title).split(' ').filter((w) => w.length > 3).slice(0, 3).join(' ');
  return `${words(d.brand)}|${d.dealType}|${what}`;
}

/** Base score (distance is added later by the bot, per user). */
export function scoreDeal(d: MergedDeal): number {
  let s = 0;
  if (d.dealType === '1for1') s += 30;
  else if (d.dealType === 'percent') {
    const pct = Number(`${d.priceText ?? ''} ${d.title}`.match(/(\d+)\s*%/)?.[1] ?? 20);
    s += Math.min(30, pct * 0.6);
  } else if (d.dealType === 'price') {
    const p = Number((d.priceText ?? d.title).match(/\d+(?:\.\d+)?/)?.[0] ?? 99);
    s += p <= 5 ? 22 : p <= 8 ? 16 : p <= 15 ? 12 : 8;
  } else if (d.dealType === 'freebie') s += 24;
  else s += 6;

  s += Math.min(12, (d.sources.length - 1) * 6);
  if (d.official) s += 8;
  if (d.endDateGuessed) s -= 3;
  const penalty: Record<string, number> = { card_only: 8, members_only: 5, min_spend: 4, app_only: 2, participating_only: 1 };
  for (const c of d.conditions) s -= penalty[c] ?? 0;
  return Math.round(s * 10) / 10;
}
