#!/usr/bin/env node
/**
 * EverythinInAI — Telegram Listener Daemon (Phase 15)
 *
 * Long-polls Telegram getUpdates and listens for:
 *   /pick_<8-char-id>     — user picks a tech-reel concept
 *   /go                   — user manually fires today's calendar (lure/lifestyle)
 *   /status               — print today's calendar + state
 *   /stats_<id> v=N w=N.N — log Instagram performance for a reel (views + watch time)
 *   /weekly_stats         — multi-line: log performance for the whole week (push-based reminder)
 *   /perf                 — view ranked framework performance from last 30 days
 *   /travel <location> [activities]  — plan Rhea's next weekend trip
 *   /travel home          — reset to default (Bandra/Mumbai)
 *   /travel list          — show upcoming travel plans
 *   /posted [<id>]        — mark a reel as posted to Instagram (anchors 48h check-in clock)
 *   /audit_rejects        — review recently rejected discovery items, recover false negatives
 *   /healthcheck          — view system spend, latency, queue health
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

  // Find today's calendar row for any content type. Pick is now allowed for tech, lure, AND lifestyle days.
  const { data: calRow } = await db.from('content_calendar')
    .select('*')
    .eq('target_date', today)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!calRow) {
    return reply(chatId, `❌ No calendar row for today (${today}). Did the planner cron run?`);
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
  // Tech-reel days require a /pick. Lure & lifestyle days can also be picked or just /go'd.
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
      } else if (text === '/healthcheck') {
        await handleHealthcheck(chatId);
      } else if (text === '/audit_rejects') {
        await handleAuditRejects(chatId);
      } else if (text.startsWith('/posted')) {
        await handlePosted(chatId, text);
      } else if (text.startsWith('/travel')) {
        await handleTravel(chatId, text);
      } else if (text.startsWith('/weekly_stats')) {
        await handleWeeklyStats(chatId, text);
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

// ===== /posted: mark a reel as posted to Instagram (anchors 48h timer) =====

async function handlePosted(chatId, text) {
  const db = dbModule.getClient();
  const arg = text.replace(/^\/posted\s*/, '').trim();

  // Default: latest 'done' calendar row that has no posted_at yet
  let calRow;
  if (arg) {
    // Can't use .ilike on uuid columns (Postgres rejects: 'operator does not exist: uuid ~~* unknown').
    // Workaround: fetch the recent N rows and filter by id prefix in JS.
    const { data } = await db.from('content_calendar').select('*')
      .order('created_at', { ascending: false }).limit(50);
    calRow = (data || []).find(r => r.id.startsWith(arg.toLowerCase())) || null;
  } else {
    const { data } = await db.from('content_calendar').select('*')
      .eq('state', 'done')
      .is('posted_at', null)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    calRow = data;
  }

  if (!calRow) {
    await reply(chatId, '❌ No matching calendar row found. Either pass a partial id or finish a render first.');
    return;
  }

  await db.from('content_calendar')
    .update({ posted_at: new Date().toISOString() })
    .eq('id', calRow.id);

  await reply(chatId,
    `✅ *Marked as posted*\n\n` +
    `${calRow.content_type} for ${calRow.target_date}\n` +
    `Calendar id: \`${calRow.id.slice(0, 12)}\`\n\n` +
    `_The 48h check-in clock starts now. You'll get a stats prompt in 2 days._`
  );
}

// ===== /audit_rejects: review false-negative discovery items =====

async function handleAuditRejects(chatId) {
  const db = dbModule.getClient();
  const { data, error } = await db.from('discovery_queue')
    .select('id, url, raw_title, raw_description, source, error_message, heuristic_score, processed_at')
    .eq('status', 'rejected')
    .order('processed_at', { ascending: false, nullsFirst: false })
    .limit(8);

  if (error) {
    await reply(chatId, `❌ Query error: ${error.message}`);
    return;
  }
  if (!data || data.length === 0) {
    await reply(chatId, 'No rejected items in the queue. Nothing to audit.');
    return;
  }

  let msg = '🔍 *Recently Rejected Items* (review for false negatives)\n\n';
  for (const item of data) {
    const title = item.raw_title || '(no title)';
    const desc = (item.raw_description || '').slice(0, 80);
    const reason = item.error_message || 'unknown';
    msg += `• *${title}* _(${item.source || '?'}, score=${item.heuristic_score || 0})_\n`;
    if (desc) msg += `   _${desc}${desc.length >= 80 ? '…' : ''}_\n`;
    msg += `   🔗 ${item.url}\n`;
    msg += `   ✖️ ${reason}\n\n`;
  }
  msg += `_Spot a real tool that got wrongly rejected? Reply with its URL and I'll re-queue it._`;
  await reply(chatId, msg);
}

// ===== /healthcheck: spend, latency, queue snapshot =====

async function handleHealthcheck(chatId) {
  const db = dbModule.getClient();
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString();

  // Today's spend
  const { data: todaysSpend } = await db.from('daily_spend_log').select('cost_usd, service').eq('date', today);
  const todayTotal = (todaysSpend || []).reduce((s, r) => s + parseFloat(r.cost_usd || 0), 0);

  // Cap setting
  const { data: capSetting } = await db.from('system_settings').select('value').eq('key', 'daily_spend_cap_usd').maybeSingle();
  const cap = capSetting ? parseFloat(capSetting.value) : 5.0;

  // Latency p50/p90 over 7d
  const { data: latencies } = await db.from('latency_log')
    .select('service, operation, duration_ms, ok')
    .gte('created_at', sevenDaysAgo);
  const latByOp = {};
  for (const l of (latencies || [])) {
    const k = `${l.service}/${l.operation}`;
    if (!latByOp[k]) latByOp[k] = { all: [], fails: 0 };
    latByOp[k].all.push(l.duration_ms);
    if (!l.ok) latByOp[k].fails++;
  }
  const latLines = Object.entries(latByOp)
    .map(([k, v]) => {
      const sorted = v.all.slice().sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
      const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
      return `  ${k}: p50=${(p50/1000).toFixed(1)}s p90=${(p90/1000).toFixed(1)}s ${v.fails > 0 ? `⚠️ ${v.fails} fails` : ''}`;
    })
    .slice(0, 8)
    .join('\n');

  // Queue snapshot
  const { count: pending } = await db.from('discovery_queue').select('*', { count: 'exact', head: true }).eq('status', 'pending');
  const { count: rejected } = await db.from('discovery_queue').select('*', { count: 'exact', head: true }).eq('status', 'rejected');
  const { count: tools } = await db.from('tools').select('*', { count: 'exact', head: true }).eq('is_active', true);

  const msg =
    `⚙️ *Health Check*\n\n` +
    `*Today's spend:* $${todayTotal.toFixed(2)} / cap $${cap.toFixed(2)}\n\n` +
    `*Latency (p50/p90, last 7d):*\n${latLines || '  (no data yet)'}\n\n` +
    `*Discovery:* ${tools} active tools, ${pending} pending, ${rejected} rejected`;

  await reply(chatId, msg);
}

// ===== Travel Calendar Handler =====

/**
 * /travel <location> [vibe] ["activity1, activity2"]   — plan upcoming weekend trip
 * /travel home   — reset to Bandra/Mumbai (no special trip)
 * /travel list   — show upcoming trips
 *
 * Date logic: defaults to the upcoming Saturday-Sunday. If a trip already exists for that weekend, it is replaced.
 */
async function handleTravel(chatId, text) {
  const db = dbModule.getClient();
  const arg = text.replace(/^\/travel\s*/, '').trim();

  // /travel list
  if (arg === 'list' || arg === '') {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await db.from('travel_calendar')
      .select('*').gte('end_date', today).order('start_date', { ascending: true }).limit(10);
    if (!data || data.length === 0) {
      await reply(chatId, '🏠 No upcoming travel. Rhea stays in Bandra by default.\n\nUse `/travel <location>` to plan a trip.');
      return;
    }
    let msg = '🌍 *Upcoming Travel*\n\n';
    for (const t of data) {
      msg += `• *${t.start_date} → ${t.end_date}*  ${t.location} (${t.vibe || 'no vibe'})\n`;
      if (t.planned_activities && t.planned_activities.length) {
        msg += `   _activities: ${t.planned_activities.join(', ')}_\n`;
      }
    }
    await reply(chatId, msg);
    return;
  }

  // /travel home  — wipe upcoming weekend trip
  if (arg.toLowerCase() === 'home') {
    const { saturday, sunday } = getUpcomingWeekend();
    await db.from('travel_calendar').delete().eq('start_date', saturday).eq('end_date', sunday);
    await reply(chatId, `✅ Travel cleared. Rhea will stay in Bandra/Mumbai for ${saturday} → ${sunday}.`);
    return;
  }

  // /travel <location> [vibe] ["activity1, activity2, ..."]
  // Examples:
  //   /travel Goa
  //   /travel Goa beach
  //   /travel Goa beach "surfing, beach yoga, sunset drive"
  //   /travel "New Delhi" city
  //   /travel Lisbon european_city "old town walk, pastel de nata, fado night"
  const parts = parseTravelArgs(arg);
  if (!parts.location) {
    await reply(chatId,
      '❌ Usage:\n' +
      '`/travel <location> [vibe] ["activity1, activity2"]`\n\n' +
      'Examples:\n' +
      '`/travel Goa beach "surfing, beach yoga, sunset drive"`\n' +
      '`/travel Lisbon`\n' +
      '`/travel home`  (cancel)\n' +
      '`/travel list`  (show plans)'
    );
    return;
  }

  const { saturday, sunday } = getUpcomingWeekend();

  // Replace any existing entry for this weekend
  await db.from('travel_calendar').delete().eq('start_date', saturday).eq('end_date', sunday);

  const { error } = await db.from('travel_calendar').insert({
    start_date: saturday,
    end_date: sunday,
    location: parts.location,
    vibe: parts.vibe || null,
    planned_activities: parts.activities,
    notes: null,
  });

  if (error) {
    await reply(chatId, `❌ DB error: ${error.message}`);
    return;
  }

  await reply(chatId,
    `✅ *Travel Planned*\n\n` +
    `📅 ${saturday} → ${sunday}\n` +
    `📍 ${parts.location}\n` +
    `🌺 Vibe: ${parts.vibe || 'adventure'}\n` +
    (parts.activities.length ? `🎡 Activities: ${parts.activities.join(', ')}\n` : '') +
    `\n_Saturday & Sunday morning ideation will set Rhea's lifestyle reels in ${parts.location}._`
  );
}

function getUpcomingWeekend() {
  // Returns {saturday: 'YYYY-MM-DD', sunday: 'YYYY-MM-DD'} for the upcoming weekend.
  // If today is Sat or Sun, returns this weekend; else returns the next one.
  const now = new Date();
  const dow = now.getDay(); // 0=Sun, 6=Sat
  let saturday;
  if (dow === 6) {
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

/**
 * Parse a /travel arg string into { location, vibe, activities }.
 * Accepts:
 *   Goa
 *   Goa beach
 *   Goa beach "surfing, beach yoga"
 *   "New Delhi" city "shopping, biryani, qawwali"
 */
function parseTravelArgs(str) {
  const tokens = [];
  let buf = '';
  let inQuotes = false;
  for (const ch of str) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ' ' && !inQuotes) {
      if (buf) { tokens.push(buf); buf = ''; }
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);

  const result = { location: null, vibe: null, activities: [] };
  if (tokens.length >= 1) result.location = tokens[0];
  if (tokens.length >= 2) result.vibe = tokens[1];
  if (tokens.length >= 3) {
    result.activities = tokens[2].split(',').map(s => s.trim()).filter(Boolean);
  }
  return result;
}

// ===== Analytics Feedback Loop Handlers =====

/**
 * Parse a flexible time format into seconds.
 * Accepts:
 *   "3.5"      → 3.5
 *   "3.5s"     → 3.5
 *   "6m 49s"   → 409
 *   "6m49s"    → 409
 *   "1:23"     → 83
 *   "1h 5m 12s" → 3912
 */
function parseTimeToSeconds(input) {
  if (input === undefined || input === null) return NaN;
  const s = String(input).trim().toLowerCase();
  if (!s) return NaN;

  // Pure number (possibly with single trailing 's')
  const pure = s.match(/^(\d+(?:\.\d+)?)\s*s?$/);
  if (pure) return parseFloat(pure[1]);

  // hh:mm:ss or mm:ss format
  const colon = s.match(/^(\d+):(\d+)(?::(\d+))?$/);
  if (colon) {
    const a = parseInt(colon[1], 10);
    const b = parseInt(colon[2], 10);
    const c = colon[3] ? parseInt(colon[3], 10) : 0;
    if (colon[3]) return a * 3600 + b * 60 + c;  // h:m:s
    return a * 60 + b;                            // m:s
  }

  // Composite format like "6m 49s" or "1h 5m 12s"
  let total = 0;
  const hMatch = s.match(/(\d+(?:\.\d+)?)\s*h\b/);
  const mMatch = s.match(/(\d+(?:\.\d+)?)\s*m\b/);
  const sMatch = s.match(/(\d+(?:\.\d+)?)\s*s\b/);
  if (hMatch) total += parseFloat(hMatch[1]) * 3600;
  if (mMatch) total += parseFloat(mMatch[1]) * 60;
  if (sMatch) total += parseFloat(sMatch[1]);
  if (total > 0) return total;

  return NaN;
}

/**
 * /weekly_stats
 * 1. views=109 watch=3.5         (3.5s avg per viewer)
 * 2. views=300 totalwatch=6m 49s  (total watch time, will auto-compute avg)
 * 3. views=500 watch=1:23         (1m23s avg — unusual but supported)
 * ...
 *
 * Matches each numbered line to the corresponding reel in the latest
 * pending_check_ins row. No Concept ID required from user.
 */
async function handleWeeklyStats(chatId, text) {
  const db = dbModule.getClient();

  // Fetch the latest pending check-in
  const { data: pending } = await db.from('pending_check_ins')
    .select('key, items, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!pending) {
    await reply(chatId,
      '❌ No pending weekly check-in found.\n\n' +
      'The check-in is created automatically every Sunday at 7 PM IST. ' +
      'If you need to log stats manually, use `/stats_<id> v=<views> w=<watch_sec>`.'
    );
    return;
  }

  const items = pending.items;
  if (!Array.isArray(items) || items.length === 0) {
    await reply(chatId, '❌ No pending items in this check-in.');
    return;
  }

  // Parse the message line by line
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const results = [];
  const errors = [];

  for (const line of lines) {
    // Match patterns like "1. views=109 watch=3.5" or "1. Some title | views=109 watch=3.5"
    const numberMatch = line.match(/^(\d+)\b/);
    if (!numberMatch) continue;
    const idx = parseInt(numberMatch[1], 10) - 1;
    if (idx < 0 || idx >= items.length) {
      errors.push(`Line "${line.slice(0, 50)}": no reel at position ${idx + 1}`);
      continue;
    }

    // Extract views
    const viewsMatch = line.match(/views?\s*=\s*(\d+)/i);
    if (!viewsMatch) {
      errors.push(`Line ${idx + 1}: missing \`views=\``);
      continue;
    }
    const views = parseInt(viewsMatch[1], 10);

    // Extract watch time — supports flexible formats. Capture everything up to the
    // next " key=" or end-of-line.
    const watchMatch = line.match(/\b(totalwatch|total_watch|tw|watch_total)\s*=\s*([^=]+?)(?=\s+\w+\s*=|$)/i);
    const avgWatchMatch = line.match(/\b(watch|avgwatch|avg_watch|aw|w)\s*=\s*([^=]+?)(?=\s+\w+\s*=|$)/i);

    let watchSec;
    if (watchMatch) {
      // User gave total watch time. Auto-compute average.
      const totalSec = parseTimeToSeconds(watchMatch[2]);
      if (isNaN(totalSec) || views === 0) {
        errors.push(`Line ${idx + 1}: could not parse totalwatch=\`${watchMatch[2]}\``);
        continue;
      }
      watchSec = totalSec / views;
    } else if (avgWatchMatch) {
      watchSec = parseTimeToSeconds(avgWatchMatch[2]);
      if (isNaN(watchSec)) {
        errors.push(`Line ${idx + 1}: could not parse watch=\`${avgWatchMatch[2]}\``);
        continue;
      }
    } else {
      errors.push(`Line ${idx + 1}: missing \`watch=<sec>\` or \`totalwatch=<time>\``);
      continue;
    }

    if (isNaN(views) || isNaN(watchSec)) {
      errors.push(`Line ${idx + 1}: invalid numbers`);
      continue;
    }

    // Optional fields: likes, comments, shares, saves
    const likesMatch = line.match(/likes?\s*=\s*(\d+)/i);
    const commentsMatch = line.match(/comments?\s*=\s*(\d+)/i);
    const sharesMatch = line.match(/shares?\s*=\s*(\d+)/i);
    const savesMatch = line.match(/saves?\s*=\s*(\d+)/i);

    const item = items[idx];
    results.push({
      idx: idx + 1,
      concept_id: item.concept_id,
      framework: item.framework,
      title: item.title,
      duration: item.duration,
      views,
      avg_watch_sec: watchSec,
      likes: likesMatch ? parseInt(likesMatch[1], 10) : 0,
      comments: commentsMatch ? parseInt(commentsMatch[1], 10) : 0,
      shares: sharesMatch ? parseInt(sharesMatch[1], 10) : 0,
      saves: savesMatch ? parseInt(savesMatch[1], 10) : 0,
    });
  }

  if (results.length === 0) {
    await reply(chatId,
      '❌ Could not parse any lines. Expected format:\n\n' +
      '`/weekly_stats`\n`1. views=109 watch=3.5`\n`2. views=300 watch=6.2`'
    );
    return;
  }

  // Insert all the rows
  const records = results.map(r => ({
    concept_id: r.concept_id,
    framework: r.framework || 'unknown',
    views: r.views,
    avg_watch_sec: r.avg_watch_sec,
    reel_duration: r.duration,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares,
    saves: r.saves,
    followers_gained: 0,
    recorded_at: new Date().toISOString(),
  }));

  const { error: insErr } = await db.from('reel_performance').insert(records);
  if (insErr) {
    await reply(chatId, `❌ DB insert failed: ${insErr.message}`);
    return;
  }

  // Clear the pending check-in
  await db.from('pending_check_ins').delete().eq('key', pending.key);

  // Build the confirmation message with retention %
  let confirm = `✅ *Logged ${results.length} reel performance entries*\n\n`;
  for (const r of results) {
    const retention = r.duration > 0
      ? Math.min(100, (r.avg_watch_sec / r.duration) * 100).toFixed(1)
      : '?';
    confirm += `${r.idx}. ${r.title.slice(0, 30)}\n`;
    confirm += `   → ${r.views} views, ${r.avg_watch_sec}s watch, *${retention}%* retention\n\n`;
  }
  if (errors.length > 0) {
    confirm += `⚠️ ${errors.length} line(s) had errors:\n` + errors.join('\n');
  }
  confirm += '\n_LLM will favor high-retention frameworks in next ideation._';
  await reply(chatId, confirm);
}

/**
 * /stats_<id-prefix> v=<views> w=<avg_watch_sec> [l=<likes>] [c=<comments>] [s=<shares>] [sv=<saves>] [f=<followers_gained>]
 * Example: /stats_f6c7c97b v=109 w=3.5 l=4 c=2
 * This logs Instagram performance for a specific reel into reel_performance.
 */
async function handleStats(chatId, text) {
  const db = dbModule.getClient();

  // Parse the command. First token after /stats_ is the concept ID prefix.
  const afterCmd = text.replace(/^\/stats[_ ]/, '').trim();
  const firstSpace = afterCmd.search(/\s/);
  if (firstSpace < 0) {
    await reply(chatId,
      '❌ Usage: `/stats_<concept-id> v=<views> w=<watch_sec>`\n' +
      'Or: `/stats_<concept-id> v=<views> totalwatch=<time>`\n' +
      '\nExamples:\n' +
      '`/stats_f6c7c97b v=109 w=3.5`\n' +
      '`/stats_f6c7c97b v=109 totalwatch=6m 49s`'
    );
    return;
  }
  const idPrefix = afterCmd.slice(0, firstSpace).trim();
  const rest = afterCmd.slice(firstSpace).trim();

  // Parse key=value pairs where values can contain spaces (e.g. "6m 49s").
  // Strategy: walk through the string, finding each "key=" marker, and capture
  // everything up to the next "<word>=" marker or end-of-string.
  const params = {};
  const kvRegex = /(\w+)\s*=\s*([^=]+?)(?=\s+\w+\s*=|$)/g;
  let m;
  while ((m = kvRegex.exec(rest)) !== null) {
    params[m[1].toLowerCase()] = m[2].trim();
  }

  const viewsRaw = params.v || params.views;
  if (!viewsRaw) {
    await reply(chatId, '❌ Missing `v=<views>`.');
    return;
  }
  const views = parseInt(viewsRaw, 10) || 0;

  // Watch time: accept either `w=` (avg seconds) OR `totalwatch=` / `tw=` (total time, will auto-divide)
  let avgWatchSec = NaN;
  const totalWatchRaw = params.totalwatch || params.tw || params.total_watch;
  const avgWatchRaw = params.w || params.watch || params.aw;

  if (totalWatchRaw) {
    const total = parseTimeToSeconds(totalWatchRaw);
    if (isNaN(total) || views === 0) {
      await reply(chatId, `❌ Could not parse totalwatch=\`${totalWatchRaw}\` or views is zero.`);
      return;
    }
    avgWatchSec = total / views;
  } else if (avgWatchRaw) {
    avgWatchSec = parseTimeToSeconds(avgWatchRaw);
    if (isNaN(avgWatchSec)) {
      await reply(chatId, `❌ Could not parse watch=\`${avgWatchRaw}\`. Use a number (3.5) or time format (1:23).`);
      return;
    }
  } else {
    await reply(chatId, '❌ Missing watch time. Provide either `w=<avg_seconds>` (e.g., `w=3.5`) or `totalwatch=<time>` (e.g., `totalwatch=6m 49s`).');
    return;
  }

  // Find the concept by id prefix. Can't use .ilike on uuid columns
  // (Postgres rejects with 'operator does not exist: uuid ~~* unknown').
  // Workaround: fetch recent rows and filter by prefix in JS.
  const { data: allConcepts } = await db.from('reel_concepts')
    .select('id, title, angle, estimated_seconds, video_url')
    .order('created_at', { ascending: false })
    .limit(200);
  const concepts = (allConcepts || []).filter(c => c.id.startsWith(idPrefix.toLowerCase())).slice(0, 2);
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
    views,
    avg_watch_sec: avgWatchSec,
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
