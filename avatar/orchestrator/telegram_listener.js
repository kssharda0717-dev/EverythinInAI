#!/usr/bin/env node
/**
 * EverythinInAI — Telegram Listener Daemon (Phase 15)
 *
 * Long-polls Telegram getUpdates and listens for:
 *   /pick_<8-char-id>     — user picks a tech-reel concept
 *   /go                   — user manually fires today's calendar (lure/lifestyle)
 *   /status               — print today's calendar + state
 *   /stats_<id> v=N w=N.N — log Instagram performance for a reel (views + watch time)
 *   /perf                 — view ranked framework performance from last 30 days
 *   /help                 — list commands
 *
 * On a successful /pick:
 *   1. Mark the concept as winner in reel_concepts
 *   2. Bind the calendar row's concept_id to it
 *   3. Set calendar.state = 'picked'
 *   4. Spawn the render orchestrator (async, non-blocking)
 *   5. Reply "Render started — I'll ping you when ready"
 *
 * Run as a systemd service that auto-restarts on crash.
 */

const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');
const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('telegram_listener');

const ROOT = path.resolve(__dirname, '../..');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

if (!TELEGRAM_BOT_TOKEN) {
  log.error('TELEGRAM_BOT_TOKEN not set; bailing.');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

let lastUpdateId = 0;

async function reply(chatId, text) {
  try {
    // Try Markdown first, fall back to plain text on 400 (Markdown parse errors)
    await axios.post(`${API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }, { timeout: 10_000 });
  } catch (err) {
    log.warn(`Markdown reply failed (${err.message}); retrying as plain text`);
    try {
      // Strip markdown markers and retry
      const plain = text.replace(/[*_`]/g, '');
      await axios.post(`${API}/sendMessage`, {
        chat_id: chatId,
        text: plain,
      }, { timeout: 10_000 });
    } catch (err2) {
      log.warn(`Plain text reply also failed: ${err2.message}`);
    }
  }
}

// ─── Command Handlers ───────────────────────────────────────────────────────

async function handlePick(chatId, idPrefix) {
  const db = dbModule.getClient();
  const today = new Date().toISOString().slice(0, 10);

  // Find concept that starts with this ID prefix
  const { data: concepts } = await db.from('reel_concepts')
    .select('*')
    .eq('target_date', today);

  if (!concepts || concepts.length === 0) {
    return reply(chatId, `❌ No concepts for today (${today}). Did the morning ideation cron run?`);
  }

  const match = concepts.find(c => c.id.startsWith(idPrefix));
  if (!match) {
    return reply(chatId, `❌ No concept starting with \`${idPrefix}\`. Today's IDs:\n` +
      concepts.map(c => `• \`${c.id.slice(0, 8)}\``).join('\n'));
  }

  // Make sure today's calendar row is a tech_reel
  const { data: calRow } = await db.from('content_calendar')
    .select('*')
    .eq('target_date', today)
    .eq('content_type', 'tech_reel')
    .maybeSingle();

  if (!calRow) {
    return reply(chatId, `❌ Today (${today}) is not a tech-reel day. Today's calendar slot is a different content type.`);
  }
  if (calRow.state === 'rendering') {
    return reply(chatId, `⚠️ Today's render is already in progress (state=rendering). Wait for completion.`);
  }
  if (calRow.state === 'done') {
    return reply(chatId, `✅ Today's render is already done.\n📥 ${calRow.output_url}`);
  }

  // Mark all 3 concepts: chosen one is winner, others are not
  await db.from('reel_concepts').update({ is_winner: false }).eq('target_date', today);
  await db.from('reel_concepts').update({ is_winner: true }).eq('id', match.id);

  // Update calendar: bind concept + mark picked
  await db.from('content_calendar').update({
    concept_id: match.id,
    state: 'picked',
    picked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', calRow.id);

  await reply(chatId,
    `✅ *Picked Concept ${match.angle?.toUpperCase() || '?'}*: ${match.title || match.hook || ''}\n\n` +
    `🎬 Render started in background.\n` +
    `⏱ Expect ~10 min.\n` +
    `I'll ping you with the URL + caption when ready.`
  );

  // Fire the orchestrator in background
  spawnOrchestrator(calRow.id);
}

async function handleGo(chatId) {
  const db = dbModule.getClient();
  const today = new Date().toISOString().slice(0, 10);

  const { data: calRow } = await db.from('content_calendar')
    .select('*')
    .eq('target_date', today)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!calRow) {
    return reply(chatId, `❌ No calendar row for today (${today}). Run the planner cron first.`);
  }
  if (calRow.content_type === 'tech_reel') {
    return reply(chatId, `⚠️ Today is a tech-reel day. Use \`/pick_<id>\` to choose a concept first.`);
  }
  if (calRow.state === 'done') {
    return reply(chatId, `✅ Already done.\n📥 ${calRow.output_url}`);
  }
  if (calRow.state === 'rendering') {
    return reply(chatId, `⚠️ Already rendering. Wait for completion.`);
  }

  // For lure_photo and lifestyle_reel, no concept pick needed — just mark picked + fire
  await db.from('content_calendar').update({
    state: 'picked',
    picked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', calRow.id);

  await reply(chatId,
    `🚀 Firing today's *${calRow.content_type.replace('_', ' ').toUpperCase()}*.\n` +
    `I'll ping you when ready.`
  );

  spawnOrchestrator(calRow.id);
}

async function handleStatus(chatId) {
  const db = dbModule.getClient();
  const today = new Date().toISOString().slice(0, 10);

  const { data: calRow } = await db.from('content_calendar')
    .select('*')
    .eq('target_date', today)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!calRow) {
    return reply(chatId, `📭 No calendar row for today (${today}). Planner cron may not have run.`);
  }

  const stateEmoji = {
    pending: '⏳',
    picked: '🟡',
    rendering: '🔄',
    done: '✅',
    failed: '❌',
  }[calRow.state] || '❔';

  await reply(chatId,
    `${stateEmoji} *${today}* — ${calRow.content_type.replace('_', ' ').toUpperCase()}\n` +
    `   State: \`${calRow.state}\`\n` +
    (calRow.output_url ? `   URL: ${calRow.output_url}\n` : '') +
    (calRow.error_message ? `   Error: ${calRow.error_message}\n` : '')
  );
}

async function handleHelp(chatId) {
  await reply(chatId,
    `🤖 *Rhea Bot Commands*\n\n` +
    `\`/pick_<id>\`   pick a tech-reel concept (8-char id from morning ideation)\n` +
    `\`/go\`           fire today's lure-photo or lifestyle-reel render\n` +
    `\`/status\`       check today's calendar state\n` +
    `\`/help\`         this message\n\n` +
    `📅 *Weekly Schedule*\n` +
    `Mon-Thu: Tech Reel (you /pick_<id>)\n` +
    `Fri:     Lure Photo (you /go)\n` +
    `Sat-Sun: Lifestyle Reel (you /go)\n`
  );
}

// ─── Spawn Orchestrator (async) ─────────────────────────────────────────────

function spawnOrchestrator(calendarId) {
  log.info(`Spawning orchestrator for calendar ${calendarId}...`);
  const child = spawn('node', [
    'avatar/orchestrator/render_winner.js',
    `--calendar=${calendarId}`,
  ], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore',
      require('fs').openSync(`/tmp/render-${calendarId}.log`, 'w'),
      require('fs').openSync(`/tmp/render-${calendarId}.err`, 'w'),
    ],
  });
  child.unref();
  log.info(`✓ Orchestrator spawned (pid=${child.pid}). Logs: /tmp/render-${calendarId}.log`);
}

// ─── Long-poll Loop ─────────────────────────────────────────────────────────

async function poll() {
  try {
    const r = await axios.get(`${API}/getUpdates`, {
      params: { offset: lastUpdateId + 1, timeout: 25 },
      timeout: 30_000,
    });
    const updates = r.data?.result || [];
    for (const u of updates) {
      lastUpdateId = u.update_id;
      const msg = u.message;
      if (!msg || !msg.text) continue;
      const chatId = msg.chat.id;
      // Allow only the configured chat (or any if not set, for testing)
      if (TELEGRAM_CHAT_ID && String(chatId) !== String(TELEGRAM_CHAT_ID)) {
        log.warn(`Ignoring message from chat ${chatId} (not the configured chat)`);
        continue;
      }

      const text = msg.text.trim();
      log.info(`[${chatId}] ${text}`);

      if (text === '/help' || text === '/start') {
        await handleHelp(chatId);
      } else if (text === '/status') {
        await handleStatus(chatId);
      } else if (text === '/go') {
        await handleGo(chatId);
      } else if (text === '/perf') {
        await handlePerf(chatId);
      } else if (text.startsWith('/stats_') || text.startsWith('/stats ')) {
        await handleStats(chatId, text);
      } else if (text.startsWith('/pick_')) {
        const idPrefix = text.replace('/pick_', '').trim();
        if (idPrefix.length < 4) {
          await reply(chatId, `❌ ID prefix too short. Use /pick_<8-char-id>`);
        } else {
          await handlePick(chatId, idPrefix);
        }
      }
    }
  } catch (err) {
    log.warn(`poll error: ${err.message}`);
    await new Promise(r => setTimeout(r, 5000));
  }
  setImmediate(poll);
}

// ===== Analytics Feedback Loop Handlers =====

/**
 * /stats_<id-prefix> v=<views> w=<avg_watch_sec> [l=<likes>] [c=<comments>] [s=<shares>] [sv=<saves>] [f=<followers_gained>]
 * Example: /stats_f6c7c97b v=109 w=3.5 l=4 c=2
 * This logs Instagram performance for a specific reel into reel_performance.
 */
async function handleStats(chatId, text) {
  const db = dbModule.getClient();

  // Parse the command. Accept /stats_<id> tokens... or /stats <id> tokens...
  const tokens = text.replace(/^\/stats[_ ]/, '').trim().split(/\s+/);
  if (tokens.length < 2) {
    await reply(chatId,
      '❌ Usage: `/stats_<concept-id> v=<views> w=<watch_sec>`\n' +
      '\nOptional fields: `l=<likes> c=<comments> s=<shares> sv=<saves> f=<followers_gained>`\n' +
      '\nExample: `/stats_f6c7c97b v=109 w=3.5 l=4 c=2`'
    );
    return;
  }

  const idPrefix = tokens.shift();
  const params = {};
  for (const t of tokens) {
    const [k, v] = t.split('=');
    if (k && v !== undefined) params[k.trim()] = v.trim();
  }

  if (!params.v || !params.w) {
    await reply(chatId, '❌ Missing required fields. Need at least `v=<views>` and `w=<watch_sec>`.');
    return;
  }

  // Find the concept by id prefix
  const { data: concepts } = await db.from('reel_concepts')
    .select('id, title, angle, estimated_seconds, video_url')
    .ilike('id', `${idPrefix}%`)
    .limit(2);
  if (!concepts || concepts.length === 0) {
    await reply(chatId, `❌ No reel concept found with id starting with \`${idPrefix}\`.`);
    return;
  }
  if (concepts.length > 1) {
    await reply(chatId, `❌ Multiple concepts match \`${idPrefix}\`. Use a longer prefix.`);
    return;
  }
  const concept = concepts[0];

  // Insert into reel_performance
  const record = {
    concept_id: concept.id,
    framework: concept.angle || 'unknown',
    views: parseInt(params.v, 10) || 0,
    avg_watch_sec: parseFloat(params.w) || 0,
    reel_duration: concept.estimated_seconds || null,
    likes: parseInt(params.l, 10) || 0,
    comments: parseInt(params.c, 10) || 0,
    shares: parseInt(params.s, 10) || 0,
    saves: parseInt(params.sv, 10) || 0,
    followers_gained: parseInt(params.f, 10) || 0,
    recorded_at: new Date().toISOString(),
  };

  const { error } = await db.from('reel_performance').insert(record);
  if (error) {
    await reply(chatId, `❌ DB error: ${error.message}`);
    return;
  }

  // Compute retention pct for the reply
  const retention = record.reel_duration > 0
    ? Math.min(100, (record.avg_watch_sec / record.reel_duration) * 100).toFixed(1)
    : '?';

  await reply(chatId,
    `✅ *Performance Logged*\n\n` +
    `Reel: ${concept.title}\n` +
    `Framework: \`${record.framework}\`\n` +
    `Views: ${record.views}\n` +
    `Avg Watch: ${record.avg_watch_sec}s\n` +
    `Retention: ${retention}%\n` +
    `Likes/Comments/Shares/Saves: ${record.likes}/${record.comments}/${record.shares}/${record.saves}\n\n` +
    `_The LLM will use this data in its next ideation cycle to favor high-performing frameworks._`
  );
}

/**
 * /perf — show ranked framework performance from the last 30 days
 */
async function handlePerf(chatId) {
  const db = dbModule.getClient();
  const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString();

  const { data: rows, error } = await db.from('reel_performance')
    .select('framework, views, avg_watch_sec, retention_pct, likes, shares, saves')
    .gte('recorded_at', thirtyDaysAgo);

  if (error) {
    await reply(chatId, `❌ DB error: ${error.message}`);
    return;
  }

  if (!rows || rows.length === 0) {
    await reply(chatId,
      '_No performance data yet._\n\n' +
      'Log your first reel with `/stats_<id> v=<views> w=<watch_sec>`'
    );
    return;
  }

  // Aggregate by framework
  const agg = {};
  for (const r of rows) {
    const f = r.framework || 'unknown';
    if (!agg[f]) agg[f] = { count: 0, views: 0, watch: 0, retention: 0, eng: 0 };
    agg[f].count++;
    agg[f].views += r.views || 0;
    agg[f].watch += parseFloat(r.avg_watch_sec) || 0;
    agg[f].retention += parseFloat(r.retention_pct) || 0;
    agg[f].eng += (r.likes || 0) + (r.shares || 0) + (r.saves || 0);
  }

  // Sort by avg retention
  const ranked = Object.entries(agg)
    .map(([f, a]) => ({
      framework: f,
      reels: a.count,
      avgViews: Math.round(a.views / a.count),
      avgWatch: (a.watch / a.count).toFixed(1),
      avgRetention: (a.retention / a.count).toFixed(1),
      totalEng: a.eng,
    }))
    .sort((a, b) => parseFloat(b.avgRetention) - parseFloat(a.avgRetention));

  let msg = `📊 *Framework Performance (last 30 days)*\n\n`;
  for (const r of ranked) {
    msg += `*${r.framework}*  (×${r.reels})\n` +
           `  → ${r.avgViews} views · ${r.avgWatch}s watch · ${r.avgRetention}% retention\n` +
           `  → ${r.totalEng} total engagement\n\n`;
  }
  msg += `_Best framework will be favored in next ideation._`;
  await reply(chatId, msg);
}

log.info('🤖 Telegram listener daemon starting...');
log.info(`   Bot: ${TELEGRAM_BOT_TOKEN.slice(0, 10)}…`);
log.info(`   Chat lock: ${TELEGRAM_CHAT_ID || '(none, accept all)'}`);
poll();
