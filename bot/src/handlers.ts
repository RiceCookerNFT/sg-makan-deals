// What the bot does with each message or button tap from Telegram.

import { inSingapore } from '../../shared/geo';
import type { Env } from './env';
import { formatResults } from './format';
import { fetchArea, nearbyHawkers, rankForUser } from './search';
import { esc, sendMessage, tg, type TgCallback, type TgMessage, type TgUpdate } from './telegram';
import { parseHHMM, sgt } from './time';

export interface UserRow {
  chat_id: number;
  first_name: string | null;
  lat: number | null;
  lng: number | null;
  loc_source: string | null;
  loc_at: number | null;
  live_until: number | null;
  radius_m: number;
  lunch: number;
  dinner: number;
}

const LIVE_FOREVER = 0x7fffffff; // Telegram's value for "until I turn it off"
const LIVE_UPDATE_MIN_GAP_S = 60; // ignore live updates that arrive faster than this

export const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '📍 Share my location', request_location: true }],
    [{ text: '🍜 Deals near me' }, { text: '🔔 Alerts' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

export async function handleUpdate(update: TgUpdate, env: Env): Promise<void> {
  if (update.message) await onMessage(update.message, env);
  else if (update.edited_message) await onEdited(update.edited_message, env);
  else if (update.callback_query) await onCallback(update.callback_query, env);
}

// --- Messages ---------------------------------------------------------------

async function onMessage(msg: TgMessage, env: Env) {
  if (msg.chat.type !== 'private') return; // groups not supported yet
  const chatId = msg.chat.id;

  if (msg.location) return onLocation(msg, env);

  const text = (msg.text ?? '').trim();
  const cmd = text.split(/[\s@]/)[0].toLowerCase();

  if (cmd === '/start') return sendWelcome(env, chatId, msg.from?.first_name);
  if (cmd === '/now' || text === '🍜 Deals near me') return sendDealsNow(env, chatId);
  if (cmd === '/alerts' || text === '🔔 Alerts') return sendAlertSettings(env, chatId);
  if (cmd === '/live') return sendMessage(env, chatId, liveHowTo());
  if (cmd === '/forget') return askForget(env, chatId);
  if (cmd === '/about' || cmd === '/help') return sendMessage(env, chatId, aboutText(env));
  if (cmd === '/myid') return sendMessage(env, chatId, `Your chat id is <code>${chatId}</code>`);

  return sendMessage(
    env,
    chatId,
    'Send me your location (tap 📍 below) and I’ll find makan deals around you. Or tap 🍜 to see deals near your last location.',
    { reply_markup: MAIN_KEYBOARD },
  );
}

async function sendWelcome(env: Env, chatId: number, name?: string) {
  const hi = name ? `Hi ${esc(name)}! ` : 'Hi! ';
  await sendMessage(
    env,
    chatId,
    `${hi}👋 I find <b>food deals near you</b> in Singapore: 1-for-1s, promos, cheap eats.\n\n` +
      `<b>1.</b> Tap <b>📍 Share my location</b> below.\n` +
      `<b>2.</b> That’s it. I’ll send you deals at lunch (${t12(env.LUNCH_START || '11:30')}) and dinner (${t12(env.DINNER_START || '18:00')}).\n\n` +
      `Want alerts to follow you around? Use /live to share your live location instead.\n` +
      `Your data: I only keep your latest location. /forget deletes everything.`,
    { reply_markup: MAIN_KEYBOARD },
  );
}

async function onLocation(msg: TgMessage, env: Env) {
  const chatId = msg.chat.id;
  const loc = msg.location!;
  if (!inSingapore(loc.latitude, loc.longitude)) {
    return sendMessage(env, chatId, 'That location looks like it’s outside Singapore 🇸🇬. I only cover Singapore for now.');
  }

  const isLive = typeof loc.live_period === 'number' && loc.live_period > 0;
  const now = msg.date;
  const liveUntil = isLive
    ? loc.live_period === LIVE_FOREVER ? LIVE_FOREVER : now + loc.live_period!
    : null;

  const existing = await env.DB.prepare('SELECT chat_id FROM users WHERE chat_id = ?').bind(chatId).first();

  await env.DB.prepare(
    `INSERT INTO users (chat_id, first_name, lat, lng, loc_source, loc_at, live_until, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       first_name = excluded.first_name, lat = excluded.lat, lng = excluded.lng,
       loc_source = excluded.loc_source, loc_at = excluded.loc_at,
       live_until = excluded.live_until, active = 1`,
  )
    .bind(chatId, msg.from?.first_name ?? null, loc.latitude, loc.longitude, isLive ? 'live' : 'pin', now, liveUntil, now)
    .run();

  const note = isLive
    ? '✅ <b>Live location on.</b> Your alerts will follow you until you stop sharing.'
    : existing
      ? '✅ Location updated.'
      : `✅ Saved! You’ll get deals at ${t12(env.LUNCH_START || '11:30')} and ${t12(env.DINNER_START || '18:00')}. Change this anytime with /alerts.`;
  await sendMessage(env, chatId, note, { reply_markup: MAIN_KEYBOARD });
  await sendDealsNow(env, chatId);
}

/** Live location updates arrive as edits of the original location message. */
async function onEdited(msg: TgMessage, env: Env) {
  const loc = msg.location;
  if (!loc || msg.chat.type !== 'private') return;
  if (!inSingapore(loc.latitude, loc.longitude)) return;
  const at = msg.edit_date ?? Math.floor(Date.now() / 1000);
  // One cheap write, and only if the last update is over a minute old.
  await env.DB.prepare(
    `UPDATE users SET lat = ?, lng = ?, loc_at = ?
     WHERE chat_id = ? AND loc_source = 'live' AND (loc_at IS NULL OR loc_at <= ?)`,
  )
    .bind(loc.latitude, loc.longitude, at, msg.chat.id, at - LIVE_UPDATE_MIN_GAP_S)
    .run();
}

export async function getUser(env: Env, chatId: number): Promise<UserRow | null> {
  return env.DB.prepare(
    'SELECT chat_id, first_name, lat, lng, loc_source, loc_at, live_until, radius_m, lunch, dinner FROM users WHERE chat_id = ?',
  )
    .bind(chatId)
    .first<UserRow>();
}

async function sendDealsNow(env: Env, chatId: number) {
  const user = await getUser(env, chatId);
  if (!user || user.lat == null || user.lng == null) {
    return sendMessage(env, chatId, 'I don’t know where you are yet. Tap <b>📍 Share my location</b> below 👇', {
      reply_markup: MAIN_KEYBOARD,
    });
  }
  const { date } = sgt();
  const rows = await fetchArea(env.DB, user.lat, user.lng, user.radius_m, date);
  const deals = rankForUser(rows, user.lat, user.lng, user.radius_m, date);
  const hawkers = deals.length ? [] : await nearbyHawkers(env.DB, user.lat, user.lng);
  const text = formatResults(deals, hawkers, user.radius_m, 'now', {
    source: user.loc_source,
    locAt: user.loc_at,
    liveUntil: user.live_until,
    nowSec: Math.floor(Date.now() / 1000),
  });
  return sendMessage(env, chatId, text);
}

// --- Alert settings -----------------------------------------------------------

async function sendAlertSettings(env: Env, chatId: number) {
  const user = await getUser(env, chatId);
  if (!user) {
    return sendMessage(env, chatId, 'Share your location first (tap 📍 below), then you can set alerts.', {
      reply_markup: MAIN_KEYBOARD,
    });
  }
  return sendMessage(env, chatId, alertSettingsText(env), { reply_markup: alertKeyboard(user) });
}

function alertSettingsText(env: Env) {
  return (
    `🔔 <b>Your alerts</b> (Singapore time)\n` +
    `Each alert uses your latest location. Tap to switch on/off or change the search area.`
  );
}

function alertKeyboard(u: Pick<UserRow, 'lunch' | 'dinner' | 'radius_m'>) {
  const on = (v: number) => (v ? '✅' : '❌');
  const r = (m: number, label: string) => ({ text: (u.radius_m === m ? '• ' : '') + label, callback_data: `rad:${m}` });
  return {
    inline_keyboard: [
      [{ text: `☀️ Lunch ${on(u.lunch)}`, callback_data: 'tog:lunch' }, { text: `🌙 Dinner ${on(u.dinner)}`, callback_data: 'tog:dinner' }],
      [r(500, '500 m'), r(1000, '1 km'), r(2000, '2 km')],
    ],
  };
}

// --- Button taps ----------------------------------------------------------------

async function onCallback(cb: TgCallback, env: Env) {
  const chatId = cb.from.id;
  const data = cb.data ?? '';
  const msgId = cb.message?.message_id;

  if (data === 'tog:lunch' || data === 'tog:dinner') {
    const col = data === 'tog:lunch' ? 'lunch' : 'dinner';
    await env.DB.prepare(`UPDATE users SET ${col} = 1 - ${col} WHERE chat_id = ?`).bind(chatId).run();
  } else if (data.startsWith('rad:')) {
    const m = Number(data.slice(4));
    if ([500, 1000, 2000].includes(m)) {
      await env.DB.prepare('UPDATE users SET radius_m = ? WHERE chat_id = ?').bind(m, chatId).run();
    }
  } else if (data === 'forget:yes') {
    await env.DB.prepare('DELETE FROM users WHERE chat_id = ?').bind(chatId).run();
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Deleted' });
    if (msgId) await tg(env, 'editMessageText', { chat_id: chatId, message_id: msgId, text: '🗑 Done. Everything about you is deleted. Send /start anytime to come back.' });
    return;
  } else if (data === 'forget:no') {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Kept' });
    if (msgId) await tg(env, 'editMessageText', { chat_id: chatId, message_id: msgId, text: 'Okay, nothing deleted 👍' });
    return;
  }

  const user = await getUser(env, chatId);
  await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
  if (user && msgId) {
    await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: alertKeyboard(user) });
  }
}

async function askForget(env: Env, chatId: number) {
  return sendMessage(env, chatId, 'Delete your saved location and settings? This can’t be undone.', {
    reply_markup: {
      inline_keyboard: [[{ text: '🗑 Yes, delete', callback_data: 'forget:yes' }, { text: 'Cancel', callback_data: 'forget:no' }]],
    },
  });
}

// --- Static texts -------------------------------------------------------------

function liveHowTo() {
  return (
    '📡 <b>Share your live location</b> so alerts follow you around (phone only):\n\n' +
    '1. Tap 📎 (attach) at the bottom of this chat\n' +
    '2. Tap <b>Location</b>\n' +
    '3. Tap <b>Share My Live Location</b>\n' +
    '4. Pick how long. “Until I turn it off” works best for daily alerts\n\n' +
    'Stop anytime from the bar at the top of this chat. I only keep your latest spot, never a history.'
  );
}

function aboutText(env: Env) {
  return (
    '<b>About this bot</b>\n' +
    'Finds food deals near you in Singapore, collected from public deal articles and brand pages a few times a day.\n\n' +
    '<b>Commands</b>\n/now – deals near you\n/alerts – lunch &amp; dinner alerts\n/live – share live location\n/forget – delete your data\n\n' +
    'Always check the source link before you go: deals can end early.\n' +
    'Map data © OpenStreetMap contributors. Address search by OneMap (SLA).'
  );
}

/** '18:00' -> '6pm', '11:30' -> '11:30am' */
export function t12(hhmm: string): string {
  const mins = parseHHMM(hhmm);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}
