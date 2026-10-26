import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleFeed } from './helpers';
import { parseDeals } from '../src/ai';
import { insertRows } from '../src/d1';
import { mergeDeals } from '../src/deals';
import { buildMapData, outletsForBrand, words } from '../src/locate';
import { fetchRss } from '../src/sources/rss';
import { chunkText, htmlToText, normalize, sgtToday } from '../src/text';
import type { Article, CleanDeal, Db } from '../src/types';
import { dateMentioned, validateDeal } from '../src/validate';

const TODAY = '2026-10-20';
const article: Article = {
  url: 'https://deals.test/a', title: 'Deals', sourceName: 'Test', official: false, publishedAt: '2026-10-19',
  text: "McDonald’s is running pre-payday lunch meals from S$6.90 at participating outlets until 24 October. Luckin Coffee has 1-for-1 lattes from 21 to 23 October.",
};

test('htmlToText strips tags, captions and decodes entities', () => {
  const t = htmlToText('<p>McDonald&#8217;s &amp; KFC</p><figure><figcaption>caption</figcaption></figure><ul><li>One</li></ul>');
  assert.equal(t, 'McDonald’s & KFC\n\n• One');
});

test('normalize makes curly quotes and case comparable', () => {
  assert.equal(normalize('McDonald’s  LUNCH'), "mcdonald's lunch");
});

test('chunkText splits long text at paragraph breaks', () => {
  const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} `.repeat(40)).join('\n\n');
  const chunks = chunkText(text, 2000);
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every((c) => c.length <= 2000));
  assert.equal(chunks.join('\n\n').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
});

test('dateMentioned recognises common Singapore date styles', () => {
  const t = normalize('Valid until 24 October. Runs 21 to 23 Oct. Ends Nov 3rd. Promo 5/12 only.');
  assert.ok(dateMentioned('2026-10-24', t));
  assert.ok(dateMentioned('2026-10-23', t));
  assert.ok(dateMentioned('2026-10-21', t));
  assert.ok(dateMentioned('2026-11-03', t));
  assert.ok(dateMentioned('2026-12-05', t));
  assert.ok(!dateMentioned('2026-10-25', t));
});

test('validate keeps a real deal and keeps its real details', () => {
  const v = validateDeal({
    brand: "McDonald's", title: 'Pre-payday lunch meals', price_text: 'S$6.90', deal_type: 'price', scope: 'participating',
    end_date: '2026-10-24', conditions: ['app_only', 'made_up_condition'],
    evidence: "McDonald's is running pre-payday lunch meals from S$6.90 at participating outlets until 24 October.",
  }, article, TODAY);
  assert.ok(v.deal, v.reason);
  assert.equal(v.deal.priceText, 'S$6.90');
  assert.equal(v.deal.endDate, '2026-10-24');
  assert.equal(v.deal.endDateGuessed, false);
  assert.deepEqual(v.deal.conditions, ['app_only', 'participating_only']);
});

test('validate rejects made-up evidence and unknown brands', () => {
  assert.equal(validateDeal({ brand: 'KFC', title: 'Free wings', evidence: 'KFC is giving away free wings to everyone this week.' }, article, TODAY).reason, 'evidence not found in the article');
  assert.equal(validateDeal({ brand: 'Burger King', title: 'Lattes', evidence: 'Luckin Coffee has 1-for-1 lattes from 21 to 23 October' }, article, TODAY).reason, 'brand not mentioned in the article');
});

test('validate removes invented prices and dates instead of trusting them', () => {
  const v = validateDeal({
    brand: 'Luckin Coffee', title: '1-for-1 lattes', price_text: 'S$3.50', end_date: '2026-10-31',
    evidence: 'Luckin Coffee has 1-for-1 lattes from 21 to 23 October.',
  }, article, TODAY);
  assert.ok(v.deal);
  assert.equal(v.deal.priceText, null);            // 3.50 is not in the text
  assert.equal(v.deal.endDate, '2026-10-26');      // 31 Oct not in text -> published + 7 days
  assert.equal(v.deal.endDateGuessed, true);
  assert.equal(v.deal.dealType, '1for1');          // inferred from the title
});

test('validate rejects expired deals', () => {
  const old = { ...article, text: 'Kopi Corner had a $1 kopi promotion that ended on 18 October, sadly.' };
  const v = validateDeal({ brand: 'Kopi Corner', title: '$1 kopi', end_date: '2026-10-18', evidence: 'Kopi Corner had a $1 kopi promotion that ended on 18 October, sadly.' }, old, TODAY);
  assert.equal(v.reason, 'already expired');
});

test('parseDeals copes with chatty or broken AI output', () => {
  assert.equal(parseDeals('Sure! Here you go: {"deals":[{"brand":"A"}]} Hope this helps').length, 1);
  assert.equal(parseDeals({ deals: [{ brand: 'B' }, null, 'x'] }).length, 1);
  assert.deepEqual(parseDeals('not json at all'), []);
  assert.deepEqual(parseDeals('{"deals": [ broken'), []);
});

test('outlet matching uses brand tags and names, without false matches', () => {
  const map = buildMapData([
    { type: 'node', id: 1, lat: 1.32, lon: 103.93, tags: { amenity: 'fast_food', name: "McDonald's", brand: "McDonald's", branch: 'Bedok' } },
    { type: 'node', id: 2, lat: 1.35, lon: 103.85, tags: { amenity: 'fast_food', name: "McDonald's", brand: "McDonald's" } },
    { type: 'node', id: 3, lat: 1.30, lon: 103.84, tags: { amenity: 'cafe', name: 'Luckin Coffee Plaza Sing' } },
    { type: 'node', id: 4, lat: 1.30, lon: 103.84, tags: { amenity: 'cafe', name: 'Coffee Bean' } },
    { type: 'node', id: 5, lat: 51.5, lon: -0.1, tags: { amenity: 'cafe', name: 'Luckin Coffee London' } },
    { type: 'way', id: 6, center: { lat: 1.33, lon: 103.94 }, tags: { amenity: 'food_court', name: 'Bedok Interchange Hawker Centre' } },
  ]);
  assert.equal(words("McDonald's Singapore"), 'mcdonalds');
  assert.equal(outletsForBrand(map, "McDonald’s").length, 2);
  assert.equal(outletsForBrand(map, "McDonald's")[0].name, "McDonald's Bedok");
  assert.equal(outletsForBrand(map, 'Luckin Coffee').length, 1);   // London one excluded
  assert.equal(outletsForBrand(map, 'Coffee').length, 0);          // generic word must not match "Coffee Bean"
  assert.equal(outletsForBrand(map, 'Coffee Bean').length, 1);
  assert.equal(map.hawkers.length, 1);
});

test('duplicates from different sources merge and score higher', () => {
  const base: CleanDeal = {
    brand: 'Luckin Coffee', title: '1-for-1 lattes', priceText: '1-for-1', dealType: '1for1', scope: 'all_outlets', locations: [],
    startDate: null, endDate: '2026-10-23', endDateGuessed: false, conditions: [], sourceUrl: 'https://a.test', sourceName: 'Site A', official: false,
  };
  const merged = mergeDeals([base, { ...base, title: 'Buy 1 get 1 latte', sourceUrl: 'https://b.test', sourceName: 'Site B', conditions: ['app_only'] }]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources, ['Site A', 'Site B']);
  assert.deepEqual(merged[0].conditions, ['app_only']);
  const single = mergeDeals([base])[0];
  assert.ok(merged[0].score > single.score - 2); // +6 for 2 sources, -2 for app only
});

test('big inserts are split to respect the 100-values-per-query limit', async () => {
  const seen: number[] = [];
  const db: Db = { async query(_sql, params = []) { seen.push(params.length); return []; } };
  await insertRows(db, 't', ['a', 'b', 'c', 'd', 'e'], Array.from({ length: 53 }, (_, i) => [i, i, i, i, i]));
  assert.deepEqual(seen, [100, 100, 65]);
});

test('RSS: keeps recent food items, skips travel and old ones, flags summaries for the browser', async () => {
  const today = sgtToday();
  const xml = sampleFeed(today);
  const fakeFetch = async () => new Response(xml, { status: 200 });
  const got = await fetchRss({ name: 'Test', url: 'https://deals.test/feed/', categories: ['Food & Drinks'] }, fakeFetch, today, 'test');
  assert.deepEqual(got.articles.map((a) => a.url), ['https://deals.test/lunch-deals-this-week/']);
  assert.deepEqual(got.needsBrowser.map((a) => a.url), ['https://deals.test/gong-cha/']); // kept by keyword "1-for-1"
  assert.doesNotMatch(got.articles[0].text, /caption/i);
  assert.match(got.articles[0].text, /McDonald’s is running/);
});
