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
// Outfits engineered for talking-head lipsync safety:
// - Clean lower necklines (round / V-neck / scoop / camisole strap / sweetheart)
// - No turtlenecks/chokers/high collars (they fold and distort during lipsync)
// - Small stud earrings only; no necklaces
const OUTFITS = {
  // Warm Neutrals
  cream_round_tee:   'fitted cream cotton round-neck t-shirt, clean wide neckline well below collarbones, no necklace, simple small gold stud earrings, minimalist editorial',
  beige_blazer_open: 'tailored beige blazer worn open over fitted plain white cotton tank, clean low scoop neckline, no necklace, simple small gold studs, professional editorial',
  ivory_silk_open:   'flowy ivory silk blouse with first two buttons undone showing a clean open neckline, no necklace, no jewelry, soft editorial',
  
  // Cool Tones
  black_vneck:       'fitted black soft cotton v-neck top, clean wide v-neckline, no necklace, no jewelry, minimalist',
  charcoal_scoop:    'fitted charcoal grey cotton scoop-neck tee, wide soft neckline, no necklace, small gold studs, clean editorial',
  midnight_cami:     'fitted midnight blue silk camisole with thin straps, clean shoulder line, no necklace, simple silver studs, elegant evening editorial',
  
  // Bold / High-Contrast
  berry_sweetheart:  'fitted deep berry red top with sweetheart neckline, clean open chest, no necklace, small gold hoop earrings, bold confident editorial',
  emerald_silk:      'emerald green silk blouse with wide open V-neckline, no necklace, delicate gold stud earrings, luxurious editorial',
  sapphire_wrap:     'sapphire blue wrap-style top with clean deep V-neck, no necklace, no jewelry, striking modern editorial',
  
  // Rich Accents
  mustard_ribbed:    'fitted mustard yellow ribbed scoop-neck top, wide soft neckline, no necklace, simple gold studs, warm vibrant editorial',
  oxblood_blazer:    'tailored oxblood red blazer over plain black scoop-neck tank, clean open neckline, no necklace, small gold studs, powerful editorial',
  dusty_pink_cami:   'fitted dusty pink silk camisole with thin straps, clean shoulder line, no necklace, simple gold studs, soft feminine editorial',
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
  bandra_apartment: 'clean simple out-of-focus warm-toned luxury apartment interior, soft plain wall with subtle warm gradient, gentle bokeh, Mumbai skyline faintly visible through a distant window',
  glass_office:     'blurred background of a high-end corporate glass office at dusk, sleek modern architecture, subtle cool blue and warm amber lighting reflections, professional Goldman Sachs vibe',
  luxury_rooftop:   'out-of-focus luxury rooftop lounge at golden hour, warm sunset lighting, subtle bokeh of string lights and distant city buildings, high-end aspirational vibe',
  art_gallery:      'blurred background of a modern minimalist art gallery, stark white walls with soft gallery spotlights, sophisticated intellectual aesthetic',
  luxe_car:         'out-of-focus interior of a luxury car, subtle premium leather textures and warm ambient dashboard lighting, high-status lifestyle vibe',
  hotel_suite:      'blurred background of a premium 5-star hotel suite, floor-to-ceiling windows with soft daylight, luxurious beige and cream tones, aspirational wealth',
  cafe_window:      'blurred background of a quiet minimalist upscale cafe, soft natural daylight coming from a window off-camera, warm chic aesthetic',
  library_nook:     'soft out-of-focus background of rich wooden bookshelves with warm ambient lighting, cozy but highly intellectual vibe',
};

const POSES = {
  confident_smirk:  'Sitting upright with relaxed natural posture, slight confident smirk, looking directly at the camera with magnetic energy.',
  head_tilt:        'Seated casually, slight playful head tilt, knowing smile, open and highly engaging body language.',
  mid_thought:      'Sitting straight, looking slightly off-camera as if mid-thought, highly intellectual and observant expression.',
  intellectual:     'Seated with a slight forward lean, calm warm expression, engaging directly with the viewer, sharp and attentive.',
  lean_back:        'Relaxed posture leaning slightly back, exuding effortless confidence and quiet luxury, subtle warm smile.',
  mid_laugh:        'Captured mid-laugh with a bright genuine smile, eyes sparkling with fun, highly charismatic and open energy.',
};

function pickCombo(forceOutfitKey, conceptId) {
  // Use a better hash to avoid clustering
  let hash = 0;
  for (let i = 0; i < conceptId.length; i++) {
    hash = ((hash << 5) - hash) + conceptId.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  hash = Math.abs(hash);

  const outfitKeys = Object.keys(OUTFITS);
  const outfitKey = forceOutfitKey && OUTFITS[forceOutfitKey] ? forceOutfitKey : outfitKeys[hash % outfitKeys.length];

  const settingKeys = Object.keys(SETTINGS);
  // Use coprime multipliers to ensure even distribution across the 576-combo space
  const settingKey = settingKeys[(hash * 7) % settingKeys.length];

  const poseKeys = Object.keys(POSES);
  const poseKey = poseKeys[(hash * 13) % poseKeys.length];

  return {
    outfit:  { key: outfitKey,  value: OUTFITS[outfitKey]  },
    setting: { key: settingKey, value: SETTINGS[settingKey] },
    pose:    { key: poseKey,    value: POSES[poseKey]    },
  };
}

function buildHeroPrompt(persona, combo, trigger) {
  return [
    `Real DSLR photograph of ${trigger} woman, a 25-year-old Indian content creator.`,
    `Tight head-and-shoulders framing centered on her face. Hands NOT visible in frame, hands cropped out. Frame stops just above the chest. Clean shoulder line, no arms or hands shown. This is critical for talking-head video output.`,
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
    num_inference_steps: 50,
    guidance: 3.5,
    output_format: 'webp',
    output_quality: 100,             // higher quality for the single hero shot
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
