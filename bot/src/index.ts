// Entry point for the Cloudflare Worker.
//   POST /telegram  – Telegram sends every message/tap here (the "webhook")
//   GET  /setup     – one-time link that connects the bot to this Worker
//   GET  /stats     – quick numbers for you (users, deals, places)
//   cron (every minute) – alerts, scraper trigger, cleanup

import { runMinute } from './alerts';
import type { Env } from './env';
import { handleUpdate } from './handlers';
import { tg, type TgUpdate } from './telegram';
import { sgt } from './time';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/telegram') {
      if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      try {
        const update = (await request.json()) as TgUpdate;
        await handleUpdate(update, env);
      } catch (err) {
        // Always answer 200, otherwise Telegram keeps re-sending the same update.
        console.error('update failed', err);
      }
      return new Response('ok');
    }

    if (url.pathname === '/setup') {
      if (url.searchParams.get('key') !== env.ADMIN_KEY) return new Response('forbidden', { status: 403 });
      const webhook = await tg(env, 'setWebhook', {
        url: `${url.origin}/telegram`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'edited_message', 'callback_query'],
        drop_pending_updates: true,
      });
      const commands = await tg(env, 'setMyCommands', {
        commands: [
          { command: 'now', description: 'Deals near me right now' },
          { command: 'alerts', description: 'Lunch & dinner alerts' },
          { command: 'live', description: 'Share live location' },
          { command: 'forget', description: 'Delete my data' },
          { command: 'about', description: 'About this bot' },
        ],
      });
      return Response.json({ webhook, commands });
    }

    if (url.pathname === '/stats') {
      if (url.searchParams.get('key') !== env.ADMIN_KEY) return new Response('forbidden', { status: 403 });
      const today = sgt().date;
      const [users, deals, locations, places] = await env.DB.batch([
        env.DB.prepare('SELECT COUNT(*) AS n, SUM(active) AS active, SUM(loc_source = \'live\') AS live FROM users'),
        env.DB.prepare('SELECT COUNT(*) AS n FROM deals WHERE end_date >= ?').bind(today),
        env.DB.prepare('SELECT COUNT(*) AS n FROM deal_locations'),
        env.DB.prepare('SELECT COUNT(*) AS n FROM places'),
      ]);
      return Response.json({
        users: users.results?.[0],
        active_deals: deals.results?.[0],
        deal_locations: locations.results?.[0],
        hawker_places: places.results?.[0],
      });
    }

    return new Response('SG Makan Deals bot is running 🍜');
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const r = await runMinute(env, new Date(event.scheduledTime));
    if (r.sent || r.failed || r.blocked || r.scrapeTriggered || r.cleaned) console.log('minute', JSON.stringify(r));
  },
};
