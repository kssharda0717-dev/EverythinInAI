#!/usr/bin/env node
/**
 * EverythinInAI — Weekend Travel Nudge
 *
 * Runs every Friday at 18:00 IST (12:30 UTC).
 * Checks if Rhea has a travel plan for the upcoming Sat-Sun.
 * If not, pings the user on Telegram to plan one (or confirm "home").
 *
 * Goal: Save the user from forgetting and ending up with generic "home" content
 * by default. Gives them a 5-second prompt to lock in this weekend's location.
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const axios = require('axios');

const log = createLogger('weekend_travel_nudge');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  log.error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function sendMessage(text) {
  try {
    await axios.post(`${API}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown',
    }, { timeout: 10_000 });
  } catch (err) {
    await axios.post(`${API}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text }, { timeout: 10_000 });
  }
}

function getUpcomingWeekend() {
  const now = new Date();
  const dow = now.getDay();
  let saturday;
  if (dow === 5) {
    saturday = new Date(now);
    saturday.setDate(saturday.getDate() + 1);
  } else if (dow === 6) {
    saturday = new Date(now);
  } else if (dow === 0) {
    saturday = new Date(now);
    saturday.setDate(saturday.getDate() - 1);
  } else {
    const daysUntilSat = (6 - dow + 7) % 7;
    saturday = new Date(now);
    saturday.setDate(saturday.getDate() + daysUntilSat);
  }
  const sunday = new Date(saturday);
  sunday.setDate(sunday.getDate() + 1);
  return {
    saturday: saturday.toISOString().slice(0, 10),
    sunday: sunday.toISOString().slice(0, 10),
  };
}

async function main() {
  const db = dbModule.getClient();
  const { saturday, sunday } = getUpcomingWeekend();

  log.info(`Checking travel plans for ${saturday} -> ${sunday}...`);

  const { data: existing } = await db.from('travel_calendar')
    .select('*')
    .eq('start_date', saturday)
    .eq('end_date', sunday)
    .maybeSingle();

  if (existing) {
    log.info(`Travel already planned: ${existing.location}. No nudge needed.`);
    await sendMessage(
      `🌴 *Weekend Confirmed*\n\n` +
      `Rhea is going to *${existing.location}* this weekend (${saturday} → ${sunday}).\n` +
      `Vibe: ${existing.vibe || 'adventure'}\n` +
      (existing.planned_activities && existing.planned_activities.length ? `Activities: ${existing.planned_activities.join(', ')}\n` : '') +
      `\n_Use_ \`/travel home\` _to cancel, or_ \`/travel <new location>\` _to change._`
    );
    return;
  }

  // No mode picked — ask the 4-option menu
  const msg =
    `🌟 *Weekend Mode for Rhea*\n\n` +
    `Sat ${saturday} + Sun ${sunday}\n\n` +
    `Pick ONE mode (applies to both days):\n\n` +
    `🏠 \`/home\` — both reels in Bandra/Mumbai\n\n` +
    `✈️ \`/travel <city> <vibe>\` — e.g., \`/travel Goa beach\`, \`/travel Bali resort\`\n   (both reels set in that location)\n\n` +
    `💃 \`/dance\` — both reels are lip-synced dance videos\n   (I'll then ask you to forward 2 audio files, one for Sat and one for Sun)\n\n` +
    `✨ \`/inspire\` — Rhea renders her own version of 2 reels you forward (same vibe, same audio, Rhea's face/body, Rhea's setting)\n   (I'll ask you to forward 2 reference reels, IG URL or video both work)\n\n` +
    `_Default if you don't reply: \`home\`._`;

  await sendMessage(msg);
  log.info(`✓ Sent weekend mode nudge (home/travel/dance/inspire).`);
}

if (require.main === module) {
  main().catch(err => { log.error(`Fatal: ${err.message}`); process.exit(1); });
}
