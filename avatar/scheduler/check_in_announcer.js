#!/usr/bin/env node
/**
 * EverythinInAI — 48-Hour Check-in Announcer
 *
 * Runs every hour via systemd. For each rendered reel, checks if it was
 * posted ~48 hours ago and we haven't logged stats for it yet. If so,
 * pings the user on Telegram with a tiny, pre-filled form.
 *
 * Why 48h: After 48 hours, Instagram's "Avg Watch Time" stabilizes and
 * the algorithm has finished its initial test push. This is the gold
 * standard moment to capture true hook performance.
 *
 * Why "post age" not "render age": We use `completed_at` from content_calendar
 * as our proxy. (Manual posting delay is typically < 4 hours, well within tolerance.)
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const axios = require('axios');

const log = createLogger('check_in_announcer');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  log.error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Tolerance window: a reel posted 46-50 hours ago is "due" for check-in
const CHECKIN_AGE_MIN_HOURS = 46;
const CHECKIN_AGE_MAX_HOURS = 50;

async function sendMessage(text) {
  try {
    await axios.post(`${API}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }, { timeout: 10_000 });
  } catch (err) {
    log.warn(`Markdown send failed, retrying as plain: ${err.message}`);
    await axios.post(`${API}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text }, { timeout: 10_000 });
  }
}

async function main() {
  const db = dbModule.getClient();

  // Time window: reels completed between 46-50 hours ago
  const now = Date.now();
  const earliest = new Date(now - CHECKIN_AGE_MAX_HOURS * 3600_000).toISOString();
  const latest = new Date(now - CHECKIN_AGE_MIN_HOURS * 3600_000).toISOString();

  log.info(`Looking for reels completed between ${earliest} and ${latest}`);

  const { data: dueRows, error } = await db.from('content_calendar')
    .select('id, target_date, content_type, concept_id, completed_at, state')
    .gte('completed_at', earliest)
    .lte('completed_at', latest)
    .in('state', ['done', 'ready']);
  if (error) {
    log.error(`Failed to query calendar: ${error.message}`);
    process.exit(1);
  }

  if (!dueRows || dueRows.length === 0) {
    log.info('No reels due for 48h check-in.');
    return;
  }

  // Filter out those that already have a performance row
  const conceptIds = dueRows.map(r => r.concept_id).filter(Boolean);
  if (conceptIds.length === 0) {
    log.info('No concept_ids on due rows. Nothing to do.');
    return;
  }
  const { data: alreadyLogged } = await db.from('reel_performance')
    .select('concept_id')
    .in('concept_id', conceptIds);
  const loggedSet = new Set((alreadyLogged || []).map(r => r.concept_id));

  const pending = dueRows.filter(r => r.concept_id && !loggedSet.has(r.concept_id));
  if (pending.length === 0) {
    log.info('All due reels already have stats logged.');
    return;
  }

  // Enrich with concept title
  const { data: concepts } = await db.from('reel_concepts')
    .select('id, title, angle, estimated_seconds')
    .in('id', pending.map(p => p.concept_id));
  const conceptById = Object.fromEntries((concepts || []).map(c => [c.id, c]));

  // Send a tiny, focused message for each due reel
  for (const row of pending) {
    const c = conceptById[row.concept_id];
    if (!c) continue;

    const idPrefix = row.concept_id.slice(0, 8);
    const friendly = c.title.length > 40 ? c.title.slice(0, 40) + '…' : c.title;
    const hoursOld = Math.round((now - new Date(row.completed_at).getTime()) / 3600_000);

    const msg =
      `\u23F0 *48h Check-in*\n\n` +
      `Reel posted ~${hoursOld}h ago:\n*${friendly}*\n` +
      `Framework: \`${c.angle || 'unknown'}\`\n\n` +
      `Tap Instagram \u2192 reel \u2192 *View Insights*. Fill in:\n\n` +
      `\`\`\`\n/stats_${idPrefix} v= totalwatch=\n\`\`\`\n\n` +
      `_Example: /stats_${idPrefix} v=109 totalwatch=6m 49s_`;

    await sendMessage(msg);
    log.info(`\u2713 Sent 48h check-in for reel ${idPrefix} (${c.angle})`);

    // Small delay to avoid rate-limiting if multiple reels fall in the same hour
    await new Promise(r => setTimeout(r, 500));
  }
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
