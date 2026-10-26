# 🍜 SG Makan Deals Bot

A free Telegram bot that finds **food deals near you in Singapore** and sends them at lunch and dinner.
Share your location once (or your live location), and the bot does the rest.

**Runs for $0/month for ~1,000+ users.** Built with Playwright, Cloudflare Workers and Telegram.

---

## How it works

```
 Deal sites (RSS feeds)  ─┐
 Brand promo pages ───────┼─▶ Scraper (GitHub Actions, 2x a day)
   (Playwright browser)   │     1. collect articles
                          │     2. AI pulls out deals (Cloudflare Workers AI)
                          │     3. checks every deal against the original text
                          │     4. pins deals to outlets (OpenStreetMap, OneMap)
                          ▼
                    Database (Cloudflare D1)
                          ▲
 Telegram users ◀────▶ Bot (Cloudflare Worker)
   📍 share location      - /now: deals near you, instantly
   🔔 get alerts          - 11:30am & 6pm: alerts using your latest location
```

- **The bot never scrapes per user.** Scraping happens twice a day for everyone; each user's search is a quick database lookup at that moment. That's why it stays free.
- **AI reads, it doesn't search.** It only turns articles into structured deals. Every deal must quote a sentence that really exists in the article, or it is thrown away. Made-up prices and dates are removed.
- **Live location:** if a user shares live location, alerts follow them around. Only their latest spot is stored, never a history. `/forget` deletes everything.

## What it costs: $0

| Service | Free limit | At 1,000 users |
|---|---|---|
| Telegram Bot API | free | — |
| Cloudflare Workers (the bot) | 100,000 requests/day | ~8,000/day |
| Cloudflare D1 (database) | 5M rows read, 100k written/day | small (searches read ~20 rows) |
| Cloudflare Workers AI | 10,000 neurons/day | ~2,000–9,000 (capped by the code) |
| GitHub Actions (scraper) | unlimited for public repos | 2–4 runs/day |
| OpenStreetMap, OneMap | free | — |

**First limit you'll hit:** alerts. The free plan allows about 50 outside calls per run, so the bot sends 25 alerts per minute, which is **~1,500 people per 60-minute alert window**. Past that, either widen the window (`ALERT_WINDOW_MIN`) or move to Cloudflare's $5/month plan and raise `ALERT_BATCH`.

---

## Setup (about 30 minutes, all in your web browser)

You don't need to install anything on your computer.

### 1. Create the Telegram bot

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Pick a name (e.g. "SG Makan Deals") and a username ending in `bot`.
3. BotFather gives you a **token** like `123456:ABC-...`. Keep it secret.

### 2. Set up Cloudflare (free account)

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com).
2. Open **Workers & Pages** once. It asks you to pick a free `workers.dev` subdomain. Pick anything.
3. Copy your **Account ID** (on the Workers & Pages overview page, right side).
4. Create an API token: **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template**, then add two more permissions:
   - Account → **D1** → Edit
   - Account → **Workers AI** → Read
   - Account → **Workers AI** → Edit

   Create it and copy the token.

### 3. Put the code on GitHub

1. Create a **public** repository named `sg-makan-deals` (public = unlimited free GitHub Actions; your secrets stay private).
2. Upload this project to it. (Or ask Claude to push it for you.)
3. In the repo: **Settings → Secrets and variables → Actions → New repository secret**. Add:

| Secret | What to put |
|---|---|
| `BOT_TOKEN` | the token from BotFather |
| `CF_ACCOUNT_ID` | your Cloudflare Account ID |
| `CF_API_TOKEN` | the Cloudflare API token |
| `WEBHOOK_SECRET` | any random string of letters, numbers, `-` or `_` (30+ characters) |
| `ADMIN_KEY` | another random string (protects your admin links) |
| `ONEMAP_EMAIL` / `ONEMAP_PASSWORD` | *optional:* register for a free API account at onemap.gov.sg. Used to pin deals at specific addresses (chain-wide deals work without it). |
| `ADMIN_CHAT_ID` | *optional, add later:* your chat id (send `/myid` to your bot). You'll get a scrape report after each run. |
| `GH_DISPATCH_TOKEN` | *optional:* lets the bot start the scraper at exact times (see below) |

### 4. Deploy

Go to **Actions → Deploy bot → Run workflow**. In about 2 minutes it:
creates the database, sets up tables, runs the tests, uploads the bot, stores its secrets, and connects it to Telegram.

Open your bot in Telegram and send `/start`. 🎉

### 5. Get the first deals

Go to **Actions → Scrape deals → Run workflow**. The run page shows a report like:

```
🧾 Scrape 2026-10-21: 23 deals live (23 new, 0 updated)
AI deals: 31 found, 26 passed checks, 23 after merging duplicates
Rejected: 3 evidence not found in the article, 2 already expired
```

After that it runs by itself twice a day.

### 6. (Optional) Exact scrape times

GitHub's own timer can run late. For exact 10:00/16:00 runs, let the bot start the scraper:
GitHub → **Settings (your profile) → Developer settings → Fine-grained tokens → Generate**, choose *Only this repository*, permission **Actions: Read and write**. Save it as the `GH_DISPATCH_TOKEN` secret and run **Deploy bot** again.

---

## Day to day

| Time (SGT) | What happens |
|---|---|
| 03:00 | expired deals are deleted |
| 10:00, 16:00 | scraper collects fresh deals |
| 11:30–12:30 | lunch alerts go out (25/min) |
| 18:00–19:00 | dinner alerts go out |
| anytime | users tap 🍜 or `/now` |

- **Health check:** if a source returns nothing, the report flags it (⚠️). If nothing comes in at all, the GitHub run fails and GitHub emails you.
- **Numbers:** `https://<your-worker>.workers.dev/stats?key=<ADMIN_KEY>` shows users, live deals and places.
- **Cloudflare dashboard → Workers → sg-makan-deals → Metrics** shows requests and CPU use against the free limits.

## Adding more deal sources

Edit `scraper/sources.json`:

- **RSS feed** (best: fast and polite). Many sites have one at `/feed/`. Add to `"rss"`.
- **Web page** (brand promo pages). Add to `"pages"` with `"brand"` set. Playwright opens it in a real browser, waits for JavaScript, scrolls to load everything, and reads the main content.

To test a page first (needs Node.js on your computer):

```bash
cd scraper && npm install && npx playwright install chromium
npm run try-page -- https://some-brand.sg/promotions --brand "Some Brand"
```

**Be a good citizen:** keep runs to a couple a day, don't log in or get around captchas, link back to the source (the bot always does), and drop any site that asks you not to scrape it.

## Settings you can change

In `bot/wrangler.toml` under `[vars]`: lunch/dinner start times, the alert window length, alerts per minute, scrape times.
In the scrape workflow env: `AI_MODEL`, `AI_BUDGET_NEURONS` (per run, default 4,500).

## Project layout

```
bot/            Telegram bot (Cloudflare Worker, TypeScript)
  src/handlers.ts   messages, location & live location, buttons
  src/alerts.ts     every-minute timer: alerts, scraper start, cleanup
  src/search.ts     nearby search + ranking
  schema.sql        database tables
  test/             end-to-end tests incl. a 1,000-user alert run
scraper/        Deal collector (Node + Playwright, runs on GitHub Actions)
  src/sources/      RSS feeds and Playwright page reader
  src/ai.ts         AI extraction (Cloudflare Workers AI)
  src/validate.ts   the anti-hallucination checks
  src/locate.ts     OpenStreetMap outlets, OneMap addresses
  test/             unit tests, real-browser test, full end-to-end run
shared/geo.ts   map grid + distance maths used by both
```

## Running the tests

```bash
cd bot && npm install && npm test          # 13 tests, incl. 1,000 simulated users
cd ../scraper && npm install && npx playwright install chromium && npm test   # 19 tests
```

## Ideas for next versions

- Search by MRT station or postal code (OneMap)
- 👍/👎 "still valid?" buttons on each deal
- Public channel with the day's best deals
- Filters: halal-certified only, no card deals, under $10

## Credits

Map data © OpenStreetMap contributors (ODbL). Address search: OneMap, Singapore Land Authority.
Deals link back to their original source. Always check the source before you go.
