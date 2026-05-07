#!/usr/bin/env node
/**
 * EverythinInAI — Image Worker
 *
 * Renders all keyframes for a given Reel concept.
 *
 * Strategy:
 *   - keyframe[0] (the "hero" / scroll-stopper): rendered with flux-pulid
 *     using Avi's canonical face anchor → guaranteed face-locked, premium quality.
 *   - keyframes[1..N]: rendered with flux-pulid as well so Avi looks consistent
 *     across the entire Reel (face-lock is non-negotiable).
 *
 *   We could use schnell for B-roll for cheaper cost, but Flux Schnell does NOT
 *   support face conditioning, which would create "different girl in every frame"
 *   inconsistency. The right tradeoff is: pay $0.05 × 4 = $0.20/Reel to keep
 *   Avi's face locked end-to-end. Schnell is reserved for non-Avi B-roll
 *   (product screenshots, abstract scenes) — handled in Phase 11.
 *
 * Usage:
 *   node avatar/imagery/image_worker.js <concept_id>
 *   node avatar/imagery/image_worker.js --winner               # picks today's winner
 *   node avatar/imagery/image_worker.js --winner --date=2026-05-07
 *   node avatar/imagery/image_worker.js <concept_id> --dry-run
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');
const { runModel } = require('./replicate_client');
const { rehostImage } = require('./storage');

const log = createLogger('image_worker');

function parseArgs(argv) {
  const args = { conceptId: null, useWinner: false, date: null, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--winner') args.useWinner = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--date=')) args.date = a.split('=')[1];
    else if (!a.startsWith('--')) args.conceptId = a;
  }
  return args;
}

async function getConcept(db, args) {
  if (args.conceptId) {
    const { data, error } = await db.from('reel_concepts').select('*').eq('id', args.conceptId).maybeSingle();
    if (error) throw error;
    return data;
  }
  if (args.useWinner) {
    const date = args.date || new Date().toISOString().slice(0, 10);
    const { data, error } = await db.from('reel_concepts')
      .select('*')
      .eq('target_date', date)
      .eq('is_winner', true)
      .maybeSingle();
    if (error) throw error;
    return data;
  }
  return null;
}

function buildKeyframePrompt(persona, sceneDescription, sceneCaption) {
  // The persona descriptor is REPEATED in every prompt so PuLID has full context.
  // We deliberately don't put face details in the prompt — PuLID handles that
  // from the conditioning image. We only describe wardrobe + setting + scene.
  return [
    `A 25-year-old Indian woman content creator (Avi). Wheatish skin, long dark brown hair, athletic-feminine build.`,
    sceneDescription,
    `Wearing aesthetically curated outfit (ribbed knit top OR fitted blazer over silk camisole OR oversized cardigan), palette of beige / forest green / ivory / matte gold.`,
    `Indoor minimalist Bandra studio apartment OR cozy book-lined corner, soft warm light, plants, hardcover books, matte black laptop visible.`,
    `Editorial photograph, shot on Sony A7R IV, 35mm or 85mm lens, shallow depth of field, photorealistic, ultra-detailed skin texture with natural fine pores, subtle film grain, magazine-quality.`,
  ].join(' ');
}

async function renderKeyframe({ persona, anchorUrl, kf, idx, conceptId, dryRun }) {
  const sceneDesc = kf.prompt || `Standing thoughtfully, looking at the camera`;
  const fullPrompt = buildKeyframePrompt(persona, sceneDesc, kf.scene_caption);
  const negativePrompt = await personaService.buildNegativePrompt();

  if (dryRun) {
    log.info(`DRY: keyframe[${idx}] prompt = ${fullPrompt.substring(0, 200)}...`);
    return { skipped: true };
  }

  const seed = Math.floor(Math.random() * 1_000_000);

  const result = await runModel('flux_pulid', {
    main_face_image: anchorUrl,
    prompt: fullPrompt,
    negative_prompt: negativePrompt,
    width: 832,
    height: 1216,         // 4:5 portrait — IG Reel safe
    num_steps: 20,
    start_step: 0,
    guidance_scale: 4,
    id_weight: 1.0,        // 1.0 = strong face-lock to anchor
    true_cfg: 1,
    num_outputs: 1,
    output_format: 'webp',
    output_quality: 92,
    max_sequence_length: 128,
    seed,
  }, { timeoutMs: 300_000 });

  const remoteUrl = result.output[0];
  const destPath = `keyframes/${conceptId}/${idx}-${Date.now()}.webp`;
  const hosted = await rehostImage(remoteUrl, destPath);

  return {
    image_url: hosted.publicUrl,
    storage_path: hosted.storagePath,
    model: 'flux-pulid',
    is_face_locked: true,
    seed,
    cost_usd: result.cost_usd,
    generation_ms: result.generation_ms,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const db = dbModule.getClient();

  const concept = await getConcept(db, args);
  if (!concept) {
    log.error('No concept found. Use --winner or pass a concept_id.');
    process.exit(1);
  }
  log.info(`Concept: ${concept.title} (${concept.id})`);

  const persona = await personaService.getActivePersona('avi');
  if (!persona.canonical_face_url) {
    log.error('Persona has no canonical_face_url. Run generate_face_anchors.js then choose_face_anchor.js first.');
    process.exit(1);
  }

  const anchorUrl = persona.canonical_face_url;
  log.info(`Using face anchor: ${anchorUrl}`);

  // Update concept state
  if (!args.dryRun) {
    await db.from('reel_concepts').update({ state: 'image_generating', updated_at: new Date().toISOString() }).eq('id', concept.id);
  }

  const keyframes = Array.isArray(concept.keyframes) ? concept.keyframes : [];
  if (keyframes.length === 0) {
    log.warn('Concept has no keyframes. Generating 4 default scenes from full_script...');
    // Fallback: synthesize 4 generic scenes
    for (let i = 0; i < 4; i++) {
      keyframes.push({
        idx: i,
        prompt: i === 0 ? 'Looking directly at camera, slight smirk, holding a matcha latte, leaning forward' :
                i === 1 ? 'Three-quarter angle, gesturing while explaining, laptop on desk in front' :
                i === 2 ? 'Looking down at phone with thoughtful expression, soft side light' :
                          'Eyes meeting camera, soft warm smile, hair tucked behind ear',
        scene_caption: '',
        duration_ms: 7500,
      });
    }
  }

  log.info(`Rendering ${keyframes.length} keyframes...`);

  const results = [];
  let totalCost = 0;
  let totalMs = 0;

  for (let i = 0; i < keyframes.length; i++) {
    const kf = keyframes[i];
    log.info(`──────────────────────────────────────────`);
    log.info(`Keyframe ${i + 1}/${keyframes.length}`);
    try {
      const r = await renderKeyframe({
        persona, anchorUrl, kf, idx: i, conceptId: concept.id, dryRun: args.dryRun,
      });
      if (r.skipped) continue;

      // Insert keyframe row
      const { error } = await db.from('reel_keyframes').insert({
        concept_id: concept.id,
        keyframe_idx: i,
        image_url: r.image_url,
        storage_path: r.storage_path,
        scene_caption: kf.scene_caption || '',
        prompt: kf.prompt || '',
        duration_ms: kf.duration_ms || 7500,
        model: r.model,
        is_face_locked: true,
        seed: r.seed,
        cost_usd: r.cost_usd,
        generation_ms: r.generation_ms,
      });
      if (error) throw new Error(`DB insert failed: ${error.message}`);

      results.push(r);
      totalCost += r.cost_usd;
      totalMs += r.generation_ms;
      log.info(`✓ Keyframe ${i + 1} → ${r.image_url}`);
    } catch (err) {
      log.error(`Keyframe ${i + 1} failed: ${err.message}`);
      if (!args.dryRun) {
        await db.from('reel_concepts').update({
          state: 'failed',
          error_reason: `image_worker keyframe ${i}: ${err.message}`,
          updated_at: new Date().toISOString(),
        }).eq('id', concept.id);
      }
      throw err;
    }
  }

  if (!args.dryRun) {
    const imageUrls = results.map(r => r.image_url);
    await db.from('reel_concepts').update({
      image_urls: imageUrls,
      state: 'voicing',         // hand off to voice phase
      updated_at: new Date().toISOString(),
    }).eq('id', concept.id);
  }

  log.info(`══════════════════════════════════════════════`);
  log.info(`✓ Image worker complete.`);
  log.info(`   ${results.length} keyframes rendered`);
  log.info(`   Total cost: ~$${totalCost.toFixed(4)}`);
  log.info(`   Total time: ${(totalMs / 1000).toFixed(1)}s`);
  log.info(`══════════════════════════════════════════════`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
