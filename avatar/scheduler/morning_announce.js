#!/usr/bin/env node
/**
 * EverythinInAI — Morning Schedule Announcer (Phase 15)
 *
 * Runs every morning at 8 AM IST. Ensures today's content_calendar row exists
 * and sends a Telegram message that tells you what's on for today.
 *
 *   Mon-Thu: "Today is Monday — TECH REEL day. 3 concepts will arrive shortly."
 *   Fri:     "Today is Friday — LURE PHOTO day. Reply /go to fire it."
 *   Sat-Sun: "Today is Saturday — LIFESTYLE REEL day. Reply /go to fire it."
 *
 * For tech reels, the existing run_daily.js cron does the actual ideation.
 * This script just ensures the calendar row + announces the day.
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const { getContentTypeForDate, ensureTodaysCalendarRow, WEEKDAY_NAMES } = require('./weekly_planner');
const { sendStatus } = require('../ideation/telegram_notify');

const log = createLogger('morning_announce');

const TYPE_LABEL = {
  tech_reel:      'TECH REEL',
  lure_photo:     'LURE PHOTO',
  lifestyle_reel: 'LIFESTYLE REEL',
};

const TYPE_INSTRUCTION = {
  tech_reel:      '🎬 3 fresh concepts will arrive shortly. Reply /pick_<id> to render one.',
  lure_photo:     '📸 Reply /go to fire today\'s lure photo (Avi only, no script).',
  lifestyle_reel: '🌅 Reply /go to fire today\'s lifestyle reel (Avi day-in-life, no voice).',
};

async function main() {
  const today = new Date();
  const targetDate = today.toISOString().slice(0, 10);
  const { weekday, weekdayName, contentType } = getContentTypeForDate(today);

  log.info(`Morning announce — ${targetDate} (${weekdayName}) → ${contentType}`);

  let calRow;
  try {
    calRow = await ensureTodaysCalendarRow();
  } catch (err) {
    log.error(`Failed to ensure calendar row: ${err.message}`);
    await sendStatus(`⚠️ Morning announce — calendar row insert failed: ${err.message.slice(0, 200)}`);
    process.exit(1);
  }

  if (calRow.state === 'done') {
    log.info(`Today's content already done. Skipping announce.`);
    return;
  }

  const lines = [
    `☀️ *${weekdayName}, ${targetDate}*`,
    ``,
    `📅 Today's slot: *${TYPE_LABEL[contentType] || contentType}*`,
    ``,
    TYPE_INSTRUCTION[contentType] || '',
    ``,
    `Type /status anytime to check progress, or /help for all commands.`,
  ].join('\n');

  await sendStatus(lines);
  log.info(`✓ Morning announce sent for ${weekdayName}`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
