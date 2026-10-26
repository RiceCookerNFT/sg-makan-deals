// Runs once a minute (Cloudflare Cron Trigger). It:
//   - sends the next batch of lunch/dinner alerts while an alert window is open
//   - starts the scraper on GitHub at the scrape times
//   - cleans out expired deals once a night
//
// Free-plan limits this is designed around: ~50 outside calls per run and 10 ms
// of CPU. So each run sends at most ALERT_BATCH messages (default 25), and people
// in the same ~1 km area share a single database query.

import { cellOf } from '../../shared/geo';
import type { Env } from './env';
import { formatResults } from './format';
import { areaStatement, hawkerStatement, rankForUser, toPlaces, type AreaRow } from './search';
import { sendMessage } from './telegram';
import { parseHHMM, sgt, type SgtClock } from './time';

type Slot = 'lunch' | 'dinner';

interface AlertUser {
  chat_id: number;
  lat: number;
  lng: number;
  radius_m: number;
  loc_source: string | null;
  loc_at: number | null;
  live_until: number | null;
}

export interface MinuteReport {
  sent: number;
  failed: number;
  blocked: number;
  scrapeTriggered: boolean;
  cleaned: boolean;
}

export async function runMinute(env: Env, at: Date): Promise<MinuteReport> {
  const clock = sgt(at);
  const report: MinuteReport = { sent: 0, failed: 0, blocked: 0, scrapeTriggered: false, cleaned: false };
  const windowMin = Number(env.ALERT_WINDOW_MIN || 60);

  for (const slot of ['lunch', 'dinner'] as Slot[]) {
    const start = parseHHMM(slot === 'lunch' ? env.LUNCH_START || '11:30' : env.DINNER_START || '18:00');
    if (clock.minutes >= start && clock.minutes < start + windowMin) {
      const r = await sendSlot(env, slot, clock, at);
      report.sent += r.sent;
      report.failed += r.failed;
      report.blocked += r.blocked;
    }
  }

  const scrapeTimes = (env.SCRAPE_TIMES || '10:00,16:00').split(',').map((s) => s.trim());
  if (scrapeTimes.includes(clock.hhmm)) report.scrapeTriggered = await triggerScraper(env);

  if (clock.hhmm === '03:00') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM deal_locations WHERE deal_id IN (SELECT id FROM deals WHERE end_date < ?)').bind(clock.date),
      env.DB.prepare('DELETE FROM deals WHERE end_date < ?').bind(clock.date),
    ]);
    report.cleaned = true;
  }
  return report;
}

async function sendSlot(env: Env, slot: Slot, clock: SgtClock, at: Date) {
  const result = { sent: 0, failed: 0, blocked: 0 };
  const batch = Number(env.ALERT_BATCH || 25);
  const lastCol = slot === 'lunch' ? 'last_lunch' : 'last_dinner';

  const users = (
    await env.DB.prepare(
      `SELECT chat_id, lat, lng, radius_m, loc_source, loc_at, live_until FROM users
       WHERE active = 1 AND ${slot} = 1 AND lat IS NOT NULL
         AND (${lastCol} IS NULL OR ${lastCol} != ?)
       ORDER BY chat_id LIMIT ?`,
    )
      .bind(clock.date, batch)
      .all<AlertUser>()
  ).results ?? [];
  if (users.length === 0) return result;

  // Claim this batch first, so an overlapping run can never double-send.
  const ids = users.map((u) => u.chat_id);
  await env.DB.prepare(`UPDATE users SET ${lastCol} = ? WHERE chat_id IN (${ids.map(() => '?').join(',')})`)
    .bind(clock.date, ...ids)
    .run();

  // One area query per (1 km cell, radius) group, all sent in a single round trip.
  const groups = new Map<string, AlertUser[]>();
  for (const u of users) {
    const key = `${cellOf(u.lat, u.lng)}|${u.radius_m}`;
    const list = groups.get(key);
    if (list) list.push(u);
    else groups.set(key, [u]);
  }
  const keys = [...groups.keys()];
  const stmts = keys.flatMap((k) => {
    const u = groups.get(k)![0];
    return [areaStatement(env.DB, u.lat, u.lng, u.radius_m, clock.date), hawkerStatement(env.DB, u.lat, u.lng)];
  });
  const results = await env.DB.batch(stmts);

  const nowSec = Math.floor(at.getTime() / 1000);
  const messages: { chatId: number; text: string }[] = [];
  keys.forEach((k, i) => {
    const rows = (results[i * 2].results ?? []) as AreaRow[];
    const hawkerRows = (results[i * 2 + 1].results ?? []) as { name: string; lat: number; lng: number }[];
    for (const u of groups.get(k)!) {
      const deals = rankForUser(rows, u.lat, u.lng, u.radius_m, clock.date);
      const hawkers = deals.length ? [] : toPlaces(hawkerRows, u.lat, u.lng);
      const text = formatResults(deals, hawkers, u.radius_m, slot, {
        source: u.loc_source, locAt: u.loc_at, liveUntil: u.live_until, nowSec,
      });
      messages.push({ chatId: u.chat_id, text });
    }
  });

  // Cloudflare allows 6 connections at once, so send in groups of 6.
  const blocked: number[] = [];
  for (let i = 0; i < messages.length; i += 6) {
    const chunk = messages.slice(i, i + 6);
    const res = await Promise.all(chunk.map((m) => sendMessage(env, m.chatId, m.text)));
    res.forEach((r, j) => {
      if (r.ok) result.sent++;
      else if (r.error_code === 403) blocked.push(chunk[j].chatId);
      else result.failed++;
    });
  }

  if (blocked.length) {
    // They blocked the bot: stop messaging them.
    await env.DB.prepare(`UPDATE users SET active = 0 WHERE chat_id IN (${blocked.map(() => '?').join(',')})`)
      .bind(...blocked)
      .run();
    result.blocked = blocked.length;
  }
  return result;
}

/** Starts the scraper workflow on GitHub right now (more reliable than GitHub's own timer). */
async function triggerScraper(env: Env): Promise<boolean> {
  if (!env.GH_TOKEN || !env.GH_REPO) return false;
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/scrape.yml/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'sg-makan-deals-bot',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  return res.status === 204;
}
