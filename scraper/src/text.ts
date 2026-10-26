// Small text helpers shared by the scraper.

import { createHash } from 'node:crypto';

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** Turn article HTML into readable plain text, keeping paragraph breaks. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|figure|figcaption|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|\/p|\/h[1-6]|\/li|\/tr|\/div)[^>]*>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Lowercase, straight quotes, single spaces: for "does X appear in the text" checks. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Brand key for matching across sources and map data: "McDonald's SG" -> "mcdonalds". */
export function brandKey(s: string): string {
  return normalize(s)
    .replace(/\b(singapore|sg|pte|ltd|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function hashId(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
}

export function sgtToday(at = new Date()): string {
  return new Date(at.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
}

/** Split long text into chunks of about `size` characters at paragraph breaks. */
export function chunkText(text: string, size = 9000): string[] {
  if (text.length <= size) return [text];
  const parts = text.split(/\n\n+/);
  const chunks: string[] = [];
  let cur = '';
  for (const p of parts) {
    if (cur && cur.length + p.length + 2 > size) {
      chunks.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > size) {
      chunks.push(cur.slice(0, size));
      cur = cur.slice(size);
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
