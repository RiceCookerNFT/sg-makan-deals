// Command line entry: `npm run scrape` (GitHub Actions runs this).
//   --dry-run   find and check deals, print them, write nothing to the database

import { appendFileSync, readFileSync } from 'node:fs';
import { cloudflareAi } from './ai';
import { d1Rest } from './d1';
import { oneMapGeocoder } from './locate';
import { formatReport, runPipeline, type SourcesConfig } from './pipeline';
import { renderPages } from './sources/pages';
import { sgtToday } from './text';
import type { Db } from './types';

const env = process.env;
const dryRun = process.argv.includes('--dry-run');

function need(name: string): string {
  const v = env[name];
  if (!v) {
    console.error(`Missing setting ${name}. See README → "Set up the scraper".`);
    process.exit(1);
  }
  return v;
}

const accountId = need('CF_ACCOUNT_ID');
const apiToken = need('CF_API_TOKEN');
const userAgent = `SGMakanDealsBot/1.0 (+${env.PROJECT_URL || 'https://github.com'})`;

/** In dry-run mode: reads return nothing, writes are printed instead. */
const dryDb: Db = {
  async query(sql, params = []) {
    if (/^\s*INSERT INTO deals /i.test(sql)) {
      console.log(`DEAL  ${params[1]}: ${params[2]} | ${params[3] ?? 'no price'} | ends ${params[7]} | ${params[9]}`);
    }
    return [];
  },
};

/** Finds the bot's database by name, so you never have to copy its id around. */
async function findDatabaseId(): Promise<string> {
  if (env.D1_DATABASE_ID) return env.D1_DATABASE_ID;
  const name = env.D1_DATABASE_NAME || 'makan-deals';
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  const body = (await res.json().catch(() => ({}))) as { result?: { name: string; uuid: string }[] };
  const found = body.result?.find((d) => d.name === name);
  if (!found) {
    console.error(`Could not find the database "${name}". Run the "Deploy bot" workflow first (it creates it), and check the API token has D1 permission.`);
    process.exit(1);
  }
  return found.uuid;
}

const db: Db = dryRun ? dryDb : d1Rest({ accountId, apiToken, databaseId: await findDatabaseId(), fetchImpl: fetch });
const config = JSON.parse(readFileSync(new URL('../sources.json', import.meta.url), 'utf8')) as SourcesConfig;

const ai = cloudflareAi({
  accountId,
  apiToken,
  fetchImpl: fetch,
  model: env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct',
  budgetNeurons: Number(env.AI_BUDGET_NEURONS || 4500),   // per run; 2 runs/day stays under the free 10,000
  neuronsPerMInput: Number(env.AI_NEURONS_PER_M_IN || 25608),
  neuronsPerMOutput: Number(env.AI_NEURONS_PER_M_OUT || 75147),
});

const report = await runPipeline({
  db,
  fetchImpl: fetch,
  ai,
  geocoder: oneMapGeocoder({ email: env.ONEMAP_EMAIL, password: env.ONEMAP_PASSWORD, fetchImpl: fetch, db, userAgent }),
  config,
  today: sgtToday(),
  userAgent,
  renderPages: (pages, toFill) => renderPages(pages, toFill, { userAgent, log: console.log }),
  log: console.log,
});

const text = formatReport(report);
console.log(`\n${text}`);

if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `\`\`\`\n${text}\n\`\`\`\n`);

// Send the summary to you on Telegram if configured.
if (env.TELEGRAM_BOT_TOKEN && env.ADMIN_CHAT_ID && !dryRun) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.ADMIN_CHAT_ID, text, disable_notification: true }),
  }).catch(() => {});
}

// Fail the GitHub run (you get an email) if nothing at all came in.
const totalLive = report.saved.new + report.saved.updated + report.saved.unchanged;
if (report.articles === 0 || (totalLive === 0 && report.errors.length > 0)) process.exit(1);
