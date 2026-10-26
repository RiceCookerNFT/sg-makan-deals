// Checks the Playwright part on a local page that, like many brand sites,
// only shows its deals after JavaScript runs and loads more as you scroll.
// A plain download of this page would see no deals at all.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderPages } from '../src/sources/pages';

const PAGE = `<!doctype html><html><body>
<header>Menu · Locations · Careers</header>
<main id="app">Loading promotions…</main>
<script>
  setTimeout(() => {
    document.getElementById('app').innerHTML =
      '<h1>Current promotions</h1>' +
      '<div class="card"><h2>1-for-1 Iced Lattes</h2><p>Valid at all outlets till 30 November. App orders only.</p></div>' +
      '<div style="height:3000px"></div><div id="more"></div>';
    window.addEventListener('scroll', () => {
      const more = document.getElementById('more');
      if (!more.textContent) more.innerHTML = '<div class="card"><h2>$3 Croissant Fridays</h2><p>Every Friday in November.</p></div>';
    });
  }, 400);
</script></body></html>`;

let server: Server;
let url = '';
let browserOk = true;

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/promotions`;
  try {
    const { chromium } = await import('playwright');
    const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    const b = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe, args: ['--no-sandbox'] } : {}) });
    await b.close();
  } catch {
    browserOk = false;
  }
});
after(() => server.close());

test('Playwright reads deals that only appear after JavaScript and scrolling', async (t) => {
  if (!browserOk) return t.skip('no browser installed (run: npx playwright install chromium)');
  const { articles, errors } = await renderPages([{ name: 'Test Cafe', url, brand: 'Test Cafe' }], [], { userAgent: 'test', pauseMs: 0 });
  assert.deepEqual(errors, []);
  const text = articles[0].text;
  assert.match(text, /1-for-1 Iced Lattes/);
  assert.match(text, /\$3 Croissant Fridays/);    // only loads after scrolling
  assert.doesNotMatch(text, /Careers/);           // reads <main>, not the site menu
  assert.equal(articles[0].official, true);
});

test('a broken page is reported, not fatal', async (t) => {
  if (!browserOk) return t.skip('no browser installed');
  const { articles, errors } = await renderPages([{ name: 'Dead page', url: 'http://127.0.0.1:1/nothing' }], [], { userAgent: 'test', pauseMs: 0 });
  assert.equal(articles.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Dead page:/);
});
