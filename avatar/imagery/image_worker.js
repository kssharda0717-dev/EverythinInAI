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
  const args = { conceptId: null, useWinner: false, date: null, dryRun: false, single: false };
  for (const a of argv.slice(2)) {
    if (a === '--winner') args.useWinner = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--single') args.single = true;
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

function buildKeyframePrompt(persona, sceneDescription, sceneCaption, trigger = 'AVI_TOK') {
  // The trigger word activates the trained LoRA. It MUST be the first thing.
  // The LoRA already encodes Avi's face/skin/hair — we don't need to describe
  // her identity, only the scene + outfit + lighting + style.
  return [
    `Real DSLR photograph of ${trigger} woman, a 25-year-old Indian content creator.`,
    sceneDescription,
    `Wearing a fitted ribbed cream knit top with high crew neck OR oversized beige cardigan over a high-neck top OR fitted blazer buttoned over a high-neck top. Modest, sophisticated, NEVER plunging, NEVER low-cut, NEVER showing cleavage. Palette of cream, beige, forest green, ivory, with delicate matte gold jewelry.`,
    `Indoor minimalist Bandra studio apartment OR cozy book-lined corner, soft warm window light or studio editorial lighting, plants and hardcover books in soft bokeh, matte black laptop visible.`,
    `Photograph shot on Sony A7R IV with 35mm or 85mm prime lens at f/1.8, shallow depth of field, natural skin texture with visible pores, subtle 35mm film grain, magazine editorial photography, Vogue India aesthetic, candid documentary feel, photorealistic, NOT illustration, NOT cartoon, NOT cgi.`,
  ].join(' ');
}

async function renderKeyframe({ persona, kf, idx, conceptId, dryRun }) {
  const sceneDesc = kf.prompt || `Standing thoughtfully, looking at the camera`;
  const trigger = persona.active_lora_trigger || 'AVI_TOK';
  const fullPrompt = buildKeyframePrompt(persona, sceneDesc, kf.scene_caption, trigger);

  if (dryRun) {
    log.info(`── DRY KEYFRAME[${idx}] ──`);
    log.info(`PROMPT:\n${fullPrompt}`);
    return { skipped: true };
  }

  if (!persona.active_lora_url) {
    throw new Error('Persona has no active_lora_url. Run train_lora.js first.');
  }

  const seed = Math.floor(Math.random() * 1_000_000);

  // Using Flux Dev with Avi's trained LoRA — the production path.
  // The LoRA encodes Avi's identity from the 20-image training set.
  // The trigger word "AVI_TOK" must appear in every prompt for the LoRA to activate.
  const result = await runModel('flux_dev_lora', {
    prompt: fullPrompt,
    lora_weights: persona.active_lora_url,
    lora_scale: 1.0,                     // 1.0 = full LoRA strength
    aspect_ratio: '4:5',                  // IG Reel portrait
    num_outputs: 1,
    num_inference_steps: 28,
    guidance: 3.0,                        // Flux Dev natural setting
    output_format: 'webp',
    output_quality: 92,
    go_fast: false,                       // false = full quality
    seed,
  }, { timeoutMs: 300_000 });

  const remoteUrl = result.output[0];
  const destPath = `keyframes/${conceptId}/${idx}-${Date.now()}.webp`;
  const hosted = await rehostImage(remoteUrl, destPath);

  return {
    image_url: hosted.publicUrl,
    storage_path: hosted.storagePath,
    model: 'flux-dev-lora',
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

  const persona = await personaService.getActivePersona();
  if (!persona.active_lora_url) {
    log.error('Persona has no active_lora_url. Train Avi\'s LoRA first:');
    log.error('  1. node avatar/imagery/generate_training_set.js');
    log.error('  2. node avatar/imagery/train_lora.js');
    process.exit(1);
  }
  log.info(`Using LoRA: ${persona.active_lora_url}`);
  log.info(`Trigger word: ${persona.active_lora_trigger}`);

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

  // --single mode: only render keyframe 0 to validate cheaply (~$0.02)
  const renderList = args.single ? keyframes.slice(0, 1) : keyframes;
  log.info(`Rendering ${renderList.length} keyframe${renderList.length > 1 ? 's' : ''}${args.single ? ' (SINGLE TEST mode)' : ''}...`);

  const results = [];
  let totalCost = 0;
  let totalMs = 0;

  for (let i = 0; i < renderList.length; i++) {
    const kf = renderList[i];
    log.info(`──────────────────────────────────────────`);
    log.info(`Keyframe ${i + 1}/${renderList.length}`);
    try {
      const r = await renderKeyframe({
        persona, kf, idx: i, conceptId: concept.id, dryRun: args.dryRun,
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
