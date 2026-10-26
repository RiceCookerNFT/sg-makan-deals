// End-to-end tests: runs the real bundled Worker inside Miniflare (Cloudflare's
// local simulator) with a real local D1 database. Telegram and GitHub are faked,
// so we can see exactly which messages the bot would send.
//
// Run with: npm test

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';

const SECRET = 's3cret';
let mf, db, worker;
let calls = [];          // every outgoing request the Worker made
let blockedChats = new Set();

const BEDOK = { lat: 1.3240, lng: 103.9300 };     // test user location
const FAR = { lat: 1.4400, lng: 103.7800 };       // Woodlands-ish, no deals seeded nearby
const TODAY = sgtDate(new Date());

function sgtDate(d) {
  return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
}
function addDays(iso, n) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
}
function cellOf(lat, lng) {
  return `${Math.floor(lat / 0.009)}:${Math.floor(lng / 0.009)}`;
}

before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: 'dist/index.js',
    compatibilityDate: '2026-07-01',
    d1Databases: { DB: 'test-db' },
    bindings: {
      BOT_TOKEN: 'TEST',
      WEBHOOK_SECRET: SECRET,
      ADMIN_KEY: 'adm',
      TELEGRAM_API: 'https://tg.test',
      GH_TOKEN: 'ghtest',
      GH_REPO: 'me/sg-makan-deals',
      ALERT_BATCH: '25',
      LUNCH_START: '11:30',
      DINNER_START: '18:00',
      ALERT_WINDOW_MIN: '60',
      SCRAPE_TIMES: '10:00,16:00',
    },
    outboundService: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
      const method = url.pathname.split('/').pop();
      calls.push({ host: url.host, method, body });
      if (url.host === 'api.github.com') return new Response(null, { status: 204 });
      if (method === 'sendMessage' && blockedChats.has(body.chat_id)) {
        return Response.json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
  });
  db = await mf.getD1Database('DB');
  worker = await mf.getWorker();
  const schema = readFileSync('schema.sql', 'utf8')
    .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean);
  for (const stmt of schema) await db.prepare(stmt).run();
});

after(async () => { await mf.dispose(); });

beforeEach(async () => {
  calls = [];
  blockedChats = new Set();
  await db.prepare('DELETE FROM users').run();
  await db.prepare('DELETE FROM deals').run();
  await db.prepare('DELETE FROM deal_locations').run();
  await db.prepare('DELETE FROM places').run();
  await seed();
});

async function seed() {
  const deals = [
    // id, brand, title, price, type, conditions, start, end, score
    ['d1', "McDonald's", 'Pre-payday lunch deals', 'from S$6.90', 'price', '["app_only"]', null, addDays(TODAY, 3), 20],
    ['d2', 'Luckin Coffee', '1-for-1 lattes', '1-for-1', '1for1', '[]', null, addDays(TODAY, 1), 35],
    ['d3', 'Old Deal', 'This ended yesterday', '50% off', 'percent', '[]', null, addDays(TODAY, -1), 50],
    ['d4', 'Future Deal', 'Starts next week', '1-for-1', '1for1', '[]', addDays(TODAY, 5), addDays(TODAY, 10), 50],
    ['d5', 'Far Away Pizza', 'Only in Jurong', '1-for-1', '1for1', '[]', null, addDays(TODAY, 5), 50],
    ['d6', "McDonald's", 'McFlurry $1', 'S$1', 'price', '[]', null, addDays(TODAY, 5), 10],
    ['d7', "McDonald's", 'Third McD deal', 'S$2', 'price', '[]', null, addDays(TODAY, 5), 9],
  ];
  for (const [id, brand, title, price, type, cond, start, end, score] of deals) {
    await db.prepare(
      `INSERT INTO deals (id, brand, title, price_text, deal_type, conditions, start_date, end_date, source_url, source_name, n_sources, score_base, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'https://example.com/deal', 'Test Source', 2, ?, ?)`,
    ).bind(id, brand, title, price, type, cond, start, end, score, TODAY).run();
  }
  const locs = [
    ['d1', "McDonald's Bedok Central", 1.3245, 103.9305],  // ~80 m
    ['d1', "McDonald's Far", 1.3500, 103.9600],            // ~4 km, should not be chosen
    ['d2', 'Luckin Bedok Mall', 1.3255, 103.9290],         // ~200 m
    ['d3', 'Old Deal Bedok', 1.3241, 103.9301],
    ['d4', 'Future Deal Bedok', 1.3242, 103.9302],
    ['d5', 'Far Away Pizza Jurong', 1.3330, 103.7400],
    ['d6', "McDonald's Bedok Reservoir", 1.3290, 103.9330],// ~650 m
    ['d7', "McDonald's Bedok North", 1.3280, 103.9310],    // ~450 m
  ];
  for (const [id, name, lat, lng] of locs) {
    await db.prepare('INSERT INTO deal_locations (deal_id, name, lat, lng, cell) VALUES (?, ?, ?, ?, ?)')
      .bind(id, name, lat, lng, cellOf(lat, lng)).run();
  }
  await db.prepare("INSERT INTO places (kind, name, lat, lng, cell) VALUES ('hawker', 'Woodlands Hawker Centre', ?, ?, ?)")
    .bind(FAR.lat + 0.002, FAR.lng, cellOf(FAR.lat + 0.002, FAR.lng)).run();
}

let updateId = 1;
async function send(update) {
  const res = await mf.dispatchFetch('https://bot.test/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify({ update_id: updateId++, ...update }),
  });
  assert.equal(res.status, 200);
}
const nowSec = () => Math.floor(Date.now() / 1000);
const msg = (chatId, extra) => ({
  message: { message_id: 10, date: nowSec(), chat: { id: chatId, type: 'private' }, from: { id: chatId, first_name: 'Ah Boy' }, ...extra },
});
const sent = () => calls.filter((c) => c.method === 'sendMessage');

// ---------------------------------------------------------------------------

test('rejects requests without the Telegram secret', async () => {
  const res = await mf.dispatchFetch('https://bot.test/telegram', { method: 'POST', body: '{}' });
  assert.equal(res.status, 403);
});

test('/start shows the location button', async () => {
  await send(msg(1, { text: '/start' }));
  const m = sent()[0];
  assert.match(m.body.text, /food deals near you/);
  assert.equal(m.body.reply_markup.keyboard[0][0].request_location, true);
});

test('sharing a pin saves the user and replies with nearby deals', async () => {
  await send(msg(2, { location: { latitude: BEDOK.lat, longitude: BEDOK.lng } }));
  const user = await db.prepare('SELECT * FROM users WHERE chat_id = 2').first();
  assert.equal(user.loc_source, 'pin');
  assert.equal(user.lunch, 1);
  const [saved, deals] = sent();
  assert.match(saved.body.text, /Saved!/);
  const t = deals.body.text;
  assert.match(t, /Luckin Coffee/);
  assert.match(t, /McDonald's Bedok Central/);       // nearest outlet picked
  assert.doesNotMatch(t, /McDonald's Far/);
  assert.doesNotMatch(t, /Old Deal/);                // expired
  assert.doesNotMatch(t, /Future Deal/);             // not started
  assert.doesNotMatch(t, /Far Away Pizza/);          // outside 1 km
  assert.equal((t.match(/<b>McDonald's<\/b>/g) ?? []).length, 2); // max 2 deals per brand
  assert.match(t, /App only/);
  assert.match(t, /2 sources/);
  // Higher-value Luckin 1-for-1 ranks above McDonald's
  assert.ok(t.indexOf('Luckin') < t.indexOf("McDonald's"));
});

test('locations outside Singapore are refused', async () => {
  await send(msg(3, { location: { latitude: 51.5, longitude: -0.12 } }));
  assert.match(sent()[0].body.text, /outside Singapore/);
  assert.equal(await db.prepare('SELECT * FROM users WHERE chat_id = 3').first(), null);
});

test('live location: saved as live, moves are tracked but throttled', async () => {
  const t0 = nowSec() - 600;
  await send({ message: { message_id: 20, date: t0, chat: { id: 4, type: 'private' }, from: { id: 4 }, location: { latitude: BEDOK.lat, longitude: BEDOK.lng, live_period: 0x7fffffff } } });
  let u = await db.prepare('SELECT * FROM users WHERE chat_id = 4').first();
  assert.equal(u.loc_source, 'live');
  assert.equal(u.live_until, 0x7fffffff);
  assert.match(sent()[0].body.text, /Live location on/);

  // Moves 2 minutes later: stored
  const edit = (at, lat, lng) => ({ edited_message: { message_id: 20, date: t0, edit_date: at, chat: { id: 4, type: 'private' }, location: { latitude: lat, longitude: lng, live_period: 0x7fffffff } } });
  calls = [];
  await send(edit(t0 + 120, FAR.lat, FAR.lng));
  u = await db.prepare('SELECT * FROM users WHERE chat_id = 4').first();
  assert.equal(u.lat, FAR.lat);
  assert.equal(calls.length, 0, 'live updates must not send messages');

  // Another move only 20 s later: ignored (saves database writes)
  await send(edit(t0 + 140, BEDOK.lat, BEDOK.lng));
  u = await db.prepare('SELECT * FROM users WHERE chat_id = 4').first();
  assert.equal(u.lat, FAR.lat);

  // /now uses the live position -> no deals there -> hawker fallback
  await send(msg(4, { text: '/now' }));
  const t = sent().at(-1).body.text;
  assert.match(t, /No deals within 1 km/);
  assert.match(t, /Woodlands Hawker Centre/);
  assert.match(t, /your live location/);
});

test('/now without a location asks for one', async () => {
  await send(msg(5, { text: '🍜 Deals near me' }));
  assert.match(sent()[0].body.text, /don’t know where you are/);
});

test('alert buttons toggle lunch and change radius', async () => {
  await send(msg(6, { location: { latitude: BEDOK.lat, longitude: BEDOK.lng } }));
  await send({ callback_query: { id: 'cb1', from: { id: 6 }, data: 'tog:lunch', message: { message_id: 30, date: nowSec(), chat: { id: 6, type: 'private' } } } });
  await send({ callback_query: { id: 'cb2', from: { id: 6 }, data: 'rad:2000', message: { message_id: 30, date: nowSec(), chat: { id: 6, type: 'private' } } } });
  const u = await db.prepare('SELECT * FROM users WHERE chat_id = 6').first();
  assert.equal(u.lunch, 0);
  assert.equal(u.radius_m, 2000);
  assert.ok(calls.some((c) => c.method === 'editMessageReplyMarkup'));
});

test('/forget deletes the user', async () => {
  await send(msg(7, { location: { latitude: BEDOK.lat, longitude: BEDOK.lng } }));
  await send({ callback_query: { id: 'cb3', from: { id: 7 }, data: 'forget:yes', message: { message_id: 31, date: nowSec(), chat: { id: 7, type: 'private' } } } });
  assert.equal(await db.prepare('SELECT * FROM users WHERE chat_id = 7').first(), null);
});

// --- Scheduled alerts ---------------------------------------------------------

function utcFromSgt(date, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + ((h - 8) * 60 + m) * 60e3);
}
async function tick(at) {
  calls = [];
  await worker.scheduled({ scheduledTime: at, cron: '* * * * *' });
  return calls;
}
async function addUsers(n, startId = 1000) {
  const stmts = [];
  for (let i = 0; i < n; i++) {
    const lat = BEDOK.lat + (Math.random() - 0.5) * 0.06;  // spread over ~6 km
    const lng = BEDOK.lng + (Math.random() - 0.5) * 0.06;
    stmts.push(db.prepare('INSERT INTO users (chat_id, lat, lng, loc_source, loc_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(startId + i, lat, lng, 'pin', nowSec(), nowSec()));
  }
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
}

test('no alerts outside the alert windows', async () => {
  await addUsers(10);
  const out = await tick(utcFromSgt(TODAY, '14:00'));
  assert.equal(out.length, 0);
});

test('lunch alerts go out in batches of 25, never twice, and blocked users are switched off', async () => {
  await addUsers(60);
  blockedChats.add(1003);
  const first = await tick(utcFromSgt(TODAY, '11:30'));
  assert.equal(first.length, 25);
  assert.match(first[0].body.text, /Lunch deals near you|No deals within/);
  const second = await tick(utcFromSgt(TODAY, '11:31'));
  const third = await tick(utcFromSgt(TODAY, '11:32'));
  const fourth = await tick(utcFromSgt(TODAY, '11:33'));
  assert.equal(second.length, 25);
  assert.equal(third.length, 10);
  assert.equal(fourth.length, 0);
  const ids = [...first, ...second, ...third].map((c) => c.body.chat_id);
  assert.equal(new Set(ids).size, 60, 'each person exactly once');
  const blocked = await db.prepare('SELECT active FROM users WHERE chat_id = 1003').first();
  assert.equal(blocked.active, 0);
  // Dinner the same day still works
  const dinner = await tick(utcFromSgt(TODAY, '18:00'));
  assert.equal(dinner.length, 25);
  assert.match(dinner.find((c) => c.body.chat_id !== 1003).body.text, /Dinner deals near you|No deals within/);
});

test('scraper is started on GitHub at 10:00 Singapore time', async () => {
  const out = await tick(utcFromSgt(TODAY, '10:00'));
  assert.equal(out.length, 1);
  assert.equal(out[0].host, 'api.github.com');
  const none = await tick(utcFromSgt(TODAY, '10:01'));
  assert.equal(none.length, 0);
});

test('nightly cleanup removes expired deals', async () => {
  await tick(utcFromSgt(TODAY, '03:00'));
  assert.equal(await db.prepare("SELECT * FROM deals WHERE id = 'd3'").first(), null);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM deal_locations WHERE deal_id = 'd3'").first()).n, 0);
  assert.ok(await db.prepare("SELECT * FROM deals WHERE id = 'd2'").first());
});

test('LOAD: 1,000 users all get their lunch alert inside the 60-minute window, within free limits', async () => {
  await addUsers(1000, 5000);
  let total = 0;
  let maxCallsPerRun = 0;
  let maxMs = 0;
  let minutesUsed = 0;
  for (let m = 0; m < 60; m++) {
    const hh = 11 + Math.floor((30 + m) / 60);
    const mm = (30 + m) % 60;
    const t0 = performance.now();
    const out = await tick(utcFromSgt(TODAY, `${hh}:${String(mm).padStart(2, '0')}`));
    maxMs = Math.max(maxMs, performance.now() - t0);
    maxCallsPerRun = Math.max(maxCallsPerRun, out.length);
    total += out.length;
    if (out.length) minutesUsed = m + 1;
  }
  const done = (await db.prepare('SELECT COUNT(*) AS n FROM users WHERE last_lunch = ?').bind(TODAY).first()).n;
  console.log(`  1,000 users: ${total} alerts in ${minutesUsed} min, max ${maxCallsPerRun} outside calls per run (free limit 50), slowest run ${maxMs.toFixed(0)} ms wall time`);
  assert.equal(done, 1000);
  assert.equal(total, 1000);
  assert.ok(maxCallsPerRun <= 50);
  assert.ok(minutesUsed <= 60);
});
