#!/usr/bin/env node
/**
 * EverythinInAI — Hero Keyframe Worker
 *
 * Renders ONE photoreal Avi keyframe specifically optimized for SadTalker
 * lip-sync. Constraints:
 *   - Front-facing, eye-level
 *   - Mouth slightly open / relaxed (neutral)
 *   - Clear face, no obstruction
 *   - Single locked outfit (no per-Reel wardrobe drift)
 *
 * The outfit is randomized PER REEL but stays consistent within the Reel
 * (since this is the only keyframe).
 *
 * Usage:
 *   node avatar/imagery/hero_worker.js <concept_id>
 *   node avatar/imagery/hero_worker.js --winner
 *   node avatar/imagery/hero_worker.js --winner --outfit=cream_knit
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');
const { runModel } = require('./replicate_client');
const { rehostImage } = require('./storage');

const log = createLogger('hero_worker');

// Wardrobe options — pick ONE per Reel, lock it for all subsequent renders.
// Each option is a complete outfit string used in the prompt.
const OUTFITS = {
  cream_knit:   'fitted cream ribbed knit turtleneck, modest high crew neck, layered delicate matte gold pendant necklace',
  forest_green: 'fitted forest green ribbed knit turtleneck, modest high crew neck, simple gold stud earrings',
  beige_blazer: 'tailored beige blazer over high-neck cream silk top, layered delicate gold pendants, professional polished look',
  ivory_silk:   'fitted ivory silk blouse buttoned to high neck, single delicate gold pendant',
  oversized_cardigan: 'oversized cream knit cardigan over fitted cream high-neck top, simple gold hoops',
  black_mock:   'fitted black mock-neck merino top, single small gold pendant, minimalist',
};

function parseArgs(argv) {
  const args = { conceptId: null, useWinner: false, date: null, outfit: null, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--winner') args.useWinner = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--date=')) args.date = a.split('=')[1];
    else if (a.startsWith('--outfit=')) args.outfit = a.split('=')[1];
    else if (!a.startsWith('--')) args.conceptId = a;
  }
  return args;
}

async function getConcept(db, args) {
  if (args.conceptId) {
    const { data } = await db.from('reel_concepts').select('*').eq('id', args.conceptId).maybeSingle();
    return data;
  }
  if (args.useWinner) {
    const date = args.date || new Date().toISOString().slice(0, 10);
    const { data } = await db.from('reel_concepts')
      .select('*')
      .eq('target_date', date)
      .eq('is_winner', true)
      .maybeSingle();
    return data;
  }
  return null;
}

function pickOutfit(forceKey, conceptId) {
  if (forceKey && OUTFITS[forceKey]) {
    return { key: forceKey, value: OUTFITS[forceKey] };
  }
  // Deterministic per concept (same outfit if re-rendered)
  const keys = Object.keys(OUTFITS);
  const hash = conceptId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const key = keys[hash % keys.length];
  return { key, value: OUTFITS[key] };
}

function buildHeroPrompt(persona, outfitDescriptor, trigger) {
  // Optimized for OmniHuman/talking-head video generation:
  //   - Front-facing, eye-level, head + upper body in frame
  //   - Mouth slightly relaxed/neutral (will be animated)
  //   - Hands visible and natural (so model can animate them with gestures)
  //   - Clean, simple, slightly out-of-focus background (less artifact risk)
  return [
    `Real DSLR photograph of ${trigger} woman, a 25-year-old Indian content creator.`,
    `Three-quarter body framing showing head, shoulders, and upper torso including hands resting naturally in her lap or gently on the desk in front of her, palms relaxed and visible.`,
    `Looking directly at the camera, eye-level shot, mouth slightly relaxed and closed with the barest hint of a soft smile, warm engaging eyes.`,
    `Sitting upright with relaxed natural posture, slight forward lean of the torso, comfortable open body language.`,
    `Wearing ${outfitDescriptor}.`,
    `Background: clean simple out-of-focus warm-toned interior, soft plain wall with subtle warm gradient, no busy details, gentle bokeh, matte black laptop on the desk just barely visible at the edge of the frame.`,
    `Lighting: soft, even, three-point editorial lighting with a warm key from camera-left and a gentle fill from camera-right, NO harsh shadows on the face, NO dramatic backlight.`,
    `Photographic style: editorial portrait, shot on Sony A7R IV with 50mm prime at f/2.8, moderate depth of field, photorealistic ultra-detailed natural skin texture with visible pores, subtle 35mm film grain, magazine-quality, Vogue India aesthetic, NOT illustration, NOT cartoon, NOT cgi, NOT 3D render.`,
  ].join(' ');
}

async function renderHero({ persona, outfit, conceptId, dryRun }) {
  const trigger = persona.active_lora_trigger || 'AVI_TOK';
  const prompt = buildHeroPrompt(persona, outfit.value, trigger);

  if (dryRun) {
    log.info(`── DRY HERO ──`);
    log.info(`OUTFIT: ${outfit.key}`);
    log.info(`PROMPT:\n${prompt}`);
    return { skipped: true };
  }

  if (!persona.active_lora_url) {
    throw new Error('Persona has no active_lora_url. Train Avi LoRA first.');
  }

  const seed = Math.floor(Math.random() * 1_000_000);

  const result = await runModel('flux_dev_lora', {
    prompt,
    lora_weights: persona.active_lora_url,
    lora_scale: 1.0,
    aspect_ratio: '4:5',           // 4:5 = 1080x1350, IG-Reel safe
    num_outputs: 1,
    num_inference_steps: 28,
    guidance: 3.0,
    output_format: 'webp',
    output_quality: 95,             // higher quality for the single hero shot
    go_fast: false,
    seed,
  }, { timeoutMs: 300_000 });

  const remoteUrl = result.output[0];
  const destPath = `keyframes/${conceptId}/hero-${Date.now()}.webp`;
  const hosted = await rehostImage(remoteUrl, destPath);

  return {
    image_url: hosted.publicUrl,
    storage_path: hosted.storagePath,
    model: 'flux-dev-lora',
    is_face_locked: true,
    seed,
    cost_usd: result.cost_usd,
    generation_ms: result.generation_ms,
    outfit_key: outfit.key,
    prompt,
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
  if (!persona.active_lora_url) {
    log.error('Persona has no active_lora_url. Train LoRA first.');
    process.exit(1);
  }

  const outfit = pickOutfit(args.outfit, concept.id);
  log.info(`Outfit locked for this Reel: ${outfit.key}`);

  await db.from('reel_concepts').update({
    state: 'image_generating',
    updated_at: new Date().toISOString(),
  }).eq('id', concept.id);

  const r = await renderHero({ persona, outfit, conceptId: concept.id, dryRun: args.dryRun });
  if (r.skipped) return;

  // Wipe any existing keyframes for this concept (e.g. from prior multi-keyframe runs)
  await db.from('reel_keyframes').delete().eq('concept_id', concept.id);

  // Insert as keyframe_idx=0
  const { error } = await db.from('reel_keyframes').insert({
    concept_id: concept.id,
    keyframe_idx: 0,
    image_url: r.image_url,
    storage_path: r.storage_path,
    scene_caption: '',
    prompt: r.prompt,
    duration_ms: 30000,
    model: r.model,
    is_face_locked: true,
    seed: r.seed,
    cost_usd: r.cost_usd,
    generation_ms: r.generation_ms,
  });
  if (error) throw new Error(`DB insert failed: ${error.message}`);

  await db.from('reel_concepts').update({
    image_urls: [r.image_url],
    state: 'voicing',
    updated_at: new Date().toISOString(),
  }).eq('id', concept.id);

  log.info(`══════════════════════════════════════════════`);
  log.info(`✓ Hero keyframe rendered.`);
  log.info(`   url       : ${r.image_url}`);
  log.info(`   outfit    : ${r.outfit_key}`);
  log.info(`   cost      : ~$${r.cost_usd}`);
  log.info(`   gen time  : ${(r.generation_ms / 1000).toFixed(1)}s`);
  log.info(`══════════════════════════════════════════════`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
