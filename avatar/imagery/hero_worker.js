#!/usr/bin/env node
/**
 * EverythinInAI — Hero Keyframe Worker (Tech Reels)
 *
 * Renders ONE photoreal Rhea keyframe specifically optimized for talking-head
 * lipsync. This is the Mon–Thu professional stream — head-and-shoulders only,
 * modest neckline, smart-intellectual-IIT-grad energy.
 *
 * HARD RULES (do not relax these without explicit user approval):
 *   - Front-facing, eye-level, head-and-shoulders crop
 *   - Mouth slightly open / relaxed (neutral) for lipsync
 *   - Clear face, no obstruction, no hands in frame
 *   - Modest neckline ONLY (round / crew / soft V / blazer-buttoned)
 *     NO plunging V, NO sweetheart, NO spaghetti straps, NO cleavage
 *   - Fair-to-medium warm Indian complexion (NOT tanned, NOT dusky, NOT bronze)
 *   - Setting must read as a real physical room, NOT generic AI bokeh
 *   - Outfit/setting/pose rotated against the last 3 renders
 *
 * Usage:
 *   node avatar/imagery/hero_worker.js <concept_id>
 *   node avatar/imagery/hero_worker.js --winner
 *   node avatar/imagery/hero_worker.js --winner --outfit=cream_round_tee
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');
const { runModel } = require('./replicate_client');
const { rehostImage } = require('./storage');

const log = createLogger('hero_worker');

// ============================================================================
// CANONICAL LOOK ANCHOR — Rhea's identity locked to the user's reference photo
// (avatar/persona/references/canonical_rhea.webp).
//
// Empirical color analysis of the reference image (sampled across forehead,
// cheeks, chin):
//   AVG SKIN HEX = #A17B63   RGB = (161, 124,  99)   warm wheatish
//
// Empirical color of the LATEST drifted render (the one user rejected):
//   AVG SKIN HEX = #7F4A30   RGB = (128,  74,  48)   deep bronze/dusky
//
// That's a -34% luminance drift. Flux Dev's "Indian content creator" prior
// pulls hard toward bronze unless we anchor the look with concrete, named,
// photographic features of the actual reference image.
//
// Below: every distinctive feature of canonical Rhea, named explicitly so
// Flux has nothing to hallucinate.
// ============================================================================
const CANONICAL_LOOK = [
  // Skin — hex-anchored, double-negated, north-Indian-specific
  'fair north-Indian wheatish complexion (skin tone hex roughly #A17B63, soft warm beige with subtle pink undertone, light enough that her cheekbones catch warm highlights cleanly), the complexion of a young Delhi-born North-Indian woman who works indoors in air-conditioned offices, NEVER tanned, NEVER dusky, NEVER bronze, NEVER sun-kissed dark, NEVER deep brown',
  // Hair — long, loose, wavy (NOT tight bun, NOT pulled back)
  'long dark brown softly wavy hair flowing loosely down past her shoulders on both sides of her face with natural face-framing pieces, side part, NOT tied up, NOT in a bun, NOT slicked back, soft volume at the crown',
  // Eyes / brows — defined but soft
  'large warm dark brown almond-shaped eyes with soft lifted eyeliner and lightly defined natural brows, calm intelligent gaze',
  // Makeup — soft glam, mauve-pink lip
  'soft natural glam makeup: dewy skin finish (NOT matte, NOT plastic), subtle peach blush on cheekbones, soft mauve-pink lips with a gentle gloss, lightly contoured nose, no heavy eyeshadow, no bold lipstick',
  // Jewelry — small gold hoops only
  'small or medium plain gold hoop earrings, no necklace, no other jewelry',
  // Face shape — anchors LoRA identity
  'oval face with soft jawline, high cheekbones, naturally full but not exaggerated lips, slim straight nose with a small gentle tip',
].join(', ');

// Backwards-compat alias kept for any legacy callers.
const COMPLEXION_ANCHOR = CANONICAL_LOOK;

// ============================================================================
// DIGNITY ANCHOR — non-negotiable on tech reels.
// Rhea is an IIT Mumbai grad working at Goldman Sachs. The aesthetic is
// SMART HOT, INTELLECTUAL HOT, BEAUTIFUL HOT — NEVER trashy, NEVER vulgar,
// NEVER thirst-trap, NEVER sexualized. Think Ankur Warikoo's smart sister,
// not an AI bikini page.
// ============================================================================
const DIGNITY_ANCHOR =
  'smart intellectual elegance, IIT-Mumbai-graduate energy, Goldman Sachs analyst poise, dignified professional presence, beautiful and magnetic but completely non-sexualized, modest tasteful framing, NEVER vulgar, NEVER trashy, NEVER thirst-trap, NEVER cleavage, NEVER sexual';

// ============================================================================
// FRAMING ANCHOR — locks the camera crop for lipsync compatibility.
// Spelled out aggressively because Flux likes to drift to medium shots.
// ============================================================================
const FRAMING_ANCHOR =
  'tight head-and-shoulders portrait centered on her face, frame top just above her hair, frame bottom at the collarbone level (well above the chest), shoulders barely visible at the bottom edge, hands NOT in frame, arms NOT in frame, chest NOT in frame, neckline of top barely visible';

// ============================================================================
// OUTFITS — Tech-reel wardrobe.
// All outfits are MODEST: round neck / crew / soft V / blazer buttoned over
// shell. NO plunging V, NO sweetheart, NO spaghetti straps. The previous
// `berry_sweetheart`, `sapphire_wrap` (deep V), `midnight_cami` and
// `dusty_pink_cami` (spaghetti straps) and `beige_blazer_open` (low scoop
// under blazer) all rendered with cleavage. They are removed.
//
// 12 modest tech-reel outfits across 3 color families.
// ============================================================================
const OUTFITS = {
  // Warm Neutrals
  cream_knit_sweater:
    'cozy oversized cream-ivory chunky knit crew-neck sweater with a soft ribbed crew neckline sitting at the base of her throat, slightly slouchy fit covering her shoulders comfortably, modest and elegant editorial (this is her signature look from the reference image — default for Mondays)',
  cream_round_tee:
    'fitted cream cotton round-neck t-shirt with a high modest neckline sitting at the base of her throat, no necklace, simple small gold stud earrings, minimalist editorial',
  ivory_blouse_buttoned:
    'crisp ivory cotton button-down blouse buttoned all the way up to the collarbone, soft collar, no necklace, no jewelry, soft editorial',
  beige_blazer_buttoned:
    'tailored beige blazer buttoned closed over a high-neck cream shell underneath, no cleavage visible, no necklace, simple small gold studs, professional Goldman Sachs editorial',
  camel_turtleneck_lite:
    'soft fitted camel-colored fine-knit mock-neck top sitting at the mid-neck, clean and modest, no necklace, small gold stud earrings, quiet luxury editorial',

  // Cool Tones
  black_crew:
    'fitted black soft cotton crew-neck t-shirt with a high round neckline, no necklace, no jewelry, minimalist',
  charcoal_round:
    'fitted charcoal grey cotton round-neck tee, modest high neckline, no necklace, small gold studs, clean editorial',
  navy_blazer_buttoned:
    'tailored navy blazer buttoned closed over a high-neck white shell, fully covered chest, no necklace, simple silver studs, sharp consulting-firm editorial',
  slate_oxford:
    'crisp slate-blue oxford shirt buttoned to the second-from-top button, soft point collar covering the collarbone, no necklace, no jewelry, smart-casual editorial',

  // Bold but Modest (color pop, NEVER skin pop)
  emerald_blouse_buttoned:
    'rich emerald green silk blouse buttoned up with a soft high collar covering the collarbone, no V, delicate gold stud earrings, luxurious editorial',
  burgundy_round_knit:
    'fitted deep burgundy fine-knit round-neck top with a modest high neckline, no necklace, small gold hoop earrings, bold confident editorial',
  mustard_round_ribbed:
    'fitted mustard yellow ribbed round-neck top with a high modest neckline, no necklace, simple gold studs, warm vibrant editorial',
  oxblood_blazer_buttoned:
    'tailored oxblood red blazer buttoned closed over a black mock-neck shell, fully covered chest, no necklace, small gold studs, powerful executive editorial',
};

// ============================================================================
// SETTINGS — Real-room backgrounds.
// Removed the AI-cliche `luxury_rooftop` (string lights bokeh) and `luxe_car`
// which Flux interprets as generic "AI girl in car" thirst-trap energy.
// Replaced with SPECIFIC, lived-in, recognizable rooms with actual props.
// Each setting names concrete physical objects so Flux has to render them.
// ============================================================================
const SETTINGS = {
  bandra_apartment_study:
    'her actual home study in a Bandra apartment, soft beige wall directly behind her with a single framed black-and-white photograph, a tall bookshelf with real hardcover books visible at the soft-focus edge of frame, warm lamplight from a brass desk lamp slightly off-camera left, subtle real-world clutter (a small ceramic mug, a closed MacBook, a notebook), genuine room depth, NOT generic bokeh',
  glass_office_morning:
    'a real corner of a high-end Mumbai corporate glass office in the morning, frosted glass partition behind her with the silhouette of a colleague walking past in soft focus, a real ergonomic chair edge visible, ambient cool morning daylight from window off-camera right, subtle reflections in the glass, lived-in professional environment',
  art_gallery_white_wall:
    'standing in front of a real plain white art-gallery wall, a single large minimalist canvas softly visible at the right edge of frame, museum-grade overhead spotlights creating a soft directional shadow on her face, polished concrete floor reflection just out of frame, sophisticated intellectual aesthetic',
  hotel_suite_window:
    'seated in a real 5-star hotel suite next to a floor-to-ceiling window, soft daylight raking across her face from camera right, a beige linen curtain edge visible, a real upholstered headboard or chair in the soft-focus background, luxurious but lived-in beige and cream tones',
  cafe_window_corner:
    'seated at a real upscale Mumbai cafe corner table next to a large window, soft natural daylight from camera left, a real cappuccino cup, a small succulent plant, and a closed paperback book visible on the table at the bottom of frame, exposed brick wall and a chalkboard menu in the soft-focus background, lived-in cafe atmosphere',
  library_wood_nook:
    'seated in a real wood-paneled library nook, rich warm wooden bookshelves filled with real hardcover spines directly behind her, a brass reading lamp creating warm directional light from camera left, an open leather-bound notebook visible at the bottom of frame, deeply intellectual warm wood-tone atmosphere',
  podcast_studio_warm:
    'a real warm-lit podcast recording corner, a single acoustic foam panel softly visible behind her, a vintage condenser microphone slightly out of frame at the bottom edge, warm tungsten key light from camera right, real-room shadows on the wall, professional content-creator environment',
  rooftop_garden_dusk:
    'on a real Bandra apartment rooftop garden at dusk, real terracotta planters with leafy plants framing the soft-focus background, the warm glow of an actual neighboring building window visible in the deep background, ambient evening light, NOT a generic "rooftop bar with string lights bokeh" — a real residential rooftop',
};

// ============================================================================
// POSES — Talking-head friendly poses.
// All poses describe the upper body only (sitting/seated). No standing
// full-body, no leaning back dramatically (which crops chest into frame).
// ============================================================================
const POSES = {
  confident_smirk:
    'Sitting upright with relaxed natural posture, slight confident smirk, looking directly at the camera with magnetic intelligent energy.',
  head_tilt:
    'Seated casually, slight playful head tilt, knowing intelligent smile, open and engaging body language with shoulders square to camera.',
  mid_thought:
    'Sitting straight, looking slightly off-camera as if mid-thought, highly intellectual and observant expression.',
  intellectual_lean:
    'Seated with a very slight forward lean from the waist, calm warm engaged expression, sharp and attentive eye contact with the viewer.',
  direct_gaze:
    'Sitting upright with shoulders squared to the camera, calm composed direct eye contact, the look of someone who knows what she is talking about.',
  warm_smile:
    'Seated upright, genuine warm closed-mouth smile reaching the eyes, relaxed and trustworthy, the kind of smile a smart friend gives you.',
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

// ============================================================================
// pickCombo — outfit/setting/pose rotation against last 3 renders.
// Uses concept_id hash for deterministic-but-varied initial pick, then walks
// the keyspace until it lands on something not used in the last 3 keyframes.
// ============================================================================
async function pickCombo(forceOutfitKey, conceptId, db) {
  const { data: recentKeyframes } = await db.from('reel_keyframes')
    .select('outfit_key, prompt')
    .order('created_at', { ascending: false })
    .limit(3);

  const recentOutfits = new Set((recentKeyframes || []).map(kf => kf.outfit_key).filter(Boolean));

  const recentSettings = new Set();
  const recentPoses = new Set();
  (recentKeyframes || []).forEach(kf => {
    if (!kf.prompt) return;
    Object.keys(SETTINGS).forEach(key => {
      if (kf.prompt.includes(SETTINGS[key])) recentSettings.add(key);
    });
    Object.keys(POSES).forEach(key => {
      if (kf.prompt.includes(POSES[key])) recentPoses.add(key);
    });
  });

  // Deterministic 32-bit hash of concept_id so the same concept always lands
  // on the same combo (idempotent re-renders), but different concepts diverge.
  let hash = 0;
  for (let i = 0; i < conceptId.length; i++) {
    hash = ((hash << 5) - hash) + conceptId.charCodeAt(i);
    hash |= 0;
  }
  hash = Math.abs(hash);

  const outfitKeys = Object.keys(OUTFITS);
  let outfitKey = forceOutfitKey && OUTFITS[forceOutfitKey] ? forceOutfitKey : outfitKeys[hash % outfitKeys.length];
  if (!forceOutfitKey && recentOutfits.has(outfitKey)) {
    for (let i = 1; i < outfitKeys.length; i++) {
      const candidate = outfitKeys[(hash + i) % outfitKeys.length];
      if (!recentOutfits.has(candidate)) { outfitKey = candidate; break; }
    }
  }

  const settingKeys = Object.keys(SETTINGS);
  let settingKey = settingKeys[(hash * 7) % settingKeys.length];
  if (recentSettings.has(settingKey)) {
    for (let i = 1; i < settingKeys.length; i++) {
      const candidate = settingKeys[(hash * 7 + i) % settingKeys.length];
      if (!recentSettings.has(candidate)) { settingKey = candidate; break; }
    }
  }

  const poseKeys = Object.keys(POSES);
  let poseKey = poseKeys[(hash * 13) % poseKeys.length];
  if (recentPoses.has(poseKey)) {
    for (let i = 1; i < poseKeys.length; i++) {
      const candidate = poseKeys[(hash * 13 + i) % poseKeys.length];
      if (!recentPoses.has(candidate)) { poseKey = candidate; break; }
    }
  }

  return {
    outfit:  { key: outfitKey,  value: OUTFITS[outfitKey]  },
    setting: { key: settingKey, value: SETTINGS[settingKey] },
    pose:    { key: poseKey,    value: POSES[poseKey]      },
  };
}

// ============================================================================
// buildHeroPrompt — assembles the final prompt with all anchors front-loaded.
// Order matters for Flux: the most important constraints go first.
// ============================================================================
function buildHeroPrompt(persona, combo, trigger) {
  return [
    // 1. Subject + LoRA token + canonical look (most important, leads the prompt)
    //    The CANONICAL_LOOK string is the entire identity anchor: skin hex,
    //    hair, eyes, makeup, jewelry, face shape — every distinctive feature
    //    of the reference image, named explicitly so Flux can't drift.
    `Real DSLR photograph of ${trigger} woman, a 25-year-old Indian content creator. Identity: ${CANONICAL_LOOK}.`,
    // 2. Dignity guardrail (prevents trashy/vulgar drift)
    DIGNITY_ANCHOR + '.',
    // 3. Framing (locks head-and-shoulders crop)
    FRAMING_ANCHOR + '.',
    // 4. Expression
    'Looking directly at the camera, eye-level shot, mouth softly closed lips together NO TEETH SHOWING with a barest gentle hint of warmth, warm engaging intelligent eyes.',
    // 5. Pose
    combo.pose.value,
    // 6. Outfit (modest by definition — see OUTFITS dict)
    `Wearing ${combo.outfit.value}.`,
    // 7. Setting (real-room, NOT generic AI bokeh)
    `Background: ${combo.setting.value}.`,
    // 8. Lighting — soft, even, NOT golden-hour warm.
    //    Warm directional light was a major contributor to the bronze drift
    //    on the previous render. Lock to soft daylight / window light only.
    'Lighting: soft even cool-neutral natural daylight from a large window off-camera, gentle wrap-around shadows on her face, NOT golden-hour warm orange light, NOT tungsten warm light, NOT sunset light, NOT directional warm spotlight, NOT studio glow.',
    // 9. Photographic style + realism guardrails
    'Photographic style: shot on iPhone 15 Pro Max main camera at 24mm, raw unedited iPhone capture aesthetic, photorealistic ultra-detailed skin with visible pores and faint freckles, natural skin texture variation, very subtle 35mm film grain across the image, real-world depth of field, candid documentary feel like a photo a friend just took, highly engaging but believably real, asymmetric natural beauty, slight imperfections in skin and face that make it feel human, NOT illustration, NOT cartoon, NOT cgi, NOT 3D render, NOT airbrushed, NOT plastic skin, NOT perfectly symmetric, NOT studio-glow-smooth, NOT bronzed, NOT tanned, NOT sun-kissed dark.',
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
    aspect_ratio: '4:5',
    num_outputs: 1,
    num_inference_steps: 50,
    guidance: 3.5,
    output_format: 'webp',
    output_quality: 100,
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

  const combo = await pickCombo(args.outfit, concept.id, db);
  log.info(`Combo locked for this Reel: outfit=${combo.outfit.key}, setting=${combo.setting.key}, pose=${combo.pose.key}`);

  await db.from('reel_concepts').update({
    state: 'image_generating',
    updated_at: new Date().toISOString(),
  }).eq('id', concept.id);

  const r = await renderHero({ persona, combo, conceptId: concept.id, dryRun: args.dryRun });
  if (r.skipped) return;

  await db.from('reel_keyframes').delete().eq('concept_id', concept.id);

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
  log.info(`   setting   : ${combo.setting.key}`);
  log.info(`   pose      : ${combo.pose.key}`);
  log.info(`   cost      : ~$${r.cost_usd}`);
  log.info(`   gen time  : ${(r.generation_ms / 1000).toFixed(1)}s`);
  log.info(`══════════════════════════════════════════════`);
}

if (require.main === module) {
  main().catch((err) => {
    log.error(`Fatal: ${err.message}`);
    log.error(err.stack);
    process.exit(1);
  });
}

module.exports = { OUTFITS, SETTINGS, POSES, pickCombo, buildHeroPrompt };
