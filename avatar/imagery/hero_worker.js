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
// NO NECKLACES — the LoRA tends to merge necklaces into skin/clothing, looking weird.
// Just the outfit + ear accents only.
const OUTFITS = {
  cream_knit:   'fitted cream ribbed knit turtleneck, modest high crew neck, no necklace, simple small gold stud earrings',
  forest_green: 'fitted forest green ribbed knit turtleneck, modest high crew neck, no necklace, no jewelry',
  beige_blazer: 'tailored beige blazer over high-neck cream silk top, no necklace, simple small gold stud earrings, professional polished look',
  ivory_silk:   'fitted ivory silk blouse buttoned to high neck, no necklace, no jewelry, clean minimalist',
  oversized_cardigan: 'oversized cream knit cardigan over fitted cream high-neck top, no necklace, simple small gold hoop earrings',
  black_mock:   'fitted black mock-neck merino top, no necklace, no jewelry, minimalist',
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

const SETTINGS = {
  home_desk: 'clean simple out-of-focus warm-toned interior, soft plain wall with subtle warm gradient, no busy details, gentle bokeh, matte black laptop on the desk just barely visible at the edge of the frame',
  cafe_window: 'blurred background of a quiet minimalist cafe, soft natural daylight coming from a window off-camera, warm aesthetic',
  library_nook: 'soft out-of-focus background of wooden bookshelves with warm ambient lighting, cozy and intellectual vibe',
  minimal_studio: 'pure soft minimalist studio background, neutral beige tone, very shallow depth of field',
};

const POSES = {
  desk_lean: 'Sitting upright with relaxed natural posture, slight forward lean of the torso, comfortable open body language, hands resting naturally in her lap or gently on the desk in front of her.',
  casual_sit: 'Seated casually, shoulders relaxed, one arm resting softly on the armrest, open and conversational body language.',
  attentive: 'Sitting straight, highly attentive posture, hands clasped loosely in front of her, engaging directly with the viewer.',
};

function pickCombo(forceOutfitKey, conceptId) {
  const hash = conceptId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);

  const outfitKeys = Object.keys(OUTFITS);
  const outfitKey = forceOutfitKey && OUTFITS[forceOutfitKey] ? forceOutfitKey : outfitKeys[hash % outfitKeys.length];

  const settingKeys = Object.keys(SETTINGS);
  const settingKey = settingKeys[(hash * 2) % settingKeys.length];

  const poseKeys = Object.keys(POSES);
  const poseKey = poseKeys[(hash * 3) % poseKeys.length];

  return {
    outfit:  { key: outfitKey,  value: OUTFITS[outfitKey]  },
    setting: { key: settingKey, value: SETTINGS[settingKey] },
    pose:    { key: poseKey,    value: POSES[poseKey]    },
  };
}

function buildHeroPrompt(persona, combo, trigger) {
  return [
    `Real DSLR photograph of ${trigger} woman, a 25-year-old Indian content creator.`,
    `Three-quarter body framing showing head, shoulders, and upper torso including hands, palms relaxed and visible.`,
    `Looking directly at the camera, eye-level shot, mouth softly closed lips together NO TEETH SHOWING with a barest gentle hint of warmth, warm engaging eyes.`,
    combo.pose.value,
    `Wearing ${combo.outfit.value}.`,
    `Background: ${combo.setting.value}.`,
    `Lighting: soft, even, three-point editorial lighting with a warm key from camera-left and a gentle fill from camera-right, NO harsh shadows on the face, NO dramatic backlight.`,
    `Photographic style: editorial portrait, shot on Sony A7R IV with 50mm prime at f/2.8, moderate depth of field, photorealistic ultra-detailed natural skin texture with visible pores, subtle 35mm film grain, magazine-quality, Vogue India aesthetic, NOT illustration, NOT cartoon, NOT cgi, NOT 3D render.`,
  ].join(' ');
}

async function renderHero({ persona, combo, conceptId, dryRun }) {
  const trigger = persona.active_lora_trigger || 'AVI_TOK';
  const prompt = buildHeroPrompt(persona, combo, trigger);

  if (dryRun) {
    log.info(`── DRY HERO ──`);
    log.info(`COMBO: outfit=${combo.outfit.key} setting=${combo.setting.key} pose=${combo.pose.key}`);
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
    outfit_key: combo.outfit.key,
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

  const persona = await personaService.getActivePersona();
  if (!persona.active_lora_url) {
    log.error('Persona has no active_lora_url. Train LoRA first.');
    process.exit(1);
  }

  const combo = pickCombo(args.outfit, concept.id);
  log.info(`Combo locked for this Reel: outfit=${combo.outfit.key}, setting=${combo.setting.key}, pose=${combo.pose.key}`);

  await db.from('reel_concepts').update({
    state: 'image_generating',
    updated_at: new Date().toISOString(),
  }).eq('id', concept.id);

  const r = await renderHero({ persona, combo, conceptId: concept.id, dryRun: args.dryRun });
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
  log.info(`   outfit    : ${combo.outfit.key}`);
  log.info(`   cost      : ~$${r.cost_usd}`);
  log.info(`   gen time  : ${(r.generation_ms / 1000).toFixed(1)}s`);
  log.info(`══════════════════════════════════════════════`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
