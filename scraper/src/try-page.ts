// Try a page before adding it as a source:
//   npm run try-page -- https://example.com/promotions --brand "Example Cafe"
// Opens it in Playwright, shows the text it sees, and (if your Cloudflare keys
// are set) the deals the AI finds and which ones pass the checks.

import { cloudflareAi } from './ai';
import { renderPages } from './sources/pages';
import { chunkText, sgtToday } from './text';
import { validateDeal } from './validate';

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('http'));
const brandIdx = args.indexOf('--brand');
const brand = brandIdx >= 0 ? args[brandIdx + 1] : undefined;
if (!url) {
  console.log('Usage: npm run try-page -- <url> [--brand "Brand name"]');
  process.exit(1);
}

const userAgent = 'SGMakanDealsBot/1.0 (source test)';
const { articles, errors } = await renderPages([{ name: brand ?? new URL(url).hostname, url, brand }], [], { userAgent, pauseMs: 0, log: console.log });
if (!articles.length) {
  console.log('Could not read the page:', errors.join('; '));
  process.exit(1);
}
const article = articles[0];
console.log(`\n--- Page text (${article.text.length} characters, first 1500) ---\n${article.text.slice(0, 1500)}\n`);

if (!process.env.CF_ACCOUNT_ID || !process.env.CF_API_TOKEN) {
  console.log('Set CF_ACCOUNT_ID and CF_API_TOKEN to also see what the AI extracts.');
  process.exit(0);
}
const ai = cloudflareAi({
  accountId: process.env.CF_ACCOUNT_ID, apiToken: process.env.CF_API_TOKEN, fetchImpl: fetch,
  model: process.env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct', budgetNeurons: 3000,
  neuronsPerMInput: 25608, neuronsPerMOutput: 75147,
});
const today = sgtToday();
for (const chunk of chunkText(article.text)) {
  for (const raw of await ai.extract(article, chunk, today)) {
    const v = validateDeal(raw, article, today);
    console.log(v.deal ? `✅ ${v.deal.brand}: ${v.deal.title} (${v.deal.priceText ?? 'no price'}, ends ${v.deal.endDate}${v.deal.endDateGuessed ? ' guessed' : ''})` : `❌ ${raw.brand}: ${raw.title} -> ${v.reason}`);
  }
}
console.log(`\nAI usage: ~${ai.neuronsUsed()} neurons`);
