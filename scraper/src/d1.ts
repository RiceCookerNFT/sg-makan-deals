// Talks to the bot's Cloudflare D1 database over Cloudflare's HTTP API, so the
// scraper (running on GitHub) can write deals straight into it.

import type { Db, FetchLike } from './types';

export function d1Rest(opts: { accountId: string; databaseId: string; apiToken: string; fetchImpl: FetchLike }): Db {
  const url = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/d1/database/${opts.databaseId}/query`;
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      for (let attempt = 1; ; attempt++) {
        const res = await opts.fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ sql, params }),
        });
        const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { results?: T[] }[]; errors?: unknown };
        if (res.ok && body.success) return body.result?.[0]?.results ?? [];
        if (attempt >= 3 || (res.status < 500 && res.status !== 429)) {
          throw new Error(`D1 query failed (HTTP ${res.status}): ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
        }
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    },
  };
}

/** D1 allows at most 100 values per query, so big inserts are split up. */
export async function insertRows(db: Db, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  const perRow = columns.length;
  const rowsPerQuery = Math.max(1, Math.floor(100 / perRow));
  for (let i = 0; i < rows.length; i += rowsPerQuery) {
    const chunk = rows.slice(i, i + rowsPerQuery);
    const marks = chunk.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
    await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${marks}`, chunk.flat());
  }
}
