// Pins deals to real places.
//   - Chain outlets and hawker centres come from OpenStreetMap (free, open data,
//     credit "© OpenStreetMap contributors"), downloaded once per run.
//   - Specific addresses / mall names are looked up on OneMap, Singapore's
//     official map service, and cached so each address is looked up only once.

import { distanceM, inSingapore } from '../../shared/geo';
import { normalize } from './text';
import type { CleanDeal, Db, FetchLike, Outlet } from './types';

export interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface MapData {
  byBrand: Map<string, Outlet[]>;
  byName: { words: string; outlet: Outlet }[];
  hawkers: Outlet[];
}

export const OVERPASS_QUERY = `[out:json][timeout:120];
area["ISO3166-1"="SG"][admin_level=2]->.sg;
(
  nwr["amenity"~"^(fast_food|restaurant|cafe|ice_cream|food_court|bar|pub|marketplace)$"]["name"](area.sg);
  nwr["shop"~"^(bakery|beverages|tea|coffee|confectionery|pastry)$"]["name"](area.sg);
);
out center tags;`;

export async function fetchMapData(fetchImpl: FetchLike, userAgent: string, endpoint = 'https://overpass-api.de/api/interpreter'): Promise<MapData> {
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'user-agent': userAgent, 'content-type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(OVERPASS_QUERY)}`,
  });
  if (!res.ok) throw new Error(`OpenStreetMap (Overpass) returned HTTP ${res.status}`);
  const json = (await res.json()) as { elements?: OsmElement[] };
  return buildMapData(json.elements ?? []);
}

/** "McDonald's Singapore" -> "mcdonalds" (words only, for name matching). */
export function words(s: string): string {
  return normalize(s)
    .replace(/'/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(singapore|sg|pte|ltd)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildMapData(elements: OsmElement[]): MapData {
  const byBrand = new Map<string, Outlet[]>();
  const byName: MapData['byName'] = [];
  const hawkers: Outlet[] = [];

  for (const el of elements) {
    const t = el.tags ?? {};
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null || !t.name || !inSingapore(lat, lng)) continue;

    const outlet: Outlet = { name: displayName(t), lat, lng };
    const isHawker =
      (t.amenity === 'food_court' || t.amenity === 'marketplace') &&
      /hawker|food centre|food center|market/i.test(t.name);
    if (isHawker) hawkers.push(outlet);

    for (const b of [t.brand, t['brand:en']]) {
      if (!b) continue;
      const key = words(b);
      if (!key) continue;
      const list = byBrand.get(key);
      if (list) list.push(outlet);
      else byBrand.set(key, [outlet]);
    }
    byName.push({ words: words(t['name:en'] ?? t.name), outlet });
  }
  return { byBrand, byName, hawkers };
}

function displayName(t: Record<string, string>): string {
  const base = t['name:en'] ?? t.name;
  if (t.branch) return `${base} ${t.branch}`;
  const where = t['addr:housename'] ?? t['addr:place'] ?? t['addr:street'];
  return where && !base.toLowerCase().includes(where.toLowerCase()) ? `${base} (${where})` : base;
}

// Single words that are too generic to match shop names by themselves.
const GENERIC = new Set([
  'coffee', 'cafe', 'tea', 'bakery', 'restaurant', 'kitchen', 'bar', 'pizza', 'burger', 'sushi', 'chicken',
  'noodles', 'noodle', 'rice', 'dessert', 'desserts', 'bistro', 'grill', 'food', 'eatery', 'bubble tea', 'kopi',
]);

export function outletsForBrand(map: MapData, brand: string): Outlet[] {
  const key = words(brand);
  if (key.length < 3 || GENERIC.has(key)) return [];
  const found = [...(map.byBrand.get(key) ?? [])];
  for (const n of map.byName) {
    if (n.words === key || n.words.startsWith(`${key} `)) found.push(n.outlet);
  }
  // Remove duplicates (same place tagged twice).
  const seen = new Set<string>();
  return found.filter((o) => {
    const k = `${o.lat.toFixed(4)},${o.lng.toFixed(4)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// --- OneMap address lookup ------------------------------------------------------

export interface Geocoder {
  geocode(query: string): Promise<{ lat: number; lng: number } | null>;
  lookups(): number;
}

export function oneMapGeocoder(opts: { email?: string; password?: string; fetchImpl: FetchLike; db: Db; userAgent: string }): Geocoder {
  let token: string | null = null;
  let tokenTried = false;
  let count = 0;

  async function getToken() {
    if (tokenTried) return token;
    tokenTried = true;
    if (!opts.email || !opts.password) return null;
    const res = await opts.fetchImpl('https://www.onemap.gov.sg/api/auth/post/getToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': opts.userAgent },
      body: JSON.stringify({ email: opts.email, password: opts.password }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string };
    token = body.access_token ?? null;
    return token;
  }

  return {
    lookups: () => count,
    async geocode(query) {
      const q = query.trim().slice(0, 120);
      if (!q) return null;
      const cached = await opts.db.query<{ lat: number | null; lng: number | null }>('SELECT lat, lng FROM geocache WHERE query = ?', [q]);
      if (cached.length) return cached[0].lat == null ? null : { lat: cached[0].lat, lng: cached[0].lng! };

      const t = await getToken();
      const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
      const res = await opts.fetchImpl(url, { headers: { 'user-agent': opts.userAgent, ...(t ? { authorization: t } : {}) } });
      count++;
      await new Promise((r) => setTimeout(r, 250)); // gentle on the API
      const body = (await res.json().catch(() => ({}))) as { results?: { LATITUDE?: string; LONGITUDE?: string }[] };
      const first = body.results?.[0];
      const lat = Number(first?.LATITUDE);
      const lng = Number(first?.LONGITUDE);
      const point = first && inSingapore(lat, lng) ? { lat, lng } : null;
      await opts.db.query('INSERT OR REPLACE INTO geocache (query, lat, lng) VALUES (?, ?, ?)', [q, point?.lat ?? null, point?.lng ?? null]);
      return point;
    },
  };
}

// --- Putting it together ---------------------------------------------------------

export async function locateDeal(deal: CleanDeal, map: MapData, geocoder: Geocoder): Promise<Outlet[]> {
  const chain = outletsForBrand(map, deal.brand);

  if (deal.scope !== 'specific' && chain.length) return chain.slice(0, 400);

  const out: Outlet[] = [];
  for (const place of deal.locations.slice(0, 10)) {
    const point = await geocoder.geocode(place);
    if (!point) continue;
    // If the chain has an outlet right there, use its proper name.
    const near = chain
      .map((o) => ({ o, d: distanceM(point.lat, point.lng, o.lat, o.lng) }))
      .filter((x) => x.d <= 400)
      .sort((a, b) => a.d - b.d)[0];
    out.push(near ? near.o : { name: `${deal.brand} @ ${place}`, lat: point.lat, lng: point.lng });
  }
  if (out.length) return out;
  // Specific deal but its places could not be found: fall back to the chain if it has outlets.
  return deal.scope === 'specific' ? [] : chain;
}
