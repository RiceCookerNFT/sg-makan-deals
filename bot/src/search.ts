// Finding deals near a point. Two steps:
//   1. fetchArea: one database query for all deal locations in the grid cells
//      around the point (cheap: an index lookup, usually tens of rows).
//   2. rankForUser: pure code that measures distances and scores each deal.
// The alert sender reuses one fetchArea result for everyone in the same area.

import { cellsAround, distanceM, walkMinutes } from '../../shared/geo';
import { daysBetween } from './time';

export interface AreaRow {
  deal_id: string;
  brand: string;
  title: string;
  price_text: string | null;
  deal_type: string | null;
  conditions: string | null;
  end_date: string;
  source_url: string;
  source_name: string;
  n_sources: number;
  score_base: number;
  name: string;
  lat: number;
  lng: number;
}

export interface RankedDeal {
  id: string;
  brand: string;
  title: string;
  priceText: string | null;
  conditions: string[];
  endDate: string;
  sourceUrl: string;
  sourceName: string;
  nSources: number;
  outlet: string;
  distM: number;
  walkMin: number;
  score: number;
}

export interface Place {
  name: string;
  lat: number;
  lng: number;
  distM: number;
  walkMin: number;
}

export async function fetchArea(
  db: D1Database,
  lat: number,
  lng: number,
  radiusM: number,
  today: string,
): Promise<AreaRow[]> {
  const res = await areaStatement(db, lat, lng, radiusM, today).all<AreaRow>();
  return res.results ?? [];
}

export function areaStatement(
  db: D1Database,
  lat: number,
  lng: number,
  radiusM: number,
  today: string,
): D1PreparedStatement {
  const cells = cellsAround(lat, lng, radiusM);
  const marks = cells.map(() => '?').join(',');
  const sql = `
    SELECT l.deal_id, d.brand, d.title, d.price_text, d.deal_type, d.conditions,
           d.end_date, d.source_url, d.source_name, d.n_sources, d.score_base,
           l.name, l.lat, l.lng
    FROM deal_locations l
    JOIN deals d ON d.id = l.deal_id
    WHERE l.cell IN (${marks})
      AND d.end_date >= ?
      AND (d.start_date IS NULL OR d.start_date <= ?)`;
  return db.prepare(sql).bind(...cells, today, today);
}

export function rankForUser(
  rows: AreaRow[],
  lat: number,
  lng: number,
  radiusM: number,
  today: string,
  limit = 5,
): RankedDeal[] {
  // Keep only the nearest outlet of each deal.
  const nearest = new Map<string, { row: AreaRow; dist: number }>();
  for (const row of rows) {
    const dist = distanceM(lat, lng, row.lat, row.lng);
    if (dist > radiusM) continue;
    const prev = nearest.get(row.deal_id);
    if (!prev || dist < prev.dist) nearest.set(row.deal_id, { row, dist });
  }

  const ranked: RankedDeal[] = [];
  for (const { row, dist } of nearest.values()) {
    const daysLeft = daysBetween(today, row.end_date);
    const urgency = daysLeft <= 1 ? 8 : daysLeft <= 3 ? 4 : 0;
    const closeness = 30 * (1 - dist / radiusM);
    ranked.push({
      id: row.deal_id,
      brand: row.brand,
      title: row.title,
      priceText: row.price_text,
      conditions: safeJson(row.conditions),
      endDate: row.end_date,
      sourceUrl: row.source_url,
      sourceName: row.source_name,
      nSources: row.n_sources,
      outlet: row.name,
      distM: Math.round(dist),
      walkMin: walkMinutes(dist),
      score: row.score_base + closeness + urgency,
    });
  }

  ranked.sort((a, b) => b.score - a.score);

  // At most 2 deals per brand so one chain can't fill the whole list.
  const perBrand = new Map<string, number>();
  const out: RankedDeal[] = [];
  for (const d of ranked) {
    const key = d.brand.toLowerCase();
    const n = perBrand.get(key) ?? 0;
    if (n >= 2) continue;
    perBrand.set(key, n + 1);
    out.push(d);
    if (out.length >= limit) break;
  }
  return out;
}

const HAWKER_RADIUS_M = 2000;

export function hawkerStatement(db: D1Database, lat: number, lng: number): D1PreparedStatement {
  const cells = cellsAround(lat, lng, HAWKER_RADIUS_M);
  const marks = cells.map(() => '?').join(',');
  return db
    .prepare(`SELECT name, lat, lng FROM places WHERE kind = 'hawker' AND cell IN (${marks})`)
    .bind(...cells);
}

export function toPlaces(
  rows: { name: string; lat: number; lng: number }[],
  lat: number,
  lng: number,
  limit = 3,
): Place[] {
  return rows
    .map((p) => {
      const d = distanceM(lat, lng, p.lat, p.lng);
      return { ...p, distM: Math.round(d), walkMin: walkMinutes(d) };
    })
    .filter((p) => p.distM <= HAWKER_RADIUS_M)
    .sort((a, b) => a.distM - b.distM)
    .slice(0, limit);
}

export async function nearbyHawkers(db: D1Database, lat: number, lng: number): Promise<Place[]> {
  const res = await hawkerStatement(db, lat, lng).all<{ name: string; lat: number; lng: number }>();
  return toPlaces(res.results ?? [], lat, lng);
}

function safeJson(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
