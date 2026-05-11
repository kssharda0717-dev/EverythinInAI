#!/usr/bin/env node
/**
 * EverythinInAI — Daily Ideation Orchestrator
 *
 * One-shot script. Runs end-to-end:
 *   1. Load active persona (Avi)
 *   2. Decide today's lure level (respecting weekly quota)
 *   3. Pick the top signal of the last 48h
 *   4. Draft 3 distinct concepts via Gemini
 *   5. Insert all 3 into reel_concepts (state='draft')
 *   6. Send concepts to Telegram for review
 *   7. Mark Concept A as the *provisional* winner (auto-pick fallback)
 *
 * If user replies "/pick_<id>" within 4h the winner flips to that concept
 * (handled by a separate watcher we'll wire up in Phase 8b).
 *
 * Usage:
 *   node avatar/ideation/run_daily.js
 *   node avatar/ideation/run_daily.js --dry-run        # don't write to db
 *   node avatar/ideation/run_daily.js --force-lure=4   # override lure choice
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');
const { pickTopSignals } = require('./signal_picker');
const { draftConcepts } = require('./concept_drafter');
const { sendConcepts, sendStatus } = require('./telegram_notify');
const { getContentTypeForDate, ensureTodaysCalendarRow } = require('../scheduler/weekly_planner');

const log = createLogger('ideation');

function parseArgs(argv) {
  const args = { dryRun: false, forceLure: null };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--force-lure=')) args.forceLure = parseInt(a.split('=')[1], 10);
  }
  return args;
}

async function getRecentLureCount(personaId, days = 7) {
  const db = dbModule.getClient();
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const { data } = await db
    .from('reel_concepts')
    .select('lure_level')
    .eq('persona_id', personaId)
    .eq('is_winner', true)
    .gte('target_date', since)
    .gte('lure_level', 3);
  return (data || []).length;
}

async function main() {
  const args = parseArgs(process.argv);
  const today = new Date().toISOString().slice(0, 10);

  log.info(`════════════════════════════════════════════════════════════════`);
  log.info(`Daily ideation run for ${today}${args.dryRun ? ' (DRY RUN)' : ''}`);
  log.info(`══════════════════════════════════════════════════════════════`);

  // Map content_type to our streamType for the LLM
  const { weekday, weekdayName, contentType } = getContentTypeForDate(new Date());
  log.info(`Today is ${weekdayName} → scheduled content type: ${contentType}`);
  
  let streamType = null;
  if (contentType === 'tech_reel') streamType = 'tech';
  else if (contentType === 'lure_photo') streamType = 'lure';
  else if (contentType === 'lifestyle_reel') streamType = 'lifestyle';

  if (!streamType) {
    log.warn(`Unknown content_type: ${contentType}. Skipping ideation.`);
    return;
  }

  // Ensure today's calendar row exists
  if (!args.dryRun) {
    try { await ensureTodaysCalendarRow(); } catch (e) { log.warn(`calendar ensure failed: ${e.message}`); }
  }

  // 1. Load persona
  const persona = await personaService.getActivePersona();
  log.info(`Persona: ${persona.display_name} (${persona.id})`);

  // 2. Decide lure level
  let lureLevel;
  if (args.forceLure !== null) {
    lureLevel = Math.min(args.forceLure, persona.max_lure_level);
    log.info(`Lure level FORCED to ${lureLevel}`);
  } else {
    const recentLure = await getRecentLureCount(persona.id);
    log.info(`Recent lure≥3 count in last 7 days: ${recentLure} / quota ${persona.weekly_lure_quota}`);
    lureLevel = await personaService.chooseLureLevel(recentLure);
    log.info(`Lure level for today: ${lureLevel}`);
  }

  // 3. Check if we already have a winner for today
  const db = dbModule.getClient();
  const { data: existingWinner } = await db
    .from('reel_concepts')
    .select('id, title, state')
    .eq('persona_id', persona.id)
    .eq('target_date', today)
    .eq('is_winner', true)
    .maybeSingle();

  if (existingWinner) {
    log.warn(`A winner already exists for ${today}: ${existingWinner.title} (state=${existingWinner.state}). Skipping.`);
    return;
  }

  // 4. Pick top signal (only required for tech stream)
  let chosen = null;
  if (streamType === 'tech') {
    const candidates = await pickTopSignals(persona.id, { limit: 1 });
    if (candidates.length === 0) {
      log.error('No signals available for tech ideation.');
      await sendStatus(`⚠ Ideation skipped — no fresh signals available for ${today}`);
      return;
    }
    chosen = candidates[0];
    log.info(`Chosen signal: [${chosen.signal.type}] ${chosen.signal.title} (score=${chosen.score})`);
  } else {
    // Lure / Lifestyle don't need a tech signal; we draft purely from frameworks + persona
    chosen = { signal: { id: null, type: streamType, title: `${streamType} ideation`, summary: '', url: '', entities: [], topics: [], avatar_angles: [], virality_score: 8 }, score: 0 };
    log.info(`Stream=${streamType}: drafting concepts purely from frameworks (no signal needed)`);
  }

  // 5. Draft concepts (LLM picks from active frameworks for this stream)
  const { concepts, meta } = await draftConcepts(chosen.signal, lureLevel, streamType);

  // 6. Persist concepts
  const conceptIds = [];
  if (!args.dryRun) {
    for (let i = 0; i < concepts.length; i++) {
      const c = concepts[i];
      const insert = {
        persona_id:        persona.id,
        signal_id:         chosen.signal.id,
        target_date:       today,
        content_type:      contentType,
        state:             'draft',
        is_winner:         false,
        title:             (c.title || `Concept ${String.fromCharCode(65 + i)}`).slice(0, 200),
        // Tech-stream fields
        hook:              c.hook || '',
        body_script:       c.body_script || '',
        punchline:         c.punchline || '',
        full_script:       c.full_script || (c.hook ? `${c.hook}\n\n${c.body_script}\n\n${c.punchline}` : ''),
        estimated_seconds: c.estimated_seconds || (streamType === 'tech' ? 12 : null),
        keyframes:         c.keyframes || [],
        cta:               c.cta || '',
        // Lure-stream field
        image_prompt:      c.image_prompt || null,
        // Lifestyle-stream fields
        keyframe_prompt:   c.keyframe_prompt || null,
        motion_prompt:     c.motion_prompt || null,
        music_mood:        c.music_mood || null,
        // Common fields
        caption:           c.caption || '',
        hashtags:          c.hashtags || [],
        lure_level:        c.lure_level || lureLevel,
        angle:             c.angle || 'unknown',
        model:             meta.model,
        prompt_tokens:     meta.prompt_tokens,
        output_tokens:     meta.output_tokens,
      };
      const { data, error } = await db.from('reel_concepts').insert(insert).select('id').single();
      if (error) {
        log.error(`Failed to insert concept ${i}: ${error.message}`);
        throw error;
      }
      conceptIds.push(data.id);
    }
    log.info(`✓ Inserted ${conceptIds.length} concepts into reel_concepts`);

    // NOTE: Auto-pick is deliberately removed. The user MUST reply /pick_<id>
    // in Telegram. If they don't, today's tech reel simply doesn't get rendered.
    // This is intentional cost-control (no surprise renders).
  } else {
    log.info('DRY-RUN: skipping db writes');
    concepts.forEach((c, i) => conceptIds.push(`dry-${i}`));
  }

  // 8. Notify via Telegram
  await sendConcepts(chosen.signal, concepts, conceptIds);

  log.info(`════════════════════════════════════════════════════════════════`);
  log.info(`✓ Ideation complete for ${today}`);
  log.info(`════════════════════════════════════════════════════════════════`);
}

main().catch(async (err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  try { await sendStatus(`✗ Ideation FAILED: ${err.message.slice(0, 300)}`); } catch {}
  process.exit(1);
});
