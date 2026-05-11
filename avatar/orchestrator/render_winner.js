#!/usr/bin/env node
/**
 * EverythinInAI — Render Winner Orchestrator
 *
 * The single entry point that triggers a full content render based on the
 * content_calendar row's content_type:
 *   tech_reel       →  hero  → voice → lipsync → engagement-edit
 *   lure_photo      →  lure_photo_worker
 *   lifestyle_reel  →  lifestyle_worker
 *
 * On completion, sends the final URL + caption + hashtags to Telegram.
 *
 * Hard daily-cap is enforced by the UNIQUE constraint on content_calendar.
 *
 * Usage:
 *   node avatar/orchestrator/render_winner.js --calendar=<id>
 *   node avatar/orchestrator/render_winner.js --today        # auto-find today's row
 */

const { spawnSync } = require('child_process');
const path = require('path');
const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const { sendCompletionMessage } = require('./telegram_completion');

const log = createLogger('orchestrator');

const ROOT = path.resolve(__dirname, '../..');

function parseArgs(argv) {
  const args = { calendarId: null, today: false };
  for (const a of argv.slice(2)) {
    if (a === '--today') args.today = true;
    else if (a.startsWith('--calendar=')) args.calendarId = a.split('=')[1];
  }
  return args;
}

async function getCalendarRow(args) {
  const db = dbModule.getClient();
  if (args.calendarId) {
    const { data } = await db.from('content_calendar').select('*').eq('id', args.calendarId).maybeSingle();
    return data;
  }
  if (args.today) {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await db.from('content_calendar')
      .select('*')
      .eq('target_date', today)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data;
  }
  return null;
}

async function recordStep(calendarId, stepName, status, output = null, costUsd = 0, durationMs = 0, errMsg = null) {
  const db = dbModule.getClient();
  await db.from('render_steps').insert({
    calendar_id: calendarId,
    step_name: stepName,
    status,
    output: output || {},
    cost_usd: costUsd,
    duration_ms: durationMs,
    error_message: errMsg,
    completed_at: status === 'running' ? null : new Date().toISOString(),
  });
}

/**
 * Check if a step has already been completed for this calendar row.
 * Powers idempotency — prevents double-paying for steps that already succeeded
 * (e.g. orchestrator crashed after lipsync but before captions).
 */
async function isStepDone(calendarId, stepName) {
  const db = dbModule.getClient();
  const { data } = await db.from('render_steps')
    .select('id, status')
    .eq('calendar_id', calendarId)
    .eq('step_name', stepName)
    .eq('status', 'done')
    .limit(1)
    .maybeSingle();
  return !!data;
}

function runScript(scriptPath, args = []) {
  const start = Date.now();
  const r = spawnSync('node', [scriptPath, ...args], {
    cwd: ROOT,
    stdio: ['inherit', 'pipe', 'inherit'],
    timeout: 1_200_000,                   // 20 min cap per step
  });
  const durationMs = Date.now() - start;
  const stdout = r.stdout?.toString() || '';
  return { ok: r.status === 0, durationMs, stdout };
}

async function runTechReel(calendarRow) {
  const db = dbModule.getClient();
  log.info(`════ TECH REEL pipeline (idempotent) ════`);

  // Step 1: hero (skip if already done)
  if (await isStepDone(calendarRow.id, 'hero')) {
    log.info('[1/4] hero_worker SKIPPED (already done)');
  } else {
    log.info('[1/4] hero_worker --winner...');
    let r = runScript('avatar/imagery/hero_worker.js', ['--winner']);
    if (!r.ok) throw new Error('hero_worker failed');
    await recordStep(calendarRow.id, 'hero', 'done', { stdout: r.stdout.slice(-500) }, 0.025, r.durationMs);
  }

  // Step 2: voice (skip if already done)
  if (await isStepDone(calendarRow.id, 'voice')) {
    log.info('[2/4] voice_worker SKIPPED (already done)');
  } else {
    log.info('[2/4] voice_worker --winner...');
    let r = runScript('avatar/voice/voice_worker.js', ['--winner']);
    if (!r.ok) throw new Error('voice_worker failed');
    await recordStep(calendarRow.id, 'voice', 'done', { stdout: r.stdout.slice(-500) }, 0.03, r.durationMs);
  }

  // Step 3: lipsync (slow — expensive! Skip if already done)
  if (await isStepDone(calendarRow.id, 'lipsync')) {
    log.info('[3/4] lipsync_worker SKIPPED (already done) — saved ~$0.50');
  } else {
    log.info('[3/4] lipsync_worker --winner... (~3-5 min)');
    let r = runScript('avatar/video/lipsync_worker.js', ['--winner']);
    if (!r.ok) throw new Error('lipsync_worker failed');
    await recordStep(calendarRow.id, 'lipsync', 'done', { stdout: r.stdout.slice(-500) }, 0.50, r.durationMs);
  }

  // Step 4: engagement edit (skip if already done)
  if (await isStepDone(calendarRow.id, 'engagement')) {
    log.info('[4/4] video_worker SKIPPED (already done)');
  } else {
    log.info('[4/4] video_worker --winner...');
    let r = runScript('avatar/video/video_worker.js', ['--winner']);
    if (!r.ok) throw new Error('video_worker failed');
    await recordStep(calendarRow.id, 'engagement', 'done', { stdout: r.stdout.slice(-500) }, 0.01, r.durationMs);
  }

  // Read the final URL + caption from reel_concepts (linked via concept_id)
  const { data: concept } = await db.from('reel_concepts')
    .select('id, video_url, caption, hashtags')
    .eq('id', calendarRow.concept_id)
    .maybeSingle();

  if (!concept || !concept.video_url) throw new Error('Could not read final video_url from reel_concepts');
  // hashtags is text[] in DB; convert to space-prefixed string
  const hashtagsStr = Array.isArray(concept.hashtags)
    ? concept.hashtags.map(h => h.startsWith('#') ? h : '#' + h).join(' ')
    : (concept.hashtags || '');
  return {
    url: concept.video_url,
    caption: concept.caption || '',
    hashtags: hashtagsStr,
    type: 'video/mp4',
    costUsd: 0.565,
  };
}

async function runLurePhoto(calendarRow) {
  log.info(`════ LURE PHOTO pipeline ════`);
  const r = runScript('avatar/lure/lure_photo_worker.js', [`--calendar=${calendarRow.id}`]);
  if (!r.ok) throw new Error('lure_photo_worker failed');
  // Worker prints final JSON line; parse it
  const lastLine = r.stdout.trim().split('\n').pop();
  let data = {};
  try { data = JSON.parse(lastLine); } catch {}
  if (!data.ok) throw new Error('lure photo worker returned ok=false');
  await recordStep(calendarRow.id, 'lure_photo', 'done', data, 0.025, r.durationMs);
  return {
    url: data.url,
    caption: `${data.sceneLabel || 'Scene'} — Rhea Kapoor`,
    hashtags: '#rhea #ai #aitoolsdaily #everythininai #productivity #techreviewer',
    type: 'image/webp',
    costUsd: 0.025,
  };
}

async function runLifestyleReel(calendarRow) {
  log.info(`════ LIFESTYLE REEL pipeline ════`);
  // Prefer LLM-drafted concept (post-Phase 16) by passing the calendar id.
  // The worker will look up the concept via the calendar row's concept_id and use the LLM's keyframe_prompt + motion_prompt.
  // Falls back to hardcoded mood rotation if no concept exists.
  const moods = ['morning_routine', 'cafe', 'working', 'golden_hour', 'reading'];
  const week = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  const fallbackMood = moods[week % moods.length];
  log.info(`Calendar=${calendarRow.id}  fallbackMood=${fallbackMood}`);

  const r = runScript('avatar/lifestyle/lifestyle_worker.js', [
    `--calendar=${calendarRow.id}`,
    `--mood=${fallbackMood}`,
  ]);
  if (!r.ok) throw new Error('lifestyle_worker failed');

  // Lifestyle worker logs the URL but doesn't write to DB; we have to grep the stdout
  const m = r.stdout.match(/url\s*:\s*(https?:\/\/\S+)/);
  if (!m) throw new Error('Could not parse lifestyle Reel URL from worker output');
  const url = m[1];

  // Save to calendar row
  const db = dbModule.getClient();
  await db.from('content_calendar').update({
    output_url: url,
    state: 'done',
    completed_at: new Date().toISOString(),
    cost_usd: 0.10,
    updated_at: new Date().toISOString(),
  }).eq('id', calendarRow.id);

  await recordStep(calendarRow.id, 'lifestyle', 'done', { url, mood }, 0.10, r.durationMs);

  return {
    url,
    caption: `Slow Saturday vibes ✨\n\nA quiet morning, a coffee, and the time to actually think.\n\n— @rhea.builds`,
    hashtags: '#bandragirls #slowliving #morningroutine #rheabuilds #everythininai',
    type: 'video/mp4',
    costUsd: 0.10,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const db = dbModule.getClient();

  const row = await getCalendarRow(args);
  if (!row) { log.error('No calendar row. Pass --calendar=<id> or --today.'); process.exit(1); }

  if (row.state === 'done') {
    log.info(`Already done. URL: ${row.output_url}`);
    return;
  }
  if (row.state === 'rendering') {
    log.warn(`Calendar row already in rendering state — bailing.`);
    return;
  }
  if (row.content_type === 'tech_reel' && row.state !== 'picked') {
    log.error(`tech_reel calendar row must be in 'picked' state (current: ${row.state}). User has not selected a concept yet.`);
    process.exit(1);
  }

  // Mark rendering
  await db.from('content_calendar').update({
    state: 'rendering',
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', row.id);

  let result;
  try {
    if (row.content_type === 'tech_reel')        result = await runTechReel(row);
    else if (row.content_type === 'lure_photo')  result = await runLurePhoto(row);
    else if (row.content_type === 'lifestyle_reel') result = await runLifestyleReel(row);
    else throw new Error(`Unknown content_type: ${row.content_type}`);

    await db.from('content_calendar').update({
      state: 'done',
      output_url: result.url,
      caption: result.caption,
      hashtags: result.hashtags,
      cost_usd: result.costUsd,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', row.id);

    log.info(`══════════════════════════════════════════════`);
    log.info(`✓ ${row.content_type.toUpperCase()} READY for ${row.target_date}`);
    log.info(`   URL    : ${result.url}`);
    log.info(`   Cost   : ~$${result.costUsd.toFixed(3)}`);
    log.info(`══════════════════════════════════════════════`);

    // Telegram completion message
    await sendCompletionMessage({
      contentType: row.content_type,
      targetDate: row.target_date,
      url: result.url,
      caption: result.caption,
      hashtags: result.hashtags,
      type: result.type,
      costUsd: result.costUsd,
    });
  } catch (err) {
    log.error(`Pipeline failed: ${err.message}`);
    await db.from('content_calendar').update({
      state: 'failed',
      error_message: err.message,
      updated_at: new Date().toISOString(),
    }).eq('id', row.id);
    process.exit(1);
  }
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
