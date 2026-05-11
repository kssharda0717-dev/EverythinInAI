#!/usr/bin/env node
/**
 * Weekly Health Report - sends a summary every Sunday 8 PM IST via Telegram.
 * Covers: spend, latency, queue, performance, growth phase.
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const axios = require('axios');

const log = createLogger('weekly_health_report');

const TBT = process.env.TELEGRAM_BOT_TOKEN || '';
const TCID = process.env.TELEGRAM_CHAT_ID || '';
if (!TBT || !TCID) { log.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID'); process.exit(1); }

const API = `https://api.telegram.org/bot${TBT}`;

async function send(text) {
  try {
    await axios.post(`${API}/sendMessage`, { chat_id: TCID, text, parse_mode: 'Markdown' }, { timeout: 10_000 });
  } catch {
    await axios.post(`${API}/sendMessage`, { chat_id: TCID, text }, { timeout: 10_000 });
  }
}

(async () => {
  const db = dbModule.getClient();
  const sevenDaysAgo = new Date(Date.now() - 7*24*3600_000).toISOString();

  // Spend
  const { data: spend } = await db.from('daily_spend_log').select('cost_usd, service').gte('created_at', sevenDaysAgo);
  const spendByService = {};
  let weekTotal = 0;
  for (const s of (spend || [])) {
    const c = parseFloat(s.cost_usd) || 0;
    spendByService[s.service] = (spendByService[s.service] || 0) + c;
    weekTotal += c;
  }

  // Reels posted this week
  const { count: postedCount } = await db.from('content_calendar').select('*', { count: 'exact', head: true }).gte('posted_at', sevenDaysAgo);

  // Performance avg
  const { data: perf } = await db.from('reel_performance').select('avg_watch_sec, retention_pct, framework').gte('recorded_at', sevenDaysAgo);
  const perfByFw = {};
  for (const p of (perf || [])) {
    const f = p.framework;
    if (!perfByFw[f]) perfByFw[f] = { count: 0, ret: 0 };
    perfByFw[f].count++;
    perfByFw[f].ret += parseFloat(p.retention_pct) || 0;
  }
  const fwLines = Object.entries(perfByFw)
    .map(([f, v]) => `  ${f}: ${(v.ret/v.count).toFixed(1)}% (n=${v.count})`)
    .join('\n');

  // Tools added this week
  const { count: newTools } = await db.from('tools').select('*', { count: 'exact', head: true }).gte('added_at', sevenDaysAgo);
  const { count: totalTools } = await db.from('tools').select('*', { count: 'exact', head: true }).eq('is_active', true);

  const msg =
    `\ud83d\udcca *Weekly Health Report*\n\n` +
    `*Spend (last 7d):* $${weekTotal.toFixed(2)}\n` +
    Object.entries(spendByService).map(([s, c]) => `  ${s}: $${c.toFixed(2)}`).join('\n') +
    `\n\n*Reels posted:* ${postedCount || 0}\n` +
    `*Tools added:* ${newTools || 0} (total: ${totalTools})\n\n` +
    `*Framework Performance:*\n${fwLines || '  (no data yet)'}\n\n` +
    `_Type_ \`/healthcheck\` _for live spend & latency snapshot._`;

  await send(msg);
  log.info('Weekly health report sent.');
})().catch(err => { log.error(err.message); process.exit(1); });
