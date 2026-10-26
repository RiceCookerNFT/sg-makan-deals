// Turning search results into Telegram messages (HTML mode).

import { esc } from './telegram';
import { prettyDate } from './time';
import type { Place, RankedDeal } from './search';

const CONDITION_LABELS: Record<string, string> = {
  app_only: '📱 App only',
  card_only: '💳 Card only',
  members_only: '🎟 Members only',
  dine_in: '🍽 Dine-in only',
  takeaway: '🥡 Takeaway only',
  min_spend: '🧾 Min spend',
  limited_hours: '⏰ Limited hours',
  while_stocks_last: '📦 While stocks last',
  participating_only: '🏷 Participating outlets',
};

export type Occasion = 'now' | 'lunch' | 'dinner';

export interface LocationInfo {
  source: string | null;   // 'pin' | 'live'
  locAt: number | null;    // unix seconds
  liveUntil: number | null;
  nowSec: number;
}

export function formatResults(
  deals: RankedDeal[],
  hawkers: Place[],
  radiusM: number,
  occasion: Occasion,
  loc: LocationInfo,
): string {
  const title =
    occasion === 'lunch' ? '☀️ <b>Lunch deals near you</b>'
    : occasion === 'dinner' ? '🌙 <b>Dinner deals near you</b>'
    : '🍜 <b>Makan deals near you</b>';

  const lines: string[] = [title, `<i>Within ${radiusText(radiusM)} of ${locationText(loc)}</i>`, ''];

  if (deals.length === 0) {
    lines.push(`No deals within ${radiusText(radiusM)} right now 😢`);
    if (hawkers.length) {
      lines.push('', '<b>Nearest hawker centres:</b>');
      for (const h of hawkers) lines.push(`• ${esc(h.name)} · ${distText(h.distM)} (~${h.walkMin} min walk)`);
    } else {
      lines.push('Try a bigger area with /alerts → 2 km.');
    }
    return lines.join('\n');
  }

  deals.forEach((d, i) => {
    const price = d.priceText ? ` — ${esc(d.priceText)}` : '';
    lines.push(`${i + 1}. <b>${esc(d.brand)}</b>: ${esc(d.title)}${price}`);
    lines.push(`   📍 ${esc(d.outlet)} · ${distText(d.distM)} (~${d.walkMin} min walk)`);
    const confirmed = d.nSources > 1 ? ` · ✅ ${d.nSources} sources` : '';
    lines.push(`   ⏳ Ends ${prettyDate(d.endDate)} · <a href="${esc(d.sourceUrl)}">${esc(d.sourceName)}</a>${confirmed}`);
    const tags = d.conditions.map((c) => CONDITION_LABELS[c]).filter(Boolean);
    if (tags.length) lines.push(`   ${tags.join(' · ')}`);
    lines.push('');
  });
  lines.push('<i>Deals come from public sources. Tap the link to check details before you go.</i>');
  return lines.join('\n');
}

function locationText(loc: LocationInfo): string {
  if (loc.source === 'live') {
    if (loc.liveUntil && loc.liveUntil < loc.nowSec) {
      return `your last live location (${ago(loc.nowSec - (loc.locAt ?? loc.nowSec))})`;
    }
    return 'your live location';
  }
  return 'your pinned location';
}

function ago(sec: number): string {
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} d ago`;
}

function radiusText(m: number): string {
  return m >= 1000 ? `${m / 1000} km` : `${m} m`;
}

function distText(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}
