-- Database tables for the bot (Cloudflare D1, which is SQLite).
-- Safe to run more than once.

-- One row per person using the bot. Only their LATEST location is kept
-- (no history), and /forget deletes the whole row.
CREATE TABLE IF NOT EXISTS users (
  chat_id     INTEGER PRIMARY KEY,
  first_name  TEXT,
  lat         REAL,
  lng         REAL,
  loc_source  TEXT,              -- 'pin' or 'live'
  loc_at      INTEGER,           -- unix seconds of the last location update
  live_until  INTEGER,           -- when their live location sharing ends (unix seconds)
  radius_m    INTEGER NOT NULL DEFAULT 1000,
  lunch       INTEGER NOT NULL DEFAULT 1,  -- 1 = lunch alert on
  dinner      INTEGER NOT NULL DEFAULT 1,  -- 1 = dinner alert on
  last_lunch  TEXT,              -- 'YYYY-MM-DD' of the last lunch alert sent
  last_dinner TEXT,
  active      INTEGER NOT NULL DEFAULT 1,  -- 0 if they blocked the bot
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_lunch  ON users (active, lunch, last_lunch);
CREATE INDEX IF NOT EXISTS users_dinner ON users (active, dinner, last_dinner);

-- One row per deal, written by the scraper.
CREATE TABLE IF NOT EXISTS deals (
  id          TEXT PRIMARY KEY,  -- stable hash of brand + title
  brand       TEXT NOT NULL,
  title       TEXT NOT NULL,
  price_text  TEXT,
  deal_type   TEXT,              -- '1for1', 'percent', 'price', 'freebie', 'other'
  conditions  TEXT,              -- JSON array, e.g. ["app_only","card_only"]
  start_date  TEXT,              -- 'YYYY-MM-DD' or NULL
  end_date    TEXT,              -- 'YYYY-MM-DD' (always set, the scraper adds a default)
  source_url  TEXT NOT NULL,
  source_name TEXT NOT NULL,
  n_sources   INTEGER NOT NULL DEFAULT 1,
  score_base  REAL NOT NULL DEFAULT 0,
  loc_hash    TEXT,              -- lets the scraper skip rewriting unchanged locations
  last_seen   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deals_end ON deals (end_date);

-- Where each deal can be redeemed. Chain-wide deals get one row per outlet.
CREATE TABLE IF NOT EXISTS deal_locations (
  deal_id  TEXT NOT NULL,
  name     TEXT NOT NULL,
  lat      REAL NOT NULL,
  lng      REAL NOT NULL,
  cell     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deal_locations_cell ON deal_locations (cell);
CREATE INDEX IF NOT EXISTS deal_locations_deal ON deal_locations (deal_id);

-- Fallback places (hawker centres / food courts), from OpenStreetMap.
CREATE TABLE IF NOT EXISTS places (
  kind  TEXT NOT NULL,           -- 'hawker'
  name  TEXT NOT NULL,
  lat   REAL NOT NULL,
  lng   REAL NOT NULL,
  cell  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS places_cell ON places (kind, cell);

-- Scraper memory: articles already read by the AI, so unchanged articles are
-- never sent to the AI twice (saves the free AI allowance).
CREATE TABLE IF NOT EXISTS articles (
  url          TEXT PRIMARY KEY,
  hash         TEXT NOT NULL,
  deals_json   TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

-- Scraper memory: addresses already looked up on OneMap.
CREATE TABLE IF NOT EXISTS geocache (
  query TEXT PRIMARY KEY,
  lat   REAL,
  lng   REAL
);
