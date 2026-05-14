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

  log.info(`Looking for reels POSTED between ${earliest} and ${latest}`);

  // Anchor on posted_at (when the user actually published to Instagram), not completed_at (when render finished).
  // We also fetch check_in_alerted_at so we can dedup against rows that were
  // already pinged once during this 4-hour window. Without this, the same reel
  // re-fires every hour for up to 4 hours until the user replies with stats.
  const { data: dueRows, error } = await db.from('content_calendar')
    .select('id, target_date, content_type, concept_id, posted_at, state, check_in_alerted_at')
    .gte('posted_at', earliest)
    .lte('posted_at', latest)
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

  // Filter: must have a concept_id, must NOT already have stats logged, AND
  // must NOT have been alerted in this check-in window already.
  const pending = dueRows.filter(r =>
    r.concept_id
    && !loggedSet.has(r.concept_id)
    && !r.check_in_alerted_at  // dedup: skip if we already pinged for this row
  );
  if (pending.length === 0) {
    log.info('All due reels already have stats logged or were already alerted.');
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
    const hoursOld = Math.round((now - new Date(row.posted_at).getTime()) / 3600_000);

    const msg =
      `\u23F0 *48h Check-in*\n\n` +
      `Reel posted ~${hoursOld}h ago:\n*${friendly}*\n` +
      `Framework: \`${c.angle || 'unknown'}\`\n\n` +
      `Open Instagram \u2192 reel \u2192 *View Insights*. Copy the numbers, then send:\n\n` +
      `\`\`\`\n/stats_${idPrefix} v= totalwatch= l= c= s= sv=\n\`\`\`\n\n` +
      `_Where:_\n` +
      `  *v* = views (the big number at the top)\n` +
      `  *totalwatch* = "Watch time" (e.g. \`6m 49s\` or \`28 minutes 34 seconds\`)\n` +
      `  *l* = likes, *c* = comments, *s* = shares, *sv* = saves\n\n` +
      `_Full example:_\n` +
      `\`/stats_${idPrefix} v=151 totalwatch=28m 39s l=12 c=2 s=4 sv=8\``;

    await sendMessage(msg);
    log.info(`\u2713 Sent 48h check-in for reel ${idPrefix} (${c.angle})`);

    // Mark this calendar row as alerted so the next hourly run won't re-ping it.
    // The column is added by sql/025; if missing on older deploys, the update
    // will silently no-op (Supabase ignores unknown columns? — actually it errors,
    // so we wrap in try/catch so the migration can land at any time).
    try {
      const { error: updErr } = await db.from('content_calendar')
        .update({ check_in_alerted_at: new Date().toISOString() })
        .eq('id', row.id);
      if (updErr) log.warn(`Could not mark check_in_alerted_at on ${row.id}: ${updErr.message}. Run sql/025 migration.`);
    } catch (e) {
      log.warn(`check_in_alerted_at update threw: ${e.message}`);
    }

    // Small delay to avoid rate-limiting if multiple reels fall in the same hour
    await new Promise(r => setTimeout(r, 500));
  }
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
