// Singapore time helpers. Singapore is UTC+8 all year (no daylight saving),
// while Cloudflare's timers run in UTC, so everything goes through here.

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface SgtClock {
  date: string;      // 'YYYY-MM-DD' in Singapore
  minutes: number;   // minutes since midnight in Singapore (0..1439)
  hhmm: string;      // '11:30'
}

export function sgt(at: Date = new Date()): SgtClock {
  const shifted = new Date(at.getTime() + SGT_OFFSET_MS);
  const date = shifted.toISOString().slice(0, 10);
  const h = shifted.getUTCHours();
  const m = shifted.getUTCMinutes();
  return { date, minutes: h * 60 + m, hhmm: `${pad(h)}:${pad(m)}` };
}

export function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

export function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 'Fri 24 Oct' for a 'YYYY-MM-DD' date. */
export function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

/** Whole days from `fromIso` to `toIso` (both 'YYYY-MM-DD'). */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}
