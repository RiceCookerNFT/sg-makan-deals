// Shared by the bot and the scraper, so both agree on how the map is split up.
//
// Singapore is cut into a grid of ~1 km squares ("cells"). Every deal location
// is stored with its cell key, so a search only reads the few cells around the
// user instead of the whole table. This is what keeps database reads tiny.

export const CELL_DEG = 0.009; // ~1 km at Singapore's latitude

// Rough bounding box of Singapore, used to reject locations from elsewhere.
export const SG_BOUNDS = { minLat: 1.15, maxLat: 1.48, minLng: 103.59, maxLng: 104.1 };

export function inSingapore(lat: number, lng: number): boolean {
  return (
    lat >= SG_BOUNDS.minLat && lat <= SG_BOUNDS.maxLat &&
    lng >= SG_BOUNDS.minLng && lng <= SG_BOUNDS.maxLng
  );
}

export function cellOf(lat: number, lng: number): string {
  return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;
}

/** Cell keys covering a circle of `radiusM` metres around the point. */
export function cellsAround(lat: number, lng: number, radiusM: number): string[] {
  const ring = Math.max(1, Math.ceil(radiusM / 1000));
  const cy = Math.floor(lat / CELL_DEG);
  const cx = Math.floor(lng / CELL_DEG);
  const out: string[] = [];
  for (let dy = -ring; dy <= ring; dy++) {
    for (let dx = -ring; dx <= ring; dx++) out.push(`${cy + dy}:${cx + dx}`);
  }
  return out;
}

/** Straight-line distance in metres. */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Walking minutes, assuming ~80 m/min and a 1.3x detour factor for real streets. */
export function walkMinutes(distM: number): number {
  return Math.max(1, Math.ceil((distM * 1.3) / 80));
}
