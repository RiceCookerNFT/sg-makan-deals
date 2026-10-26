export interface Env {
  DB: D1Database;

  // Secrets (set with `npx wrangler secret put NAME`)
  BOT_TOKEN: string;        // from @BotFather
  WEBHOOK_SECRET: string;   // any random string; proves updates really come from Telegram
  ADMIN_KEY: string;        // any random string; protects the one-time /setup link
  GH_TOKEN?: string;        // optional: lets the bot start the scraper on GitHub at exact times

  // Plain settings (in wrangler.toml [vars])
  GH_REPO?: string;         // "your-username/sg-makan-deals"
  ADMIN_CHAT_ID?: string;   // your own Telegram chat id, for admin messages
  ALERT_BATCH?: string;     // alerts sent per minute (default 25)
  LUNCH_START?: string;     // default "11:30"
  DINNER_START?: string;    // default "18:00"
  ALERT_WINDOW_MIN?: string;// how long each alert window lasts (default 60)
  SCRAPE_TIMES?: string;    // Singapore times to start the scraper, default "10:00,16:00"
  TELEGRAM_API?: string;    // only overridden in tests
}
