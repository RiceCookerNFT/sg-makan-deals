// The whole system, start to finish, on this machine:
//   sample deal feed -> scraper pipeline (fake AI, real checks) -> real local D1
//   -> the real bot Worker -> a user shares their location -> the reply text.
//
// Needs the bot to be built first: (cd ../bot && npm run build:test)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { AiClient } from '../src/ai';
import type { Geocoder } from '../src/locate';
import { buildMapData, type OsmElement } from '../src/locate';
import { formatReport, runPipeline, type PipelineDeps, type RunReport } from '../src/pipeline';
import { addDays, sgtToday } from '../src/text';
import type { Article, RawDeal } from '../src/types';
import { dateText, localDb, sampleFeed } from './helpers';

const TODAY = sgtToday();
const BOT = new URL('../../bot/dist/index.js', import.meta.url).pathname;
const BEDOK = { lat: 1.3240, lng: 103.9300 };
const BOTANIC = { lat: 1.3140, lng: 103.8160 };

let env: Awaited<ReturnType<typeof localDb>>;
let telegram: { method: string; body: Record<string, unknown> }[] = [];
let aiCalls = 0;

// --- Fakes for the outside world -------------------------------------------------

const fakeFetch = async (url: string) => {
  if (url === 'https://deals.test/feed/') return new Response(sampleFeed(TODAY));
  return new Response('not found', { status: 404 });
};

/** Plays the AI: returns what a model would plausibly return, including mistakes. */
const fakeAi: AiClient = {
  neuronsUsed: () => aiCalls * 120,
  budgetLeft: () => true,
  async extract(article: Article): Promise<RawDeal[]> {
    aiCalls++;
    if (article.url.endsWith('/lunch-deals-this-week/')) {
      return [
        { brand: "McDonald's", title: 'Pre-payday lunch meals', price_text: 'S$6.90', deal_type: 'price', scope: 'participating',
          end_date: addDays(TODAY, 4), conditions: ['app_only'],
          evidence: `McDonald’s is running pre-payday lunch meals from S$6.90 at participating outlets until ${dateText(TODAY, 4)}.` },
        { brand: 'Luckin Coffee', title: '1-for-1 lattes', price_text: '1-for-1', deal_type: '1for1', scope: 'all_outlets',
          start_date: addDays(TODAY, 1), end_date: addDays(TODAY, 3), conditions: ['while_stocks_last'],
          evidence: `Luckin Coffee has 1-for-1 lattes at all outlets from ${dateText(TODAY, 1)} to ${dateText(TODAY, 3)}, while stocks last.` },
        { brand: 'Tembusu', title: '20% off weekday lunch set', price_text: '20% off', deal_type: 'percent', scope: 'specific',
          locations: ['1 Cluny Road'], end_date: addDays(TODAY, 10),
          evidence: `Tembusu at 1 Cluny Road is offering 20% off its weekday lunch set until ${dateText(TODAY, 10)} for diners who book ahead.` },
        // Not food: passes the text checks but has no food outlets on the map, so it is never shown.
        { brand: 'Nike', title: 'Extra 30% off sale shoes', price_text: '30% off', scope: 'all_outlets', end_date: addDays(TODAY, 6),
          evidence: `Nike is giving an extra 30% off sale shoes until ${dateText(TODAY, 6)}.` },
        // Hallucinated: this sentence is not in the article.
        { brand: 'KFC', title: 'Free wings', price_text: 'Free', scope: 'all_outlets', end_date: addDays(TODAY, 5),
          evidence: 'KFC is giving away free wings at all outlets this week.' },
        // Expired.
        { brand: 'Kopi Corner', title: '$1 kopi', price_text: '$1', end_date: addDays(TODAY, -2),
          evidence: `Kopi Corner’s $1 kopi promotion ended on ${dateText(TODAY, -2)}, sadly.` },
      ];
    }
    if (article.url.endsWith('/gong-cha/')) {
      return [{ brand: 'Gong Cha', title: '1-for-1 pearl milk tea', price_text: '1-for-1', scope: 'all_outlets', end_date: addDays(TODAY, 3),
        evidence: `Gong Cha is offering 1-for-1 pearl milk tea at all outlets on ${dateText(TODAY, 3)}.` }];
    }
    return [];
  },
};

/** Plays Playwright for the feed item that only had a summary. */
const fakeBrowser: PipelineDeps['renderPages'] = async (_pages, toFill) => ({
  articles: toFill.map((a) => ({ ...a, text: `Gong Cha is offering 1-for-1 pearl milk tea at all outlets on ${dateText(TODAY, 3)}. Bring a friend!`.repeat(1) })),
  errors: [],
});

const fakeGeocoder: Geocoder = {
  lookups: () => 1,
  async geocode(q) {
    return /cluny/i.test(q) ? { lat: 1.3138, lng: 103.8159 } : null;
  },
};

/** Map data as OpenStreetMap would give it. */
function osm(): OsmElement[] {
  let id = 1;
  const el = (lat: number, lon: number, tags: Record<string, string>): OsmElement => ({ type: 'node', id: id++, lat, lon, tags });
  const list = [
    el(1.3245, 103.9305, { amenity: 'fast_food', name: "McDonald's", brand: "McDonald's", branch: 'Bedok Central' }),
    el(1.3500, 103.8480, { amenity: 'fast_food', name: "McDonald's", brand: "McDonald's", branch: 'Bishan' }),
    el(1.3255, 103.9290, { amenity: 'cafe', name: 'Luckin Coffee', 'addr:housename': 'Bedok Mall' }),
    el(1.3000, 103.8400, { amenity: 'cafe', name: 'Luckin Coffee', 'addr:housename': 'Plaza Singapura' }),
    el(1.3262, 103.9312, { amenity: 'cafe', name: 'Gong Cha', brand: 'Gong Cha' }),
  ];
  for (let i = 0; i < 35; i++) list.push(el(1.28 + i * 0.004, 103.80 + i * 0.004, { amenity: 'food_court', name: `Test ${i} Hawker Centre` }));
  return list;
}

function deps(): PipelineDeps {
  return {
    db: env.db,
    fetchImpl: fakeFetch as PipelineDeps['fetchImpl'],
    ai: fakeAi,
    geocoder: fakeGeocoder,
    config: { rss: [{ name: 'Test Deals', url: 'https://deals.test/feed/', categories: ['Food & Drinks'] }], pages: [] },
    today: TODAY,
    userAgent: 'test',
    renderPages: fakeBrowser,
    mapData: buildMapData(osm()),
  };
}

// --- The bot, sharing the same database ---------------------------------------------

before(async () => {
  assert.ok(existsSync(BOT), 'Build the bot first: cd ../bot && npm run build:test');
  env = await localDb(BOT, { BOT_TOKEN: 'T', WEBHOOK_SECRET: 's', ADMIN_KEY: 'a', TELEGRAM_API: 'https://tg.test' }, async (req) => {
    const body = await req.json().catch(() => ({}));
    telegram.push({ method: new URL(req.url).pathname.split('/').pop()!, body });
    return Response.json({ ok: true, result: {} });
  });
});
after(async () => { await env?.mf.dispose(); });

async function shareLocation(chatId: number, lat: number, lng: number): Promise<string> {
  telegram = [];
  await env.mf.dispatchFetch('https://bot.test/telegram', {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 's', 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: chatId, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: chatId }, location: { latitude: lat, longitude: lng } } }),
  });
  return String(telegram.filter((t) => t.method === 'sendMessage').at(-1)?.body.text ?? '');
}

// --- Tests ---------------------------------------------------------------------------

let first: RunReport;

test('scraper run: real deals saved, bad ones rejected', async () => {
  first = await runPipeline(deps());
  console.log(formatReport(first).split('\n').map((l) => `  ${l}`).join('\n'));
  assert.equal(first.articles, 2);                 // lunch roundup + Gong Cha (via browser)
  assert.equal(first.aiArticles, 2);
  assert.equal(first.rejected['evidence not found in the article'], 1);   // KFC
  assert.equal(first.rejected['already expired'], 1);                     // Kopi Corner
  assert.deepEqual(first.unlocated, ['Nike']);
  assert.equal(first.saved.new, 4);                // McDonald's, Luckin, Tembusu, Gong Cha
  assert.ok(first.hawkersSaved);
  const deals = await env.db.query<{ brand: string }>('SELECT brand FROM deals ORDER BY brand');
  assert.deepEqual(deals.map((d) => d.brand), ['Gong Cha', 'Luckin Coffee', "McDonald's", 'Tembusu']);
});

test('second run: unchanged articles skip the AI and rewrite nothing', async () => {
  const callsBefore = aiCalls;
  const writesBefore = env.db.writes();
  const second = await runPipeline(deps());
  assert.equal(aiCalls, callsBefore, 'no AI calls for unchanged articles');
  assert.equal(second.cachedArticles, 2);
  assert.equal(second.saved.unchanged, 4);
  const locWrites = env.db.writes() - writesBefore;
  console.log(`  second run wrote ${locWrites} rows (first run wrote ${writesBefore})`);
  assert.ok(locWrites < writesBefore / 2);
});

test('a user in Bedok gets the scraped deals from the bot', async () => {
  const text = await shareLocation(901, BEDOK.lat, BEDOK.lng);
  console.log(text.split('\n').map((l) => `  │ ${l}`).join('\n'));
  // Luckin starts tomorrow, so it must NOT show today.
  assert.doesNotMatch(text, /Luckin/);
  assert.match(text, /McDonald's Bedok Central/);
  assert.match(text, /Gong Cha/);
  assert.match(text, /App only/);
  assert.match(text, /Participating outlets/);
  assert.doesNotMatch(text, /Nike|KFC|Kopi Corner|Tembusu/);
});

test('a user at the Botanic Gardens gets the Tembusu deal', async () => {
  const text = await shareLocation(902, BOTANIC.lat, BOTANIC.lng);
  assert.match(text, /Tembusu/);
  assert.match(text, /20% off/);
});
