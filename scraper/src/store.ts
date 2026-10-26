// Writing results into the bot's database, using as few writes as possible
// (the free plan allows 100,000 row writes a day).

import { cellOf } from '../../shared/geo';
import { insertRows } from './d1';
import type { MergedDeal } from './deals';
import { hashId } from './text';
import type { Db, Outlet, RawDeal } from './types';

export async function saveDeal(db: Db, deal: MergedDeal, outlets: Outlet[], today: string): Promise<'new' | 'updated' | 'unchanged'> {
  // One fingerprint of everything the bot shows. Same fingerprint = skip all writes.
  const content = [deal.brand, deal.title, deal.priceText, deal.dealType, deal.conditions.join(','), deal.startDate, deal.endDate, deal.sourceUrl, deal.sources.length, deal.score].join('|');
  const locHash = hashId(`${content}#${outlets.map((o) => `${o.name}|${o.lat.toFixed(5)}|${o.lng.toFixed(5)}`).sort().join(';')}`);
  const existing = await db.query<{ loc_hash: string | null }>('SELECT loc_hash FROM deals WHERE id = ?', [deal.id]);
  if (existing.length && existing[0].loc_hash === locHash) return 'unchanged';

  await db.query(
    `INSERT INTO deals (id, brand, title, price_text, deal_type, conditions, start_date, end_date, source_url, source_name, n_sources, score_base, loc_hash, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       brand = excluded.brand, title = excluded.title, price_text = excluded.price_text, deal_type = excluded.deal_type,
       conditions = excluded.conditions, start_date = excluded.start_date, end_date = excluded.end_date,
       source_url = excluded.source_url, source_name = excluded.source_name, n_sources = excluded.n_sources,
       score_base = excluded.score_base, loc_hash = excluded.loc_hash, last_seen = excluded.last_seen`,
    [
      deal.id, deal.brand, deal.title, deal.priceText, deal.dealType, JSON.stringify(deal.conditions),
      deal.startDate, deal.endDate, deal.sourceUrl, deal.sourceName, deal.sources.length, deal.score, locHash, today,
    ],
  );

  if (existing.length) await db.query('DELETE FROM deal_locations WHERE deal_id = ?', [deal.id]);
  await insertRows(db, 'deal_locations', ['deal_id', 'name', 'lat', 'lng', 'cell'],
    outlets.map((o) => [deal.id, o.name, o.lat, o.lng, cellOf(o.lat, o.lng)]));
  return existing.length ? 'updated' : 'new';
}

export async function saveHawkers(db: Db, hawkers: Outlet[]): Promise<boolean> {
  // Safety: never wipe the fallback list because of a bad download.
  if (hawkers.length < 30) return false;
  const key = (h: { name: string; lat: number; lng: number }) => `${h.name}|${h.lat.toFixed(5)}|${h.lng.toFixed(5)}`;
  const current = await db.query<{ name: string; lat: number; lng: number }>("SELECT name, lat, lng FROM places WHERE kind = 'hawker'");
  if (hashId(current.map(key).sort().join(';')) === hashId(hawkers.map(key).sort().join(';'))) return true; // unchanged
  await db.query("DELETE FROM places WHERE kind = 'hawker'");
  await insertRows(db, 'places', ['kind', 'name', 'lat', 'lng', 'cell'],
    hawkers.map((h) => ['hawker', h.name, h.lat, h.lng, cellOf(h.lat, h.lng)]));
  return true;
}

/** Remembering what the AI found in an article, so unchanged articles skip the AI. */
export async function cachedExtraction(db: Db, url: string, textHash: string): Promise<RawDeal[] | null> {
  const rows = await db.query<{ hash: string; deals_json: string }>('SELECT hash, deals_json FROM articles WHERE url = ?', [url]);
  if (!rows.length || rows[0].hash !== textHash) return null;
  try {
    return JSON.parse(rows[0].deals_json) as RawDeal[];
  } catch {
    return null;
  }
}

export async function rememberExtraction(db: Db, url: string, textHash: string, deals: RawDeal[], today: string) {
  await db.query('INSERT OR REPLACE INTO articles (url, hash, deals_json, processed_at) VALUES (?, ?, ?, ?)',
    [url, textHash, JSON.stringify(deals), today]);
}
