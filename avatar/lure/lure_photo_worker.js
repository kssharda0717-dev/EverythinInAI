#!/usr/bin/env node
/**
 * EverythinInAI — Lure Photo Worker (Phase 15)
 *
 * Generates ONE high-quality portrait of Avi for the Friday lure post.
 * Lure level 3: attractive + intellectual + classy. Never crosses into
 * "thirst trap" territory — modest necklines, no cleavage, no skimpy
 * outfits. Think Vogue India editorial.
 *
 * 6 scene templates (rotates by week):
 *   - cafe_book        (cafe, hardcover book, latte, candid)
 *   - golden_rooftop   (Bandra rooftop, golden hour, wind in hair)
 *   - library_corner   (cozy library nook, soft window light)
 *   - apartment_laptop (minimalist apartment, working at desk)
 *   - garden_morning   (bench in a leafy garden, morning light)
 *   - balcony_evening  (apartment balcony, fairy lights, dusk)
 *
 * Cost: 1 × $0.025 (Flux + LoRA) = $0.025
 *
 * Usage:
 *   node avatar/lure/lure_photo_worker.js                    # auto-pick scene
 *   node avatar/lure/lure_photo_worker.js --scene=cafe_book
 *   node avatar/lure/lure_photo_worker.js --calendar=<id>    # bind to calendar row
 */

const fs = require('fs');
const path = require('path');
const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');
const { runModel } = require('../imagery/replicate_client');
const { rehostImage } = require('../imagery/storage');
const {
  CANONICAL_LOOK,
  COMPLEXION_NEGATIONS,
  LURE_DIGNITY_ANCHOR,
} = require('../persona/canonical_look');
// Lure variant: more permissive than tech (allure is the brief), but still
// elegant. See canonical_look.js for the full register definition.
const SHARED_DIGNITY_ANCHOR = LURE_DIGNITY_ANCHOR;

const log = createLogger('lure_photo');

const W = 1080;
const H = 1350;

// Tasteful body descriptor: visibly hourglass figure with fuller hips and
// defined waist that reads as natural and aspirational, not exaggerated/fake.
// Applied ONLY to lure photos (Friday) and lifestyle videos (Sat-Sun).
// Tech reels stay head-and-shoulders unchanged.
// UPDATED: Anchored to concrete Bollywood-actress-tier builds to prevent Flux
// from defaulting to a stick figure despite the "curves" keyword.
const CURVY_BODY = 'visibly hourglass figure with defined fuller hips and bust, body-positive proportions similar to a fit South Indian actress, beautiful feminine silhouette, never exaggerated, never artificial';

// Explicit hand anchor to prevent deformed/melted hands when holding props
const HANDS_ANCHOR = 'hands clearly visible and perfectly formed, fingers properly defined and anatomically correct, holding prop naturally';

// Explicit OUTCOME SPEC to force Flux out of its "AI sheen" default.
// Pushes hard against the over-smooth, over-symmetric "AI girl" look.
const OUTCOME_SPEC = 'OUTCOME SPEC: This must look like a real, candid iPhone Instagram photo taken by a real photographer. Skin must show visible pores, faint freckles, subtle imperfections, natural skin texture variation, slight uneven blush on cheeks, faint shine on T-zone. Face must have natural asymmetry, slightly uneven eyes, a real human nose with slight imperfection, lips with natural texture not glossy plastic. Lighting must have real-world depth with hard and soft shadows. The image must have subtle 35mm film grain texture throughout. The background must be a real physical place with clutter, texture, and depth. It must NOT look like AI art, must NOT have plastic skin, must NOT have perfect symmetry, must NOT look airbrushed.';

// 6 lure scene templates. Focus: highly engaging, natural slice-of-life moments.
// 20 curated lure scenes across 4 brand buckets (Editorial Bold, Aspirational Casual, Traditional Elegance, Luxury Lifestyle)
// Every scene has a CONTEXT (place + activity + prop) so it reads as 'lifestyle moment', not 'body shot'.
const SCENES = {
  // === EDITORIAL BOLD (5) ===
  beach_editorial: {
    label: 'Editorial beach in Goa',
    scene: `facing the camera directly with a confident, magnetic gaze, standing on a pristine white-sand beach holding a fresh coconut with both hands (${HANDS_ANCHOR}), golden hour sunlight, Vogue India editorial framing, ocean and palm trees blurred behind`,
    outfit: 'vibrant crimson red bikini top with flowing floral palazzo pants, beachy waves in hair, sunkissed skin, bold desirable aesthetic',
  },
  hotel_balcony_slip: {
    label: 'Luxury hotel suite balcony',
    scene: `facing the camera directly, leaning back slightly against a luxury hotel suite balcony railing at golden hour, holding a coffee cup at chest level (${HANDS_ANCHOR}), eye contact with a knowing smirk, hair tousled, classy but highly desirable slice-of-life moment`,
    outfit: 'deep emerald silk slip dress showing collarbones, delicate diamond necklace, hair in loose waves',
  },
  infinity_pool_book: {
    label: 'Infinity pool with book',
    scene: `facing the camera directly, lounging at the edge of an infinity pool overlooking a tropical jungle, holding a hardcover book on AI strategy resting on her lap (${HANDS_ANCHOR}), oversized Celine sunglasses pushed up on head, perfect blend of intellect and hot aesthetic`,
    outfit: 'royal blue one-piece swimsuit with elegant side cutouts, classy resort aesthetic, no jewelry',
  },
  rooftop_bar_red: {
    label: 'Rooftop bar Mumbai night',
    scene: `facing the camera directly, late night at exclusive rooftop bar in Mumbai, holding a martini glass near her face (${HANDS_ANCHOR}), paparazzi flash photography style candid, city lights blurred behind, magnetic talk-of-the-town energy`,
    outfit: 'bold tailored red blazer worn open with a black lace bralette underneath, sleek black trousers, delicate diamond drop earrings',
  },
  bedroom_loungewear: {
    label: 'Bedroom mirror loungewear',
    scene: 'facing the mirror directly for a selfie, sitting on the edge of a plush unmade hotel bed, holding phone naturally, glowing natural skin, messy high bun, aspirational intimate lifestyle aesthetic',
    outfit: 'luxurious matching silk camisole and shorts loungewear set in rich burgundy, barefoot, delicate gold anklet',
  },

  // === ASPIRATIONAL CASUAL (5) ===
  kitchen_morning_coffee: {
    label: 'Kitchen morning coffee',
    scene: `facing the camera directly with a warm intimate smile, leaning casually against a modern kitchen counter, holding a small ceramic bowl or mug with both hands (${HANDS_ANCHOR}), natural relaxed posture, an espresso machine and small herb plants visible behind, framed graduation photo on the wall, real apartment depth with city skyline through window`,
    outfit: 'ribbed cream crop top with a cozy beige cardigan draped loosely off the shoulders, high-waisted fitted blue jeans, hair in a loose messy bun with flyaway strands',
  },
  office_blazer_ipad: {
    label: 'Office blazer with iPad',
    scene: `facing the camera directly with a bright professional smile, standing in a bright modern office with floor-to-ceiling windows showing city skyline, holding an iPad and stylus naturally (${HANDS_ANCHOR}), confident and approachable corporate aesthetic`,
    outfit: 'tailored deep teal blazer worn open over a fitted cream top, matching teal trousers, sleek low ponytail, delicate gold jewelry',
  },
  cafe_green_candid: {
    label: 'Cafe candid in green',
    scene: `facing the camera directly with a genuine sweet smile, sitting at a cafe table with a coffee and a plate of food, hands clasped together resting on the table (${HANDS_ANCHOR}), warm natural daylight, exposed brick wall and soft cafe lighting in background`,
    outfit: 'sleeveless olive green top with subtle vertical stitching, hair pulled back softly with face-framing pieces, minimal elegant makeup',
  },
  european_street_trench: {
    label: 'European street walk',
    scene: 'facing the camera directly, walking down a sun-dappled street in Lisbon or Paris, confident strut, bright genuine smile, cobblestones and old-world facades behind, travel-influencer aesthetic',
    outfit: 'open beige trench coat over a fitted black mini dress, knee-high leather boots, oversized sunglasses',
  },
  vanity_getting_ready: {
    label: 'Getting ready at vanity',
    scene: `facing the camera directly (via mirror reflection), sitting at a sleek modern vanity applying a subtle nude lipstick (${HANDS_ANCHOR}), plush white hotel robe slipped slightly off one shoulder, perfect glowing skin, soft diffused warm lighting`,
    outfit: 'plush white luxury hotel robe, revealing collarbones and shoulder',
  },
  vinyl_records_floor: {
    label: 'Vinyl records on the floor',
    scene: `facing the camera directly, sitting on a patterned Persian rug surrounded by vintage vinyl records, holding a record sleeve (${HANDS_ANCHOR}), warm afternoon light through window, boho-chic cultured vibe`,
    outfit: 'fitted white ribbed tank top, distressed denim shorts, no shoes, hair in a low loose bun',
  },

  // === TRADITIONAL ELEGANCE (5) ===
  balcony_kurta_sunset: {
    label: 'Balcony kurta at sunset',
    scene: `facing the camera directly with a soft sweet smile, standing on a high-rise apartment balcony at golden hour sunset, hands resting gently clasped in front of her (${HANDS_ANCHOR}), surrounded by lush potted plants, city skyline in the soft background`,
    outfit: 'elegant beige and pink block-printed cotton kurta set with 3/4 sleeves, hair pulled up in a neat bun, small bindi, very natural fresh-faced makeup',
  },
  diwali_party_saree: {
    label: 'Diwali party red saree',
    scene: `facing the camera directly with a radiant joyful smile, standing in a festive room decorated with warm string lights and diyas, other guests softly blurred in the background, hands resting naturally at her sides (${HANDS_ANCHOR}), vibrant cultural celebration`,
    outfit: 'rich crimson red silk saree with heavy gold zari border, short-sleeved matching red blouse, delicate gold necklace and earrings, hair pulled back neatly, small red bindi',
  },
  udaipur_lehenga_twirl: {
    label: 'Udaipur palace lehenga twirl',
    scene: 'facing the camera directly, standing in a heritage palace courtyard in Udaipur, hands resting on her hips, confident modern-Indian aesthetic, sunlight catching the embroidery',
    outfit: 'vibrant magenta floral lehenga with a modern plunging neckline blouse, traditional jewelry, hair half-up half-down with floral hair clip',
  },
  vintage_ambassador_saree: {
    label: 'Vintage Ambassador car saree',
    scene: 'facing the camera directly, sitting in the back of a vintage white Ambassador car with the door open, looking at the viewer with a soft confident smile, old-money Indian royalty aesthetic, deeply elegant and timeless',
    outfit: 'crisp white linen saree with a halter-neck blouse, vintage gold drop earrings, no excess accessories',
  },
  festive_kurta_mirror: {
    label: 'Festive kurta mirror selfie',
    scene: `facing the mirror directly for a selfie, adjusting a heavy gold earring with free hand (${HANDS_ANCHOR}), modern influencer format applied to traditional attire, warm golden hour light streaming through window`,
    outfit: 'heavy velvet kurta with intricate zari work in deep burgundy, traditional gold jewelry, hair in a low bun with maang tikka',
  },

  // === LUXURY LIFESTYLE (5) ===
  porsche_golden_hour: {
    label: 'Luxury SUV golden hour',
    scene: `facing the camera directly, sitting in the driver seat of a Porsche with beige leather interior, door open, looking at viewer with effortless wealth aura, one hand resting on the leather steering wheel (${HANDS_ANCHOR})`,
    outfit: 'crisp white linen shirt unbuttoned deeply at the collar, delicate gold layered necklaces, designer aviator sunglasses on the head',
  },
  business_class_champagne: {
    label: 'Business class flight',
    scene: `facing the camera directly, relaxing in a lie-flat Business Class airplane seat on an international flight, holding a glass of champagne (${HANDS_ANCHOR}), jet-setter aspiration, soft cabin lighting`,
    outfit: 'matching camel-colored cashmere lounge set, comfortable but extremely expensive looking, revealing collarbones',
  },
  omakase_solo: {
    label: 'Solo omakase fine dining',
    scene: `facing the camera directly, solo fine-dining at an omakase restaurant counter, holding a pair of chopsticks over beautifully plated sushi (${HANDS_ANCHOR}), sophisticated knowing smile, warm restaurant lighting`,
    outfit: 'sleek black halter-neck dress, minimalist gold cuff bracelet, hair in a sleek low ponytail',
  },
  art_gallery_blazer: {
    label: 'Contemporary art gallery',
    scene: 'facing the camera directly, exploring a contemporary art gallery, looking at the viewer with an intellectual-wealthy-cultured aura, soft museum lighting, large abstract painting behind her',
    outfit: 'tailored oversized beige suit worn open with a black silk camisole underneath, sleek black loafers, hair in loose waves',
  },
  yacht_white_linen: {
    label: 'Private yacht golden hour',
    scene: `facing the camera directly, golden hour on a private yacht, holding a woven sun hat in one hand (${HANDS_ANCHOR}), dress and hair flowing in the wind, the ultimate expression of freedom and success, ocean horizon behind`,
    outfit: 'flowing white linen maxi dress with a deep V-neck, barefoot, gold ankle bracelet',
  },
};

function parseArgs(argv) {
  const args = { scene: null, calendarId: null, conceptId: null, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--scene=')) args.scene = a.split('=')[1];
    else if (a.startsWith('--calendar=')) args.calendarId = a.split('=')[1];
    else if (a.startsWith('--concept=')) args.conceptId = a.split('=')[1];
  }
  return args;
}

function pickSceneForToday() {
  // Rotate by week-of-year so the same Friday doesn't always get the same scene.
  const keys = Object.keys(SCENES);
  const week = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  return keys[week % keys.length];
}

// The base prefix enforces the photographic style and the strict "NOT cgi" guardrails.
// Tuned for Samiikssha-tier realism: real iPhone capture aesthetic with grain + imperfections.
const STYLE_ANCHOR = `Photographic style: shot on iPhone 15 Pro Max main camera at 24mm, raw unedited iPhone capture aesthetic, photorealistic ultra-detailed skin with visible pores and faint freckles, natural skin texture variation, very subtle 35mm film grain across the image, natural ambient mixed lighting (warm/cool blend), real-world depth of field, candid documentary feel like a photo a friend just took, highly engaging and highly desirable but believably real, asymmetric natural beauty, slight imperfections in skin and face that make it feel human, NOT illustration, NOT cartoon, NOT cgi, NOT 3D render, NOT airbrushed, NOT plastic skin, NOT perfectly symmetric, NOT studio-glow-smooth.`;

function buildPrompt(sceneKey, persona, trigger) {
  const scene = SCENES[sceneKey];
  return [
    OUTCOME_SPEC,
    // Identity FIRST: canonical look (skin hex, hair, eyes, makeup, hoops, face
    // shape) anchors the LoRA before any scene-specific words can pull it off.
    `Real DSLR photograph of ${trigger} woman, a 25-year-old Indian content creator. Identity: ${CANONICAL_LOOK}. Body: ${CURVY_BODY}.`,
    // Dignity guardrail — lure variant: tasteful, never vulgar, never thirst-trap.
    `${SHARED_DIGNITY_ANCHOR}, full-body or 3/4-length composition, body silhouette and outfit visible, magazine-cover styling.`,
    scene.scene + '.',
    `Wearing: ${scene.outfit}.`,
    // Extra complexion protection because lure scenes often involve golden
    // hour / beach / poolside which Flux would otherwise bronze.
    COMPLEXION_NEGATIONS,
    STYLE_ANCHOR,
  ].join(' ');
}

/**
 * NEW: Build a prompt directly from the LLM-generated image_prompt on the concept.
 * This is used when the lure photo is part of an LLM-drafted concept (post-Phase 16).
 */
// Framework-keyword validators — if the angle implies certain props/garments,
// we MUST see them in the prompt; otherwise Gemini took a shortcut and we splice
// the missing keywords in manually so the framework actually executes.
const FRAMEWORK_KEYWORDS = {
  diwali_saree_glow:        ['saree', 'diya'],
  balcony_kurta_sunset:     ['kurta', 'balcony'],
  udaipur_palace_lehenga:   ['lehenga', 'palace'],
  library_silk_blouse:      ['library', 'silk blouse'],
  hotel_robe_morning:       ['robe', 'hotel suite'],
  art_gallery_blazer_lure:  ['gallery', 'blazer', 'suit'],
  mirror_selfie_classy:     ['mirror'],
  cafe_candid:              ['cafe'],
  golden_hour_balcony:      ['balcony', 'skyline'],
  dressed_up_elevator:      ['elevator', 'dress'],
  morning_kitchen:          ['kitchen', 'matcha'],
  vacation_stroll:          ['street', 'cobblestone'],
};

function enforceFraming(prompt) {
  // BANNED phrasings that produce chest-up crops — strip and replace with full-body.
  let p = prompt
    .replace(/head[- ]and[- ]shoulders/gi, 'full-body')
    .replace(/close[- ]up portrait/gi, 'full-body portrait')
    .replace(/bust shot/gi, 'full-body shot')
    .replace(/3\/4[- ]length/gi, 'full-body')   // upgrade 3/4-length → full-body for lure
    .replace(/hip[- ]up/gi, 'full-body')
    .replace(/waist[- ]up/gi, 'full-body');

  // If Gemini didn't include any framing instruction, prepend the default FULL-BODY framing.
  // The phrase appears at the END (Flux weights end-of-prompt strongly) AND in the middle
  // for redundancy in case the prompt is long enough that early framing gets diluted.
  const hasFullBody = /full[- ]body/i.test(p);
  if (!hasFullBody) {
    p += ' Full-body shot showing her entire figure from head to mid-shin, the entire outfit clearly visible, magazine-cover composition, NOT a chest-up crop, NOT a head-and-shoulders crop.';
  } else {
    // Already mentions full-body but reinforce at the very end so Flux doesn't drift.
    p += ' Composition is full-body magazine-cover from head to mid-shin, entire outfit visible.';
  }
  return p;
}

// Tungsten/warm-lamp scenes (library, hotel suite, balcony at sunset) tend to
// drift skin darker because Flux interprets warm key light as bronze-her-skin.
// We append a hard counter-instruction whenever the prompt mentions warm light
// sources, telling Flux to keep the FACE specifically lit by neutral fill.
const TUNGSTEN_GUARD = ' IMPORTANT: even though the scene has warm lamp/tungsten/golden ambient light, her FACE itself must be lit by a NEUTRAL soft fill light so her wheatish complexion stays visible at hex #A17B63, the face is NOT bronzed by the warm ambient.';

function enforceFrameworkKeywords(prompt, angle) {
  const required = FRAMEWORK_KEYWORDS[angle];
  if (!required) return prompt;
  const lower = prompt.toLowerCase();
  const missing = required.filter(kw => !lower.includes(kw.toLowerCase()));
  if (missing.length === 0) return prompt;
  log.warn(`Gemini's image_prompt for ${angle} is missing required keywords: [${missing.join(', ')}]. Splicing them in.`);
  // Append a forceful clause at the end — Flux weights end-of-prompt strongly.
  const splice = ` Scene MUST visibly include: ${missing.join(', ')}, prominently featured.`;
  return prompt + splice;
}

// Compact / front-loaded prompt builder. Flux Dev follows short prompts
// (~150 words) far better than long ones. We extract the SCENE and OUTFIT
// description from Gemini's draft, drop all the redundant bloat, and produce
// a tight prompt with elements ordered by Flux-weight importance:
//   1. Subject + identity (face/skin/hair) — highest weight
//   2. Body type — second highest
//   3. Specific garment color + construction — third
//   4. Key prop in hand or scene anchor — fourth
//   5. Framing — fifth
//   6. Lighting + style — last
function buildPromptFromConcept(concept, trigger) {
  // Use Gemini's image_prompt as the scene blueprint, but distil it down.
  const fullPrompt = concept.image_prompt || '';

  // Try to extract the SCENE clause (everything after the canonical anchor and body anchor)
  // The full prompt typically starts with identity/body anchors (which we'll re-inject
  // ourselves with a tight version) followed by the scene-specific text.
  let sceneText = fullPrompt;
  const sceneMatch = fullPrompt.match(/never artificial\.\s*(.+)$/i);
  if (sceneMatch) sceneText = sceneMatch[1];
  // Strip embedded "Real DSLR ... NEVER dusky" identity blocks if present
  sceneText = sceneText
    .replace(/Real DSLR photograph of[^.]+\./gi, '')
    .replace(/Long dark brown softly wavy[^.]+\./gi, '')
    .replace(/Soft natural glam makeup[^.]+\./gi, '')
    .replace(/Small gold hoop[^.]+\./gi, '')
    .replace(/Visibly hourglass figure[^.]+\./gi, '')
    .replace(/IMPORTANT:[^.]+\./gi, '')
    .replace(/Composition is full-body[^.]+\./gi, '')
    .replace(/Full-body shot showing[^.]+\./gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // TIGHT identity (50 words) — only the locked-down face/skin/hair anchors.
  const tightIdentity = `Real DSLR photo of ${trigger} woman, 25-year-old Indian model, fair north-Indian wheatish skin (hex #A17B63, NEVER bronze NEVER tanned NEVER dusky), long loose dark-brown wavy hair, soft glam mauve-pink lip, gold hoops, oval face`;

  // TIGHT body (25 words)
  const tightBody = `hourglass figure with defined waist and fuller hips and bust like Disha Patani / Tara Sutaria, never stick-thin, never boyish`;

  // FRAMING (15 words)
  const tightFraming = `full-body shot from head to mid-shin, entire outfit visible, magazine-cover composition`;

  // STYLE (20 words)
  const tightStyle = `shot on iPhone 15 Pro Max, photorealistic skin with visible pores, raw 35mm-grain documentary aesthetic, NOT cgi NOT cartoon`;

  // Build the final prompt: identity first, body second, scene third (Gemini's),
  // framing fourth, style last. Total ~150 words.
  let prompt = `${tightIdentity}. ${tightBody}. ${sceneText}. ${tightFraming}. ${tightStyle}.`;

  // Ensure framework-required keywords are present (validator only — Gemini
  // usually copies them from the framework prompt_template now, but if not we
  // splice them in).
  prompt = enforceFrameworkKeywords(prompt, concept.angle);

  // Tungsten guard — widened to catch "vanity bulb", "warm bulb", etc.
  if (/tungsten|warm lamp|brass lamp|warm tungsten|reading lamp|bedside lamp|vanity bulb|vanity light|warm bulb|incandescent|warm cinematic/i.test(prompt)) {
    prompt += ` Face is NEUTRALLY lit by soft cool fill light from off-camera so wheatish complexion stays #A17B63 — do NOT bronze the face with the warm ambient.`;
  }

  // Final dignity register — EDITORIAL not modesty. Cleavage allowed if it
  // reads like Vogue / Elle / Disha Patani magazine, not OnlyFans / thirst-trap.
  // We removed the old "NEVER cleavage" hard ban because the user wants
  // editorial-grade allure on Friday lure + weekend lifestyle.
  const editorialRegister = `Vogue India / Elle India editorial register, Disha-Patani-magazine-cover energy, magnetic alluring desirable, cleavage and decolletage are fine if they read editorial, NOT OnlyFans NOT thirst-trap NOT crude NOT trashy NOT lingerie-only NOT bedroom-vulgar`;

  return `${prompt} ${editorialRegister}.`;
}

async function renderLurePhoto({ persona, sceneKey, calendarId }) {
  const trigger = persona.active_lora_trigger || 'AVI_TOK';
  const prompt = buildPrompt(sceneKey, persona, trigger);
  const seed = Math.floor(Math.random() * 1_000_000);

  const result = await runModel('flux_dev_lora', {
    prompt,
    lora_weights: persona.active_lora_url,
    lora_scale: 1.0,
    aspect_ratio: '9:16',  // True portrait so full-body composition fits without cropping at hips
    num_outputs: 1,
    num_inference_steps: 80,  // More steps = better complex-prop rendering (phone in hand, specific neckline)
    guidance: 5.5,           // Higher guidance = Flux follows the prompt more strictly (less LoRA latent drift)
    output_format: 'webp',
    output_quality: 100,
    go_fast: false,
    seed,
  }, { timeoutMs: 240_000 });

  const remoteUrl = result.output[0];
  const destPath = `lure-photos/${new Date().toISOString().slice(0, 10)}/${sceneKey}-${Date.now()}.webp`;
  const hosted = await rehostImage(remoteUrl, destPath);
  return { ...hosted, sceneKey, prompt, seed, costUsd: result.cost_usd };
}

async function main() {
  const args = parseArgs(process.argv);
  const persona = await personaService.getActivePersona();
  if (!persona.active_lora_url) {
    log.error('Persona has no active_lora_url. Train Avi LoRA first.');
    process.exit(1);
  }

  const trigger = persona.active_lora_trigger || 'AVI_TOK';
  const db = dbModule.getClient();

  // ===== NEW PATH: If a concept_id is provided, use the LLM-generated image_prompt =====
  let concept = null;
  if (args.conceptId) {
    const { data } = await db.from('reel_concepts').select('*').eq('id', args.conceptId).maybeSingle();
    concept = data;
  } else if (args.calendarId) {
    const { data: cal } = await db.from('content_calendar').select('concept_id').eq('id', args.calendarId).maybeSingle();
    if (cal?.concept_id) {
      const { data } = await db.from('reel_concepts').select('*').eq('id', cal.concept_id).maybeSingle();
      concept = data;
    }
  }

  if (concept && concept.image_prompt) {
    log.info(`Using LLM-generated image_prompt from concept ${concept.id} (angle: ${concept.angle})`);
    const prompt = buildPromptFromConcept(concept, trigger);

    if (args.dryRun) {
      log.info(`DRY RUN — would render with prompt:`);
      log.info(prompt);
      return;
    }

    const seed = Math.floor(Math.random() * 1_000_000);
    const result = await runModel('flux_dev_lora', {
      prompt,
      lora_weights: persona.active_lora_url,
      lora_scale: 1.0,
      aspect_ratio: '9:16',  // True portrait so full-body composition fits without cropping at hips
      num_outputs: 1,
      num_inference_steps: 80,  // More steps = better complex-prop rendering
      guidance: 5.5,           // Higher guidance = Flux follows the prompt more strictly
      output_format: 'webp',
      output_quality: 100,
      go_fast: false,
      seed,
    }, { timeoutMs: 240_000 });

    const remoteUrl = result.output[0];
    const destPath = `lure-photos/${new Date().toISOString().slice(0, 10)}/${concept.angle || 'concept'}-${Date.now()}.webp`;
    const hosted = await rehostImage(remoteUrl, destPath);

    log.info(`══════════════════════════════════════════════`);
    log.info(`✓ Lure photo rendered (LLM-driven framework: ${concept.angle}).`);
    log.info(`   url   : ${hosted.publicUrl}`);
    log.info(`   cost  : ~$${result.cost_usd.toFixed(3)}`);

    if (args.calendarId) {
      await db.from('content_calendar').update({
        output_url: hosted.publicUrl, state: 'done', completed_at: new Date().toISOString(),
        cost_usd: result.cost_usd, updated_at: new Date().toISOString(),
      }).eq('id', args.calendarId);
      log.info(`   calendar row ${args.calendarId} marked done`);
    }
    console.log(JSON.stringify({ ok: true, url: hosted.publicUrl, sceneKey: concept.angle, sceneLabel: concept.title, costUsd: result.cost_usd }));
    return;
  }

  // ===== LEGACY PATH: hardcoded scene (used as fallback if no concept) =====
  log.warn('No concept with image_prompt found. Falling back to hardcoded SCENES rotation.');
  const sceneKey = (args.scene && SCENES[args.scene]) ? args.scene : pickSceneForToday();
  log.info(`Scene: ${sceneKey} — ${SCENES[sceneKey].label}`);

  if (args.dryRun) {
    log.info(`DRY RUN — would render with prompt:`);
    log.info(buildPrompt(sceneKey, persona, trigger));
    return;
  }

  const result = await renderLurePhoto({ persona, sceneKey, calendarId: args.calendarId });

  log.info(`══════════════════════════════════════════════`);
  log.info(`✓ Lure photo rendered.`);
  log.info(`   url   : ${result.publicUrl}`);
  log.info(`   scene : ${sceneKey} (${SCENES[sceneKey].label})`);
  log.info(`   cost  : ~$${result.costUsd.toFixed(3)}`);
  log.info(`══════════════════════════════════════════════`);

  // If bound to a calendar row, update it
  if (args.calendarId) {
    const db = dbModule.getClient();
    await db.from('content_calendar').update({
      output_url: result.publicUrl,
      state: 'done',
      completed_at: new Date().toISOString(),
      cost_usd: result.costUsd,
      updated_at: new Date().toISOString(),
    }).eq('id', args.calendarId);
    log.info(`   calendar row ${args.calendarId} marked done`);
  }

  // Print structured output the chain orchestrator can parse
  console.log(JSON.stringify({ ok: true, url: result.publicUrl, sceneKey, sceneLabel: SCENES[sceneKey].label, costUsd: result.costUsd }));
}

module.exports = { renderLurePhoto, SCENES, pickSceneForToday };

// CLI
if (require.main === module) {
  main().catch((err) => {
    log.error(`Fatal: ${err.message}`);
    log.error(err.stack);
    console.log(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  });
}
