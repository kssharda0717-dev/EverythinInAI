/**
 * EverythinInAI — Telegram Observability Bot
 *
 * Sends a daily digest to your Telegram chat.
 * Triggered by a systemd timer (runs once daily at 21:00 IST = 15:30 UTC).
 *
 * .env requirements:
 *   TELEGRAM_BOT_TOKEN  — get from @BotFather
 *   TELEGRAM_CHAT_ID    — your personal chat id (get via https://api.telegram.org/bot<TOKEN>/getUpdates)
 *
 * Both vars are OPTIONAL — if missing, the script logs to stdout and exits 0.
 */

const axios = require('axios');
const dbModule = require('../core/database');
const { config } = require('../core/config');
const { createLogger } = require('../utils/logger');

const log = createLogger('telegram');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

async function buildDigest() {
  const db = dbModule.getClient();

  const { data: digest } = await db.from('v_daily_digest').select('*').single();

  // Top 5 trending tools added in last 24h (by upvotes)
  const { data: hotTools } = await db
    .from('tools')
    .select('name, tagline, url, upvotes')
    .gte('added_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .order('upvotes', { ascending: false })
    .limit(5);

  // Top 3 hot signals
  const { data: hotSignals } = await db
    .from('ai_signals')
    .select('title, type, virality_score, url')
    .gte('added_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .order('virality_score', { ascending: false })
    .limit(3);

  return { digest: digest || {}, hotTools: hotTools || [], hotSignals: hotSignals || [] };
}

function formatMessage({ digest, hotTools, hotSignals }) {
  const lines = [];
  lines.push('🌅 *EverythinInAI — Daily Digest*');
  lines.push(`📅 ${digest.as_of || new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('*📦 Tools:*');
  lines.push(`  • Total active: *${digest.total_active_tools || 0}*`);
  lines.push(`  • Added (24h): *${digest.tools_added_24h || 0}*`);
  lines.push('');
  lines.push('*📰 Signals:*');
  lines.push(`  • Total active: *${digest.total_active_signals || 0}*`);
  lines.push(`  • Added (24h): *${digest.signals_added_24h || 0}*`);
  lines.push(`  • Hot (virality≥7): *${digest.hot_signals_24h || 0}*`);
  lines.push('');
  lines.push('*🎬 Avatar:*');
  lines.push(`  • Briefs awaiting review: *${digest.briefs_awaiting_review || 0}*`);
  lines.push(`  • Posted today: *${digest.posts_today || 0}*`);
  lines.push('');
  lines.push('*⚙️ Engine:*');
  lines.push(`  • Backfill: ${digest.backfill_months_done || 0} done / ${digest.backfill_months_pending || 0} pending`);
  lines.push(`  • Failed runs (24h): *${digest.failed_runs_24h || 0}*`);
  if (digest.last_successful_run_at) {
    lines.push(`  • Last successful run: ${new Date(digest.last_successful_run_at).toLocaleString()}`);
  }

  if (hotTools.length) {
    lines.push('');
    lines.push('*🔥 Top tools today:*');
    hotTools.forEach((t, i) => {
      lines.push(`${i + 1}. *${escapeMd(t.name)}* — ${escapeMd((t.tagline || '').substring(0, 80))}`);
    });
  }

  if (hotSignals.length) {
    lines.push('');
    lines.push('*🚨 Top signals today:*');
    hotSignals.forEach((s, i) => {
      lines.push(`${i + 1}. \\[${s.type}/${s.virality_score}/10\\] *${escapeMd(s.title.substring(0, 100))}*`);
    });
  }

  return lines.join('\n');
}

// Telegram MarkdownV2 requires escaping certain chars
function escapeMd(s) {
  return String(s || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, (c) => `\\${c}`);
}

async function send(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log.warn('Telegram not configured — printing digest to stdout instead');
    console.log('\n' + text + '\n');
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
  });
  log.info('Daily digest sent to Telegram');
}

async function main() {
  try {
    const data = await buildDigest();
    const message = formatMessage(data);
    await send(message);
    process.exit(0);
  } catch (err) {
    log.error(`Telegram digest failed: ${err.message}`);
    if (err.response?.data) log.error(JSON.stringify(err.response.data));
    process.exit(1);
  }
}

main();
