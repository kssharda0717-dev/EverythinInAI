#!/usr/bin/env node
/**
 * EverythinInAI — Weekly Stats Announcer
 *
 * Fires every Sunday at 19:00 IST via systemd timer.
 * Pulls the last 7 days of posted reels and asks the user to fill in
 * Instagram performance numbers via Telegram.
 *
 * The user replies with a single message of the form:
 *
 *   /weekly_stats
 *   1. views=109 watch=3.5
 *   2. views=300 watch=6.2
 *   ...
 *
 * The parser in telegram_listener.js will match each numbered line
 * back to the correct concept_id (cached in pending_weekly_stats table
 * to avoid mid-week race conditions).
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const axios = require('axios');

const log = createLogger('weekly_stats_announcer');

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
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown',
    }, { timeout: 10_000 });
  } catch (err) {
    // Markdown can fail on special characters; retry as plain text
    log.warn(`Markdown send failed, retrying as plain: ${err.message}`);
    await axios.post(`${API}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
    }, { timeout: 10_000 });
  }
}

async function main() {
  const db = dbModule.getClient();
  log.info('Building weekly stats reminder...');

  // Get the last 7 days of posted reels (state=ready or done)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const today = new Date().toISOString().slice(0, 10);

  // Fetch the calendar rows for the last 7 days where content was rendered
  const { data: calRows, error: calErr } = await db.from('content_calendar')
    .select('id, target_date, content_type, concept_id, output_url, state')
    .gte('target_date', sevenDaysAgo.slice(0, 10))
    .lte('target_date', today)
    .in('state', ['done', 'ready'])
    .order('target_date', { ascending: true });

  if (calErr) {
    log.error(`Failed to fetch calendar: ${calErr.message}`);
    process.exit(1);
  }

  if (!calRows || calRows.length === 0) {
    log.info('No rendered reels in the last 7 days. Skipping reminder.');
    await sendMessage(
      '📊 *Weekly Stats Check-in*\n\nNo reels were rendered this week. Nothing to log.\n\n_Get back to making content!_'
    );
    return;
  }

  // For each calendar row, fetch the concept title for nicer display
  const conceptIds = calRows.map(r => r.concept_id).filter(Boolean);
  const { data: concepts } = await db.from('reel_concepts')
    .select('id, title, angle, estimated_seconds')
    .in('id', conceptIds);
  const conceptById = Object.fromEntries((concepts || []).map(c => [c.id, c]));

  // Filter rows to those with valid concepts and that haven't already been logged this week
  const alreadyLogged = new Set();
  const { data: existing } = await db.from('reel_performance')
    .select('concept_id')
    .gte('recorded_at', sevenDaysAgo);
  (existing || []).forEach(r => alreadyLogged.add(r.concept_id));

  const items = [];
  for (const row of calRows) {
    if (!row.concept_id) continue;
    const c = conceptById[row.concept_id];
    if (!c) continue;
    if (alreadyLogged.has(row.concept_id)) continue;
    items.push({
      calendar_id: row.id,
      concept_id: row.concept_id,
      target_date: row.target_date,
      content_type: row.content_type,
      title: c.title,
      framework: c.angle || 'unknown',
      duration: c.estimated_seconds || null,
    });
  }

  if (items.length === 0) {
    log.info('All reels this week already have performance logged. Nothing to do.');
    await sendMessage(
      '📊 *Weekly Stats Check-in*\n\nAll this week\'s reels already have performance logged. Great job staying on top of it!'
    );
    return;
  }

  // Persist this "pending check-in" in a small table so the parser can match positions later.
  // Use a single JSON row keyed by date so we always overwrite stale check-ins.
  const checkInKey = `weekly_stats_${today}`;
  await db.from('pending_check_ins')
    .upsert({
      key: checkInKey,
      items: items,
      created_at: new Date().toISOString(),
    }, { onConflict: 'key' });

  // Build the message
  let msg = '📊 *Weekly Performance Check-in*\n\n';
  msg += 'Please reply with the views and watch time for these reels.\n\n';
  msg += 'Just copy the template below, fill in the numbers, and send it back as ONE message:\n\n';
  msg += '```\n/weekly_stats\n';
  items.forEach((item, idx) => {
    const friendly = item.title.length > 35 ? item.title.slice(0, 35) + '…' : item.title;
    msg += `${idx + 1}. ${friendly} | views= totalwatch=\n`;
  });
  msg += '```\n\n';
  msg += `*Quick guide* — in Instagram Insights, look for:\n`;
  msg += `• *Views*: total views count (e.g., 109)\n`;
  msg += `• *totalwatch*: "Total watch time" — paste as you see it (e.g., \`6m 49s\` or \`409\`)\n\n`;
  msg += `_Or if Instagram shows you "Avg watch time" instead, use \`watch=3.5\` (in seconds)._\n\n`;
  msg += `_The bot will auto-compute retention % from these two numbers._`;

  await sendMessage(msg);
  log.info(`✓ Sent weekly check-in for ${items.length} reels.`);
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
