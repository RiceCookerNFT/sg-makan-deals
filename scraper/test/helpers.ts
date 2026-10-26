import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { addDays } from '../src/text';
import type { Db } from '../src/types';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "24 October" for today + n days. */
export function dateText(today: string, n: number): string {
  const iso = addDays(today, n);
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

/** The sample feed with its {{DATE+n}} / {{RFC+n}} placeholders filled in relative to `today`. */
export function sampleFeed(today: string): string {
  return readFileSync(new URL('./fixtures/feed.xml', import.meta.url), 'utf8')
    .replace(/\{\{DATE([+-]\d+)\}\}/g, (_, n) => dateText(today, Number(n)))
    .replace(/\{\{RFC([+-]\d+)\}\}/g, (_, n) => new Date(`${addDays(today, Number(n))}T02:00:00Z`).toUTCString());
}

/** A real local D1 database (same engine as production) with the bot's tables. */
export async function localDb(scriptPath?: string, bindings: Record<string, string> = {}, outbound?: (req: Request) => Promise<Response>) {
  const mf = new Miniflare({
    modules: true,
    // Pass the bundled bot code as text: the local runtime refuses paths outside this folder.
    script: scriptPath ? readFileSync(scriptPath, 'utf8') : 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-07-01',
    d1Databases: { DB: 'scraper-test' },
    bindings,
    ...(outbound ? { outboundService: outbound } : {}),
  });
  const d1 = await mf.getD1Database('DB');
  const schema = readFileSync(new URL('../../bot/schema.sql', import.meta.url), 'utf8')
    .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean);
  for (const stmt of schema) await d1.prepare(stmt).run();

  let writes = 0;
  const db: Db & { writes: () => number } = {
    writes: () => writes,
    async query(sql, params = []) {
      const res = await d1.prepare(sql).bind(...params).all();
      writes += res.meta?.rows_written ?? 0;
      return (res.results ?? []) as never[];
    },
  };
  return { mf, d1, db };
}
