// The anti-hallucination layer. Every deal the AI returns must be backed by the
// original text, or it is fixed or thrown away:
//   - the "evidence" sentence must appear word for word in the article  -> else REJECT
//   - the brand name must appear in the article                         -> else REJECT
//   - prices must use numbers that appear in the article                -> else price removed
//   - dates must be written in the article                              -> else replaced by a safe default
//   - expired deals                                                     -> REJECT

import { addDays, normalize } from './text';
import type { Article, CleanDeal, RawDeal } from './types';

const CONDITIONS = new Set(['app_only', 'card_only', 'members_only', 'dine_in', 'takeaway', 'min_spend', 'limited_hours', 'while_stocks_last']);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export interface Verdict {
  deal?: CleanDeal;
  reason?: string;
}

export function validateDeal(raw: RawDeal, article: Article, today: string): Verdict {
  const text = normalize(article.text);
  const brand = clean(raw.brand) || article.brandHint || '';
  const title = clean(raw.title);
  if (brand.length < 2 || brand.length > 60) return { reason: 'missing or odd brand name' };
  if (title.length < 3 || title.length > 140) return { reason: 'missing or odd title' };

  // 1. Evidence must be a real sentence from the text.
  const evidence = normalize(clean(raw.evidence)).replace(/^["'“]+|["'”.!?…]+$/g, '');
  if (evidence.length < 15) return { reason: 'no evidence sentence' };
  if (!text.includes(evidence)) return { reason: 'evidence not found in the article' };

  // 2. Brand must be mentioned (official brand pages are exempt).
  if (!article.brandHint && !text.includes(normalize(brand))) return { reason: 'brand not mentioned in the article' };

  // 3. Every number in the price must appear in the text.
  let priceText = clean(raw.price_text) || null;
  if (priceText) {
    const nums = priceText.match(/\d+(?:\.\d+)?/g) ?? [];
    const ok = nums.every((n) => text.includes(n)) || /1-?for-?1/i.test(priceText);
    if (!ok) priceText = null;
  }

  // 4. Dates must be written in the text.
  let startDate = isoOrNull(raw.start_date);
  let endDate = isoOrNull(raw.end_date);
  if (startDate && !dateMentioned(startDate, text)) startDate = null;
  if (endDate && !dateMentioned(endDate, text)) endDate = null;
  if (endDate && endDate < today) return { reason: 'already expired' };
  if (startDate && endDate && startDate > endDate) startDate = null;

  let endDateGuessed = false;
  if (!endDate) {
    // No end date stated: assume it runs a week from publication.
    endDate = addDays(article.publishedAt ?? today, 7);
    endDateGuessed = true;
    if (endDate < today) return { reason: 'old article with no end date' };
  }
  const maxEnd = addDays(today, 90);
  if (endDate > maxEnd) endDate = maxEnd;

  // 5. Tidy the rest.
  const dealType = inferType(raw.deal_type, priceText, title);
  const locations = (Array.isArray(raw.locations) ? raw.locations : []).map(clean).filter((l) => l.length >= 3).slice(0, 20);
  let scope: CleanDeal['scope'] = raw.scope === 'specific' || raw.scope === 'participating' ? raw.scope : 'all_outlets';
  if (scope === 'specific' && locations.length === 0) scope = 'participating';
  const conditions = [...new Set((raw.conditions ?? []).map(String).filter((c) => CONDITIONS.has(c)))];
  if (scope === 'participating') conditions.push('participating_only');

  return {
    deal: {
      brand, title, priceText, dealType, scope, locations,
      startDate, endDate, endDateGuessed, conditions,
      sourceUrl: article.url, sourceName: article.sourceName, official: article.official,
    },
  };
}

function clean(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

/** Is this date written in the text, e.g. "24 October", "Oct 24", "24/10"? */
export function dateMentioned(iso: string, normText: string): boolean {
  const day = Number(iso.slice(8, 10));
  const month = Number(iso.slice(5, 7));
  const full = MONTHS[month - 1];
  const short = full.slice(0, 3);
  const m = `(?:${full}|${short}\\.?)`;
  const d = `0?${day}(?:st|nd|rd|th)?`;
  const patterns = [
    new RegExp(`\\b${d}\\s*(?:-|–|to|and|&)?\\s*(?:\\d{1,2}(?:st|nd|rd|th)?\\s*)?${m}\\b`), // "24 oct", "20 to 24 october"
    new RegExp(`\\b${m}\\s*${d}\\b`),                                                       // "october 24"
    new RegExp(`\\b0?${day}/0?${month}\\b`),                                                // "24/10"
  ];
  // Ranges like "20-26 April" mention the start day too, so look for the day near the month.
  if (patterns.some((p) => p.test(normText))) return true;
  const range = new RegExp(`\\b0?${day}(?:st|nd|rd|th)?\\s*(?:-|–|to)\\s*\\d{1,2}(?:st|nd|rd|th)?\\s*${m}\\b`);
  return range.test(normText);
}

function inferType(given: unknown, price: string | null, title: string): CleanDeal['dealType'] {
  const s = `${price ?? ''} ${title}`.toLowerCase();
  if (/1\s*-?\s*for\s*-?\s*1|buy 1,? get 1|bogo|buy one,? get one/.test(s)) return '1for1';
  if (/\d+\s*%/.test(s)) return 'percent';
  if (/\bfree\b/.test(s)) return 'freebie';
  if (/\$\s*\d|\bs\$/.test(s)) return 'price';
  return given === '1for1' || given === 'percent' || given === 'price' || given === 'freebie' ? given : 'other';
}
