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

    // CAS (Compare-And-Set): only succeed if state is still pre-render.
  // Prevents two concurrent /pick commands from both spawning orchestrators.
  const { data: claimedRows } = await db.from('content_calendar')
    .update({
      concept_id: match.id,
      state: 'picked',
      picked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', calRow.id)
    .in('state', ['ready', 'pending', 'failed'])  // exclude 'picked' and 'rendering' to prevent re-claiming
    .select('id');
  if (!claimedRows || claimedRows.length === 0) {
    return reply(chatId, `⚠️ Pick lost the race — another /pick or render is already in progress for today.`);
  }
  // Only after we WIN the CAS do we touch the concepts table
  await db.from('reel_concepts').update({ is_winner: false }).eq('target_date', today);
  await db.from('reel_concepts').update({ is_winner: true }).eq('id', match.id);
  await reply(chatId,
    `✅ *Picked Concept ${match.angle?.toUpperCase() || '?'}*: ${match.title || match.hook || ''}\n\n` +
    `🎬 Render started in background.\n` +
    `⏱ Expect ~10 min.\n` +
    `I'll ping you with the URL + caption when ready.`
  );
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

    // CAS: prevents cron + manual /go (or rapid /go /go) from both spawning.
  const { data: claimedRows } = await db.from('content_calendar')
    .update({
      state: 'picked',
      picked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', calRow.id)
    .in('state', ['ready', 'pending', 'failed'])  // exclude 'picked' and 'rendering' to prevent re-claiming
    .select('id');
  if (!claimedRows || claimedRows.length === 0) {
    return reply(chatId, `⚠️ Lost the race — another /go is already firing the orchestrator for today.`);
  }
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
      if (!msg) continue;
      const chatId = msg.chat.id;
      // Allow only the configured chat (or any if not set, for testing)
      if (TELEGRAM_CHAT_ID && String(chatId) !== String(TELEGRAM_CHAT_ID)) {
        log.warn(`Ignoring message from chat ${chatId} (not the configured chat)`);
        continue;
      }

      // Audio/video/voice forwarded for dance mode
      if (msg.audio || msg.video || msg.voice || msg.video_note) {
        await handleForwardedAudio(chatId, msg);
        continue;
      }

      if (!msg.text) continue;
      const text = msg.text.trim();
      log.info(`[${chatId}] ${text}`);

      // Detect Instagram URL (any text containing instagram.com URL)
      const igMatch = text.match(/https?:\/\/(?:www\.)?instagram\.com\/[^\s]+/i);
      if (igMatch) {
        await handleInstagramUrlAudio(chatId, igMatch[0]);
        continue;
      }

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
      } else if (text === '/home' || text.startsWith('/home ')) {
        await handleHome(chatId);
      } else if (text === '/dance' || text.startsWith('/dance ')) {
        await handleDance(chatId);
      } else if (text === '/inspire' || text.startsWith('/inspire ')) {
        await handleInspire(chatId);
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

  // Composite format. Accepts BOTH compact and verbose unit names:
  //   "6m 49s"                  -> 409
  //   "6 min 49 sec"            -> 409
  //   "6 minutes 49 seconds"    -> 409
  //   "1h 5m 12s"               -> 3912
  //   "1 hour 5 minutes 12 seconds" -> 3912
  //   "28 minutes 34 seconds"   -> 1714
  //
  // Order matters: match HOURS first (hours/hour/hrs/hr/h), then MINUTES
  // (minutes/minute/mins/min/m), then SECONDS (seconds/second/secs/sec/s).
  // Each regex looks for a number followed by an optional space and the unit
  // word, with a word boundary so "49s" still matches without eating the 's'
  // of "seconds".
  let total = 0;
  let matched = false;
  const hMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/);
  const mMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/);
  const sMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/);
  if (hMatch) { total += parseFloat(hMatch[1]) * 3600; matched = true; }
  if (mMatch) { total += parseFloat(mMatch[1]) * 60;   matched = true; }
  if (sMatch) { total += parseFloat(sMatch[1]);        matched = true; }
  if (matched) return total;

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
  // We fetch BOTH video_duration (the actual rendered length, populated by
  // video_worker after sql/025) and estimated_seconds (the LLM's guess,
  // legacy fallback). The real duration takes priority.
  let allConcepts = null;
  try {
    const r = await db.from('reel_concepts')
      .select('id, title, angle, estimated_seconds, video_duration, video_url')
      .order('created_at', { ascending: false })
      .limit(200);
    allConcepts = r.data;
  } catch {
    // video_duration column not present yet — fall back to old query
    const r = await db.from('reel_concepts')
      .select('id, title, angle, estimated_seconds, video_url')
      .order('created_at', { ascending: false })
      .limit(200);
    allConcepts = r.data;
  }
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

  // Prefer the actual rendered duration over the LLM's estimate.
  // The reel_duration column on reel_performance is what gets used to
  // compute retention_pct. If we use estimated_seconds (always 12) but the
  // real reel was 18s, retention shows ~100% when it should be ~63%.
  const realDuration = Number(concept.video_duration) || null;
  const reelDuration = realDuration || concept.estimated_seconds || null;

  // Insert into reel_performance
  const record = {
    concept_id: concept.id,
    framework: concept.angle || 'unknown',
    views,
    avg_watch_sec: avgWatchSec,
    reel_duration: reelDuration,
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

  // Compute retention pct for the reply. NOTE: we do NOT cap at 100% in the
  // displayed value (the DB still does for the stored column), so if the user
  // reports a number that exceeds 100% they know something's off (likely a
  // wrong duration source). We also flag if we fell back to the LLM estimate.
  const durationSource = realDuration ? 'actual' : 'estimated';
  const retention = record.reel_duration > 0
    ? ((record.avg_watch_sec / record.reel_duration) * 100).toFixed(1)
    : '?';
  const avgWatchDisplay = (Math.round(record.avg_watch_sec * 10) / 10).toFixed(1);

  await reply(chatId,
    `✅ *Performance Logged*\n\n` +
    `Reel: ${concept.title}\n` +
    `Framework: \`${record.framework}\`\n` +
    `Views: ${record.views}\n` +
    `Avg Watch: ${avgWatchDisplay}s of ${record.reel_duration || '?'}s reel (${durationSource} duration)\n` +
    `Retention: ${retention}%\n` +
    `Likes/Comments/Shares/Saves: ${record.likes}/${record.comments}/${record.shares}/${record.saves}\n\n` +
    (durationSource === 'estimated'
      ? `_⚠️ Used LLM-estimated duration (${record.reel_duration}s). Render this reel after the sql/025 migration is applied for accurate retention._\n\n`
      : ''
    ) +
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

// =============================================================================
// /home  — set both Sat & Sun lifestyle reels to be set in Bandra/Mumbai
// =============================================================================
async function handleHome(chatId) {
  const db = dbModule.getClient();
  const { sat, sun } = nextWeekendDates();
  const updates = [];
  for (const date of [sat, sun]) {
    const { data } = await db.from('content_calendar')
      .upsert({
        target_date: date,
        weekday: new Date(date).getDay(),
        content_type: 'lifestyle_reel',
        weekend_mode: 'home',
        dance_audio_url: null,
        dance_audio_filename: null,
        state: 'pending',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'target_date,content_type' })
      .select('id, target_date');
    if (data) updates.push(data[0]);
  }
  // Also wipe any pending audio uploads (user changed their mind)
  await db.from('pending_audio_uploads')
    .update({ status: 'cancelled' })
    .eq('chat_id', chatId)
    .eq('status', 'awaiting');
  await reply(chatId,
    `🏠 *Home mode locked in.*\n\n` +
    `Both Saturday and Sunday lifestyle reels will be set in Bandra/Mumbai.\n\n` +
    `Sat (${sat}) and Sun (${sun}) are queued.`
  );
}

// =============================================================================
// /inspire  — set both Sat & Sun reels to be RHEA-VERSIONS of a forwarded reel
// (vision-LLM analyzes a reference reel → Rhea renders own version with same vibe + same audio)
async function handleInspire(chatId) {
  const db = dbModule.getClient();
  const { sat, sun } = nextWeekendDates();

  // Mark both calendar rows as inspire mode (refs filled later)
  for (const date of [sat, sun]) {
    await db.from('content_calendar')
      .upsert({
        target_date: date,
        weekday: new Date(date).getDay(),
        content_type: 'lifestyle_reel',
        weekend_mode: 'inspire',
        inspire_video_url: null,
        inspire_audio_url: null,
        inspire_analysis_json: null,
        inspire_source_label: null,
        state: 'pending',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'target_date,content_type' });
  }

  // Wipe any prior pending uploads from this chat
  await db.from('pending_audio_uploads')
    .update({ status: 'cancelled' })
    .eq('chat_id', chatId)
    .eq('status', 'awaiting');

  // Create two pending upload rows: Sat first, then Sun. We reuse the
  // pending_audio_uploads table but flag weekend_mode='inspire' so the
  // forwarded-video handler routes to the inspire path.
  await db.from('pending_audio_uploads').insert([
    { chat_id: chatId, for_date: sat, weekend_mode: 'inspire', status: 'awaiting' },
    { chat_id: chatId, for_date: sun, weekend_mode: 'inspire', status: 'awaiting' },
  ]);

  await reply(chatId,
    `✨ *Inspire mode locked in.*\n\n` +
    `Forward me TWO reference reels (one for each day). I'll analyze each one and have Rhea render her own version of the same vibe with the same audio.\n\n` +
    `*Step 1 of 2:* Forward (or paste an Instagram URL for) the reel you want for *Saturday's* (${sat}) post.\n\n` +
    `_To forward an audio: open Instagram → Reel → Share icon → Telegram → Rhea Bot. Or paste any IG reel URL._`
  );
}

// /dance  — set both Sat & Sun reels to be lip-synced dance reels
// User must then forward TWO audio files (one for Sat, one for Sun)
// =============================================================================
async function handleDance(chatId) {
  const db = dbModule.getClient();
  const { sat, sun } = nextWeekendDates();

  // Mark both calendar rows as dance mode (audio_url will be filled later)
  for (const date of [sat, sun]) {
    await db.from('content_calendar')
      .upsert({
        target_date: date,
        weekday: new Date(date).getDay(),
        content_type: 'lifestyle_reel',
        weekend_mode: 'dance',
        dance_audio_url: null,
        dance_audio_filename: null,
        state: 'pending',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'target_date,content_type' });
  }

  // Wipe any prior pending uploads from this chat
  await db.from('pending_audio_uploads')
    .update({ status: 'cancelled' })
    .eq('chat_id', chatId)
    .eq('status', 'awaiting');

  // Create two pending upload rows: Sat first, then Sun
  await db.from('pending_audio_uploads').insert([
    { chat_id: chatId, for_date: sat, weekend_mode: 'dance', status: 'awaiting' },
    { chat_id: chatId, for_date: sun, weekend_mode: 'dance', status: 'awaiting' },
  ]);

  await reply(chatId,
    `💃 *Dance mode locked in.*\n\n` +
    `I'll need TWO audio files (one for each day).\n\n` +
    `*Step 1 of 2:* Forward the audio you want for *Saturday's* (${sat}) dance reel now.\n\n` +
    `_To forward an audio: open Instagram → Reel → Share icon → Telegram → Rhea Bot_`
  );
}

// =============================================================================
// handleForwardedAudio — user forwarded an audio/video. Resolve next pending.
// =============================================================================
async function handleForwardedAudio(chatId, msg) {
  const db = dbModule.getClient();
  // Find the next awaiting upload for this chat
  const { data: pending } = await db.from('pending_audio_uploads')
    .select('*')
    .eq('chat_id', chatId)
    .eq('status', 'awaiting')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) {
    await reply(chatId,
      `ℹ️ I received an audio/video, but I'm not waiting for one right now.\n\n` +
      `If you want to use this for a dance reel, type /dance first.\n` +
      `If you want Rhea to render her own version of a reel, type /inspire first.`
    );
    return;
  }

  // Route to inspire path if this pending row is inspire mode
  if (pending.weekend_mode === 'inspire') {
    return handleForwardedInspireVideo(chatId, msg, pending);
  }

  // Get file_id from the message (audio, video, voice, or video_note)
  const fileObj = msg.audio || msg.video || msg.voice || msg.video_note;
  if (!fileObj || !fileObj.file_id) {
    await reply(chatId, `❌ Could not extract file from forwarded message.`);
    return;
  }

  // Get file path from Telegram
  let filePath;
  try {
    const fileInfo = await axios.get(`${API}/getFile`, { params: { file_id: fileObj.file_id } });
    filePath = fileInfo.data.result.file_path;
  } catch (err) {
    await reply(chatId, `❌ Telegram file lookup failed: ${err.message}`);
    return;
  }

  const fileName = (fileObj.file_name || filePath.split('/').pop() || `audio-${Date.now()}.mp4`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

  // Download to /tmp, then upload to Supabase Storage
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const tmpIn = path.join('/tmp', `tg-${Date.now()}-${fileName}`);
  const tmpOut = path.join('/tmp', `tg-${Date.now()}-${fileName}.mp3`);

  try {
    const dl = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 120_000 });
    fs.writeFileSync(tmpIn, Buffer.from(dl.data));
  } catch (err) {
    await reply(chatId, `❌ File download failed: ${err.message}`);
    return;
  }

  // Extract audio with ffmpeg (handles video, audio, voice all the same)
  const ff = spawnSync('ffmpeg', ['-y', '-i', tmpIn, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', tmpOut], { stdio: 'pipe' });
  if (ff.status !== 0 || !fs.existsSync(tmpOut)) {
    await reply(chatId, `❌ ffmpeg audio extraction failed (exit ${ff.status}).`);
    try { fs.unlinkSync(tmpIn); } catch {}
    return;
  }

  // Upload to Supabase Storage
  const buf = fs.readFileSync(tmpOut);
  const storagePath = `dance-audio/${pending.for_date}/${Date.now()}.mp3`;
  const { error: upErr } = await db.storage.from('avi-images')
    .upload(storagePath, buf, { contentType: 'audio/mpeg', upsert: true, cacheControl: '31536000' });

  // Cleanup tmp
  try { fs.unlinkSync(tmpIn); } catch {}
  try { fs.unlinkSync(tmpOut); } catch {}

  if (upErr) {
    await reply(chatId, `❌ Supabase upload failed: ${upErr.message}`);
    return;
  }

  const { data: pub } = db.storage.from('avi-images').getPublicUrl(storagePath);

  // Update calendar row + mark pending row as resolved
  await db.from('content_calendar')
    .update({
      dance_audio_url: pub.publicUrl,
      dance_audio_filename: fileName,
      updated_at: new Date().toISOString(),
    })
    .eq('target_date', pending.for_date)
    .eq('content_type', 'lifestyle_reel');

  await db.from('pending_audio_uploads')
    .update({
      status: 'received',
      audio_url: pub.publicUrl,
      audio_filename: fileName,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', pending.id);

  // Are there more pending uploads?
  const { data: nextPending } = await db.from('pending_audio_uploads')
    .select('for_date')
    .eq('chat_id', chatId)
    .eq('status', 'awaiting')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (nextPending) {
    const isSun = new Date(nextPending.for_date).getDay() === 0;
    await reply(chatId,
      `✅ Saved audio for *${pending.for_date}*: \`${fileName}\`\n\n` +
      `*Step 2 of 2:* Forward the audio for *${isSun ? 'Sunday' : 'next day'}'s* (${nextPending.for_date}) dance reel now.`
    );
  } else {
    await reply(chatId,
      `✅ *Both audios locked in.*\n\n` +
      `Most recent: ${pending.for_date} → \`${fileName}\`\n\n` +
      `Renders fire automatically Sat 8 AM and Sun 8 AM IST.`
    );
  }
}

// =============================================================================
// handleInstagramUrlAudio — user pasted an Instagram Reel/audio URL.
// Use yt-dlp to download, extract audio with ffmpeg, then resolve next pending.
// =============================================================================
async function handleInstagramUrlAudio(chatId, url) {
  const db = dbModule.getClient();

  // Find the next awaiting upload for this chat
  const { data: pending } = await db.from('pending_audio_uploads')
    .select('*')
    .eq('chat_id', chatId)
    .eq('status', 'awaiting')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) {
    await reply(chatId,
      `ℹ️ I see an Instagram URL, but I'm not waiting for an audio right now.\n\n` +
      `Type /dance first if you want to use this for the next weekend's dance reels, or /inspire to have Rhea render her own version.`
    );
    return;
  }

  // Route to inspire path if this pending row is inspire mode
  if (pending.weekend_mode === 'inspire') {
    return handleInstagramUrlInspire(chatId, url, pending);
  }

  await reply(chatId, `⬇️ Downloading audio from Instagram… (this can take ~30s if Meta is slow)`);

  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const tmpStem = path.join('/tmp', `ig-${Date.now()}`);
  const tmpVid = `${tmpStem}.mp4`;
  const tmpMp3 = `${tmpStem}.mp3`;

  // Step 1: download with yt-dlp (must be installed on the VM)
  const dl = spawnSync('yt-dlp', ['-f', 'best', '-o', tmpVid, url], { encoding: 'utf8', timeout: 90_000 });
  if (dl.status !== 0 || !fs.existsSync(tmpVid)) {
    await reply(chatId,
      `❌ yt-dlp could not download from this URL. Instagram sometimes blocks scraping.\n\n` +
      `_Fallback:_ open the Reel in Instagram → Share icon → Telegram → forward to me.`
    );
    log.warn(`yt-dlp failed: ${dl.stderr?.slice(0, 300) || 'no stderr'}`);
    return;
  }

  // Step 2: extract audio with ffmpeg
  const ff = spawnSync('ffmpeg', ['-y', '-i', tmpVid, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', tmpMp3], { stdio: 'pipe' });
  if (ff.status !== 0 || !fs.existsSync(tmpMp3)) {
    await reply(chatId, `❌ ffmpeg audio extraction failed.`);
    try { fs.unlinkSync(tmpVid); } catch {}
    return;
  }

  // Step 3: upload to Supabase Storage
  const buf = fs.readFileSync(tmpMp3);
  const fileName = `instagram-${Date.now()}.mp3`;
  const storagePath = `dance-audio/${pending.for_date}/${fileName}`;
  const { error: upErr } = await db.storage.from('avi-images')
    .upload(storagePath, buf, { contentType: 'audio/mpeg', upsert: true, cacheControl: '31536000' });

  // Cleanup
  try { fs.unlinkSync(tmpVid); } catch {}
  try { fs.unlinkSync(tmpMp3); } catch {}

  if (upErr) {
    await reply(chatId, `❌ Supabase upload failed: ${upErr.message}`);
    return;
  }

  const { data: pub } = db.storage.from('avi-images').getPublicUrl(storagePath);

  // Step 4: link to calendar row + mark pending row resolved
  await db.from('content_calendar')
    .update({
      dance_audio_url: pub.publicUrl,
      dance_audio_filename: fileName,
      updated_at: new Date().toISOString(),
    })
    .eq('target_date', pending.for_date)
    .eq('content_type', 'lifestyle_reel');

  await db.from('pending_audio_uploads')
    .update({
      status: 'received',
      audio_url: pub.publicUrl,
      audio_filename: fileName,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', pending.id);

  // Are there more pending uploads?
  const { data: nextPending } = await db.from('pending_audio_uploads')
    .select('for_date')
    .eq('chat_id', chatId)
    .eq('status', 'awaiting')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (nextPending) {
    const isSun = new Date(nextPending.for_date).getDay() === 0;
    await reply(chatId,
      `✅ Saved IG audio for *${pending.for_date}*\n\n` +
      `*Step 2 of 2:* Forward (or paste an IG URL for) the audio for *${isSun ? 'Sunday' : 'next day'}'s* (${nextPending.for_date}) dance reel.`
    );
  } else {
    await reply(chatId,
      `✅ *Both audios locked in.*\n\n` +
      `Renders fire automatically Sat 8 AM and Sun 8 AM IST.`
    );
  }
}

// =============================================================================
// INSPIRE MODE HANDLERS
// =============================================================================

/**
 * Shared: take a local mp4 file path, run the full inspire pipeline:
 *   1. Upload original mp4 to Supabase (so the worker can reference it)
 *   2. Extract audio with ffmpeg, upload to Supabase
 *   3. Call inspire_analyzer (Gemini Vision) to get the Rhea brief
 *   4. Persist video_url + audio_url + analysis JSON onto the calendar row
 *   5. Mark pending row resolved, prompt user for next pending or end
 */
async function processInspireSource(chatId, pending, localMp4Path, sourceLabel) {
  const db = dbModule.getClient();
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');

  await reply(chatId, `🧐 Analyzing the reference reel… (Gemini Vision can take ~60s)`);

  const stem = path.basename(localMp4Path, path.extname(localMp4Path));
  const tmpMp3 = path.join('/tmp', `${stem}.mp3`);

  // 2. Extract audio
  const ff = spawnSync('ffmpeg', ['-y', '-i', localMp4Path, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', tmpMp3], { stdio: 'pipe' });
  if (ff.status !== 0 || !fs.existsSync(tmpMp3)) {
    await reply(chatId, `❌ ffmpeg audio extraction failed.`);
    return;
  }

  // 1+2. Upload BOTH the original mp4 and the extracted mp3 to Supabase
  const tsBase = Date.now();
  const videoStoragePath = `inspire-source/${pending.for_date}/${tsBase}.mp4`;
  const audioStoragePath = `inspire-source/${pending.for_date}/${tsBase}.mp3`;

  const videoBuf = fs.readFileSync(localMp4Path);
  const { error: vupErr } = await db.storage.from('avi-images')
    .upload(videoStoragePath, videoBuf, { contentType: 'video/mp4', upsert: true, cacheControl: '31536000' });
  if (vupErr) {
    await reply(chatId, `❌ Supabase video upload failed: ${vupErr.message}`);
    return;
  }

  const audioBuf = fs.readFileSync(tmpMp3);
  const { error: aupErr } = await db.storage.from('avi-images')
    .upload(audioStoragePath, audioBuf, { contentType: 'audio/mpeg', upsert: true, cacheControl: '31536000' });
  if (aupErr) {
    await reply(chatId, `❌ Supabase audio upload failed: ${aupErr.message}`);
    return;
  }

  const { data: vpub } = db.storage.from('avi-images').getPublicUrl(videoStoragePath);
  const { data: apub } = db.storage.from('avi-images').getPublicUrl(audioStoragePath);

  // 3. Call the analyzer
  let analysis = null;
  try {
    const { analyzeVideo } = require('../inspire/inspire_analyzer');
    analysis = await analyzeVideo({ localVideoPath: localMp4Path });
  } catch (e) {
    log.error(`inspire_analyzer failed: ${e.message}`);
    await reply(chatId, `❌ Vision analysis failed: ${e.message.slice(0, 300)}\n\nThe video and audio were saved, but I couldn't analyze the scene. Reply /inspire again to retry.`);
    return;
  } finally {
    try { fs.unlinkSync(tmpMp3); } catch {}
  }

  // 4. Persist on calendar row
  const { error: calErr } = await db.from('content_calendar').update({
    inspire_video_url: vpub.publicUrl,
    inspire_audio_url: apub.publicUrl,
    inspire_analysis_json: analysis,
    inspire_source_label: sourceLabel,
    updated_at: new Date().toISOString(),
  })
    .eq('target_date', pending.for_date)
    .eq('content_type', 'lifestyle_reel');
  if (calErr) {
    await reply(chatId, `❌ Calendar update failed: ${calErr.message}`);
    return;
  }

  // 5. Mark pending row resolved
  await db.from('pending_audio_uploads').update({
    status: 'received',
    audio_url: apub.publicUrl,
    audio_filename: sourceLabel,
    resolved_at: new Date().toISOString(),
  }).eq('id', pending.id);

  // 6. Reply with the analysis preview, prompt for next or end
  const moodLabel = analysis.music_mood || '?';
  const locLabel = (analysis.suggested_location || '').slice(0, 80);
  const summaryLabel = (analysis.scene_summary || '').slice(0, 150);

  await reply(chatId,
    `✅ *Saved + analyzed for ${pending.for_date}*\n\n` +
    `*Source:* \`${sourceLabel.slice(0, 40)}\`\n` +
    `*Mood:* ${moodLabel}\n` +
    `*Rhea will be:* ${locLabel}\n` +
    `*Scene:* ${summaryLabel}\n`
  );

  // Are there more pending uploads?
  const { data: nextPending } = await db.from('pending_audio_uploads')
    .select('for_date')
    .eq('chat_id', chatId)
    .eq('status', 'awaiting')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (nextPending) {
    const isSun = new Date(nextPending.for_date).getDay() === 0;
    await reply(chatId,
      `*Step 2 of 2:* Forward (or paste an IG URL for) the reel for *${isSun ? 'Sunday' : 'next day'}'s* (${nextPending.for_date}) inspire reel.`
    );
  } else {
    await reply(chatId,
      `✨ *Both inspire references locked in.*\n\n` +
      `Renders fire automatically Sat 8 AM and Sun 8 AM IST. Estimated cost ~₹50 per reel.`
    );
  }
}

/**
 * Forwarded video (Telegram) → inspire path.
 */
async function handleForwardedInspireVideo(chatId, msg, pending) {
  const fs = require('fs');
  const path = require('path');
  const fileObj = msg.video || msg.video_note || msg.audio || msg.voice;
  if (!fileObj || !fileObj.file_id) {
    await reply(chatId, `❌ Could not extract video from forwarded message.`);
    return;
  }

  // Download the file from Telegram
  let filePath;
  try {
    const fileInfo = await axios.get(`${API}/getFile`, { params: { file_id: fileObj.file_id } });
    filePath = fileInfo.data.result.file_path;
  } catch (err) {
    await reply(chatId, `❌ Telegram file lookup failed: ${err.message}`);
    return;
  }

  const fileName = (fileObj.file_name || filePath.split('/').pop() || `inspire-${Date.now()}.mp4`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
  const tmpIn = path.join('/tmp', `inspire-${Date.now()}-${fileName}`);

  try {
    const dl = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 120_000, maxContentLength: Infinity });
    fs.writeFileSync(tmpIn, Buffer.from(dl.data));
  } catch (err) {
    await reply(chatId, `❌ Video download failed: ${err.message}`);
    return;
  }

  try {
    await processInspireSource(chatId, pending, tmpIn, fileName);
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
  }
}

/**
 * Pasted Instagram URL → inspire path. yt-dlp → mp4 → processInspireSource.
 */
async function handleInstagramUrlInspire(chatId, url, pending) {
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');

  await reply(chatId, `⬇️ Downloading reference reel from Instagram (~30s)…`);

  const tmpStem = path.join('/tmp', `inspire-ig-${Date.now()}`);
  const tmpVid = `${tmpStem}.mp4`;
  const dl = spawnSync('yt-dlp', ['-f', 'best', '-o', tmpVid, url], { encoding: 'utf8', timeout: 90_000 });
  if (dl.status !== 0 || !fs.existsSync(tmpVid)) {
    await reply(chatId,
      `❌ yt-dlp could not download from this URL.\n\n` +
      `_Fallback:_ open the Reel in Instagram → Share → Telegram → forward to me.`
    );
    log.warn(`yt-dlp failed: ${dl.stderr?.slice(0, 300) || 'no stderr'}`);
    return;
  }

  try {
    await processInspireSource(chatId, pending, tmpVid, url);
  } finally {
    try { fs.unlinkSync(tmpVid); } catch {}
  }
}

// Returns next Saturday (and the following Sunday) as YYYY-MM-DD strings.
// If today is Sat or Sun, returns today's Sat (or yesterday's) and tomorrow's Sun.
function nextWeekendDates() {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun, 6=Sat
  let satOffset;
  if (dow === 6) satOffset = 0;          // today is Sat
  else if (dow === 0) satOffset = -1;     // today is Sun, Sat was yesterday
  else satOffset = 6 - dow;               // next Sat
  const sat = new Date(now); sat.setDate(now.getDate() + satOffset);
  const sun = new Date(sat); sun.setDate(sat.getDate() + 1);
  const fmt = d => d.toISOString().slice(0, 10);
  return { sat: fmt(sat), sun: fmt(sun) };
}

log.info('🤖 Telegram listener daemon starting...');
log.info(`   Bot: ${TELEGRAM_BOT_TOKEN.slice(0, 10)}…`);
log.info(`   Chat lock: ${TELEGRAM_CHAT_ID || '(none, accept all)'}`);
poll();
