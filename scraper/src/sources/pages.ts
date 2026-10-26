// Renders web pages with Playwright (a real Chromium browser). Used for:
//   - brands' own promotion pages, which are usually built with JavaScript
//     (a plain download gets an empty page; a real browser sees the deals)
//   - feed items that only include a short summary
//
// Polite by design: one page at a time, a pause between pages, an honest
// user agent, and no logging in, captcha solving or bot-detection bypassing.

import type { Article } from '../types';

export interface PageSource {
  name: string;
  url: string;
  enabled?: boolean;
  brand?: string;          // set for a brand's own page (marks deals as official)
  waitFor?: string;        // optional CSS selector to wait for before reading
}

export interface RenderOptions {
  userAgent: string;
  pauseMs?: number;
  log?: (msg: string) => void;
}

export async function renderPages(sources: PageSource[], articlesToFill: Article[], opts: RenderOptions): Promise<{ articles: Article[]; errors: string[] }> {
  const out: Article[] = [];
  const errors: string[] = [];
  if (sources.length === 0 && articlesToFill.length === 0) return { articles: out, errors };

  const { chromium } = await import('playwright');
  // Normally Playwright's own browser. PLAYWRIGHT_CHROMIUM_PATH lets you point at another Chromium.
  const custom = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch({
    headless: true,
    ...(custom ? { executablePath: custom, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] } : {}),
  });
  const context = await browser.newContext({ userAgent: opts.userAgent, locale: 'en-SG', timezoneId: 'Asia/Singapore' });
  try {
    const jobs: { url: string; make: (text: string) => Article; waitFor?: string; label: string }[] = [
      ...sources.map((s) => ({
        url: s.url,
        label: s.name,
        waitFor: s.waitFor,
        make: (text: string): Article => ({
          url: s.url, title: s.name, sourceName: s.name, official: Boolean(s.brand), brandHint: s.brand, text,
        }),
      })),
      ...articlesToFill.map((a) => ({ url: a.url, label: a.title, make: (text: string): Article => ({ ...a, text }) })),
    ];

    for (const job of jobs) {
      const page = await context.newPage();
      try {
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        if (job.waitFor) await page.waitForSelector(job.waitFor, { timeout: 15_000 });
        await autoScroll(page);
        const text = await page.evaluate(() => {
          const root = document.querySelector('main, article, [role="main"]') ?? document.body;
          return (root as HTMLElement).innerText;
        });
        if (text.trim().length < 80) throw new Error('page had almost no text (still loading, or blocked?)');
        out.push(job.make(text.replace(/\n{3,}/g, '\n\n').trim()));
        opts.log?.(`rendered ${job.label} (${text.length} chars)`);
      } catch (err) {
        errors.push(`${job.label}: ${(err as Error).message.split('\n')[0]}`);
      } finally {
        await page.close();
      }
      await new Promise((r) => setTimeout(r, opts.pauseMs ?? 3000));
    }
  } finally {
    await browser.close();
  }
  return { articles: out, errors };
}

/** Scrolls down in steps so lazy-loaded promo cards appear. */
async function autoScroll(page: import('playwright').Page) {
  await page.evaluate(async () => {
    for (let i = 0; i < 12; i++) {
      window.scrollBy(0, window.innerHeight);
      await new Promise((r) => setTimeout(r, 250));
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight) break;
    }
    window.scrollTo(0, 0);
  });
}
