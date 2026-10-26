// A tiny Telegram Bot API client. We call the HTTP API directly instead of
// using a big framework: the free Cloudflare plan allows only 10 ms of CPU per
// request, so less code running = more headroom.

import type { Env } from './env';

export interface TgResult<T = unknown> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

export async function tg<T = unknown>(
  env: Env,
  method: string,
  params: Record<string, unknown>,
): Promise<TgResult<T>> {
  const base = env.TELEGRAM_API || 'https://api.telegram.org';
  try {
    const res = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    return (await res.json()) as TgResult<T>;
  } catch (err) {
    return { ok: false, description: String(err) };
  }
}

export function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return tg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

/** Escape text for Telegram's HTML mode. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Minimal shapes of the Telegram objects we use ---------------------------

export interface TgLocation {
  latitude: number;
  longitude: number;
  live_period?: number;
}

export interface TgMessage {
  message_id: number;
  date: number;
  edit_date?: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name?: string };
  text?: string;
  location?: TgLocation;
}

export interface TgCallback {
  id: string;
  from: { id: number };
  data?: string;
  message?: TgMessage;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallback;
}
