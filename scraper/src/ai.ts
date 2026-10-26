// Uses an AI model to turn messy article text into structured deals.
// The AI only READS text we already collected. It never searches the web, and
// everything it returns is checked against the original text in validate.ts.
//
// Runs on Cloudflare Workers AI (free daily allowance), once per new or changed
// article, never per user, so the cost does not grow with the number of users.

import type { Article, FetchLike, RawDeal } from './types';

export interface AiClient {
  extract(article: Article, chunk: string, today: string): Promise<RawDeal[]>;
  neuronsUsed(): number;
  budgetLeft(): boolean;
}

export interface CloudflareAiOptions {
  accountId: string;
  apiToken: string;
  model: string;
  budgetNeurons: number;        // stop for this run once the estimate passes this
  neuronsPerMInput: number;     // from Cloudflare's pricing page for the chosen model
  neuronsPerMOutput: number;
  fetchImpl: FetchLike;
}

export function cloudflareAi(o: CloudflareAiOptions): AiClient {
  let used = 0;
  return {
    neuronsUsed: () => Math.round(used),
    budgetLeft: () => used < o.budgetNeurons,
    async extract(article, chunk, today) {
      const prompt = buildPrompt(article, chunk, today);
      const url = `https://api.cloudflare.com/client/v4/accounts/${o.accountId}/ai/run/${o.model}`;
      const res = await o.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'You extract food and drink deals in Singapore from text. You reply with JSON only. You never invent details that are not in the text.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1500,
          temperature: 0,
        }),
      });
      const body = (await res.json()) as { success?: boolean; result?: { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } }; errors?: unknown };
      if (!res.ok || body.success === false) throw new Error(`AI call failed (HTTP ${res.status}): ${JSON.stringify(body.errors ?? body).slice(0, 200)}`);

      const raw = body.result?.response;
      const inTok = body.result?.usage?.prompt_tokens ?? prompt.length / 4;
      const outTok = body.result?.usage?.completion_tokens ?? (typeof raw === 'string' ? raw.length : JSON.stringify(raw ?? '').length) / 4;
      used += (inTok * o.neuronsPerMInput + outTok * o.neuronsPerMOutput) / 1e6;
      return parseDeals(raw);
    },
  };
}

export function buildPrompt(article: Article, chunk: string, today: string): string {
  const brandLine = article.brandHint ? `This is ${article.brandHint}'s own website, so every deal here is from ${article.brandHint}.\n` : '';
  return `Today is ${today} (Singapore). Source: ${article.sourceName}. Title: ${article.title}.${article.publishedAt ? ` Published: ${article.publishedAt}.` : ''}
${brandLine}
Find every FOOD or DRINK deal or promotion in the text below (restaurants, cafes, bubble tea, fast food, buffets, bakeries, hawker stalls, dessert).
Ignore: non-food deals (fashion, travel, electronics, supermarket groceries), normal menu prices that are not a promotion, and deals outside Singapore.

Reply with {"deals":[...]} where each deal is:
{
 "brand": the restaurant or chain name exactly as written,
 "title": what the offer is, max 12 words,
 "price_text": the deal price or discount as written (e.g. "S$6.90", "50% off", "1-for-1") or null,
 "deal_type": "1for1" | "percent" | "price" | "freebie" | "other",
 "scope": "all_outlets" (every outlet) | "participating" (only participating/selected outlets) | "specific" (only at named places),
 "locations": list of the named outlets, malls or addresses where it is valid (empty list if all outlets),
 "start_date": "YYYY-MM-DD" or null, "end_date": "YYYY-MM-DD" or null (only dates written in the text; use the year of today unless the text says otherwise),
 "conditions": any of ["app_only","card_only","members_only","dine_in","takeaway","min_spend","limited_hours","while_stocks_last"],
 "evidence": ONE sentence copied word for word from the text that states this deal
}
If there are no food deals, reply {"deals":[]}.

TEXT:
"""
${chunk}
"""`;
}

/** Pulls the deals array out of whatever the model returned. */
export function parseDeals(raw: unknown): RawDeal[] {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    try {
      obj = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  const deals = (obj as { deals?: unknown })?.deals;
  return Array.isArray(deals) ? (deals.filter((d) => d && typeof d === 'object') as RawDeal[]) : [];
}
