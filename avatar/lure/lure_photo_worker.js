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

const log = createLogger('lure_photo');

const W = 1080;
const H = 1350;

// 6 lure scene templates. Focus: highly engaging, natural slice-of-life moments.
// 20 curated lure scenes across 4 brand buckets (Editorial Bold, Aspirational Casual, Traditional Elegance, Luxury Lifestyle)
// Every scene has a CONTEXT (place + activity + prop) so it reads as 'lifestyle moment', not 'body shot'.
const SCENES = {
  // === EDITORIAL BOLD (5) ===
  beach_editorial: {
    label: 'Editorial beach in Goa',
    scene: 'standing on pristine white-sand beach holding a fresh coconut, confident magnetic gaze at camera, golden hour sunlight, Vogue India editorial framing, ocean and palm trees blurred behind',
    outfit: 'minimalist black bikini with delicate gold body chain, beachy waves in hair, sunkissed skin, no excessive makeup',
  },
  hotel_balcony_slip: {
    label: 'Luxury hotel suite balcony',
    scene: 'standing on a luxury hotel suite balcony at golden hour, holding a coffee cup from the in-room espresso machine, looking out at city skyline, smirking slightly, hair tousled, classy slice-of-life moment',
    outfit: 'deep emerald silk slip dress, delicate diamond necklace, hair in loose waves',
  },
  infinity_pool_book: {
    label: 'Infinity pool with book',
    scene: 'lounging at the edge of an infinity pool overlooking a tropical jungle, reading a hardcover book on AI strategy, holding a glass of fresh coconut water, oversized Celine sunglasses on head, perfect blend of intellect and aesthetic',
    outfit: 'white one-piece swimsuit with elegant cutouts, classy resort aesthetic, no jewelry',
  },
  rooftop_bar_red: {
    label: 'Rooftop bar Mumbai night',
    scene: 'late night at exclusive rooftop bar in Mumbai, holding a martini glass, paparazzi flash photography style candid, city lights blurred behind, magnetic talk-of-the-town energy',
    outfit: 'bold tailored red blazer with nothing underneath, sleek black trousers, delicate diamond drop earrings',
  },
  pilates_post: {
    label: 'Post-pilates studio mirror',
    scene: 'post-workout mirror selfie inside a high-end pilates studio, glowing natural skin with light sweat, messy high bun, holding a sleek steel water bottle, aspirational fitness-lifestyle aesthetic',
    outfit: 'matching sage green Alo Yoga sports bra and leggings set',
  },

  // === ASPIRATIONAL CASUAL (5) ===
  bandra_sunday_coffee: {
    label: 'Sunday Bandra apartment coffee',
    scene: 'Sunday morning in her minimalist Bandra apartment, sitting on a plush cream sofa with legs tucked in, holding a ceramic mug of black coffee, looking out the window, slice-of-life cozy moment',
    outfit: 'oversized grey sweatpants and tight white ribbed tank top, barefoot, no makeup, hair in a messy bun',
  },
  cafe_macbook_laugh: {
    label: 'Indie coffee roastery candid',
    scene: 'caught mid-laugh at chic indie coffee roastery, looking off-camera at someone, an open MacBook with code on the screen and a half-eaten croissant on the table, smart-approachable beauty, natural daylight from window',
    outfit: 'vintage Levi 501 jeans, crisp white t-shirt, delicate gold layered necklaces, hair in a messy braid',
  },
  european_street_trench: {
    label: 'European street walk',
    scene: 'walking down a sun-dappled street in Lisbon or Paris, looking back over her shoulder at camera with a bright genuine smile, cobblestones and old-world facades behind, travel-influencer aesthetic',
    outfit: 'beige trench coat over a black mini dress, knee-high leather boots, oversized sunglasses pushed back on head',
  },
  vanity_getting_ready: {
    label: 'Getting ready at vanity',
    scene: 'sitting at a sleek modern vanity applying a subtle nude lipstick, looking into the mirror, plush white hotel robe slipped slightly off one shoulder, perfect glowing skin, soft diffused warm lighting',
    outfit: 'plush white luxury hotel robe',
  },
  vinyl_records_floor: {
    label: 'Vinyl records on the floor',
    scene: 'sitting cross-legged on a patterned Persian rug surrounded by vintage vinyl records, adjusting the needle on a turntable, warm afternoon light through window, boho-chic cultured vibe',
    outfit: 'oversized vintage band t-shirt tucked into denim shorts, no shoes, hair in a low loose bun',
  },

  // === TRADITIONAL ELEGANCE (5) ===
  diwali_party_saree: {
    label: 'Diwali party midnight saree',
    scene: 'attending a high-end Diwali celebration, looking directly at camera with elegant powerful gaze, soft glowing diyas blurred in background, Bollywood-actress-tier glamour, festive warm lighting',
    outfit: 'breathtaking contemporary midnight-blue sequined saree, hair in sleek waves, heavy oxidized silver jhumka earrings, delicate bindi',
  },
  red_kanjeevaram: {
    label: 'Festival red Kanjeevaram',
    scene: 'close-up portrait during a traditional Indian festival, looking down slightly with a soft demure smile, deeply rooted cultural beauty, warm golden festival lighting',
    outfit: 'heavy red Kanjeevaram silk saree, gold choker necklace, intricate gold jhumkas, small elegant bindi',
  },
  udaipur_lehenga_twirl: {
    label: 'Udaipur palace lehenga twirl',
    scene: 'twirling joyfully in a heritage palace courtyard in Udaipur, sunlight catching the embroidery, vibrant celebratory motion blur, modern-Indian aesthetic',
    outfit: 'pastel floral lehenga with intricate embroidery, traditional jewelry, hair half-up half-down with floral hair clip',
  },
  vintage_ambassador_saree: {
    label: 'Vintage Ambassador car saree',
    scene: 'sitting in a vintage white Ambassador car at sunset, oversized vintage sunglasses, looking out the open window with a soft confident smile, old-money Indian royalty aesthetic, deeply elegant and timeless',
    outfit: 'crisp white linen saree with sleeveless blouse, vintage gold drop earrings, no excess accessories',
  },
  festive_kurta_mirror: {
    label: 'Festive kurta mirror selfie',
    scene: 'mirror selfie before heading out for a festival, adjusting a heavy gold earring, modern influencer format applied to traditional attire, warm golden hour light streaming through window',
    outfit: 'heavy velvet kurta with intricate zari work in deep burgundy, traditional gold jewelry, hair in a low bun with maang tikka',
  },

  // === LUXURY LIFESTYLE (5) ===
  porsche_golden_hour: {
    label: 'Luxury SUV golden hour',
    scene: 'sitting in the driver seat of a Porsche or Range Rover with beige leather interior, golden hour light hitting her face, looking forward with effortless wealth aura, hand resting on the leather steering wheel',
    outfit: 'crisp white linen shirt unbuttoned at the collar, delicate gold layered necklaces, designer aviator sunglasses on the head',
  },
  business_class_champagne: {
    label: 'Business class flight',
    scene: 'relaxing in a lie-flat Business Class airplane seat on an international flight, holding a glass of champagne, looking out the window at clouds, jet-setter aspiration, soft cabin lighting',
    outfit: 'matching camel-colored cashmere lounge set, comfortable but extremely expensive looking',
  },
  omakase_solo: {
    label: 'Solo omakase fine dining',
    scene: 'solo fine-dining at an omakase restaurant counter, beautifully plated sushi and a glass of red wine on the wooden bar in front, looking at camera with a sophisticated knowing smile, warm restaurant lighting',
    outfit: 'sleek black halter-neck dress, minimalist gold cuff bracelet, hair in a sleek low ponytail',
  },
  art_gallery_blazer: {
    label: 'Contemporary art gallery',
    scene: 'exploring a contemporary art gallery, hands in pockets, looking thoughtfully at a large abstract painting, intellectual-wealthy-cultured aura, soft museum lighting',
    outfit: 'tailored oversized beige suit with a white silk camisole underneath, sleek black loafers, hair in loose waves',
  },
  yacht_white_linen: {
    label: 'Private yacht golden hour',
    scene: 'golden hour on a private yacht, holding a woven sun hat in one hand, dress and hair flowing in the wind, the ultimate expression of freedom and success, ocean horizon behind',
    outfit: 'flowing white linen maxi dress with a low V-back, barefoot, gold ankle bracelet',
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

// The base prefix enforces the photographic style and the strict "NOT cgi" guardrails
// Tuned for Samiikssha-tier realism: specific lens, film stock, lighting anchors.
const STYLE_ANCHOR = `Photographic style: shot on iPhone 15 Pro Max main camera, 24mm lens, photorealistic ultra-detailed natural skin texture, visible pores, natural subtle makeup, cinematic depth of field, casual Instagram influencer aesthetic, candid documentary feel, highly engaging, highly attractive and desirable but classy, natural slice-of-life moment, soft ambient lighting, NOT illustration, NOT cartoon, NOT cgi, NOT 3D render, no plastic skin.`;

// Tasteful body descriptor: visibly hourglass figure with fuller hips and
// defined waist that reads as natural and aspirational, not exaggerated/fake.
// Applied ONLY to lure photos (Friday) and lifestyle videos (Sat-Sun).
// Tech reels stay head-and-shoulders unchanged.
const CURVY_BODY = 'tasteful hourglass figure, gently fuller hips, defined waist, naturally proportioned bust, soft feminine silhouette, natural body curves, never exaggerated, never artificial';

function buildPrompt(sceneKey, persona, trigger) {
  const scene = SCENES[sceneKey];
  return [
    `Real DSLR photograph of ${trigger} woman, a 25-year-old Indian content creator with ${CURVY_BODY}.`,
    scene.scene + '.',
    `Wearing: ${scene.outfit}.`,
    STYLE_ANCHOR,
  ].join(' ');
}

/**
 * NEW: Build a prompt directly from the LLM-generated image_prompt on the concept.
 * This is used when the lure photo is part of an LLM-drafted concept (post-Phase 16).
 */
function buildPromptFromConcept(concept, trigger) {
  let prompt = concept.image_prompt || '';
  // Ensure the LoRA trigger token is present
  if (!prompt.includes(trigger) && !prompt.includes('AVI_TOK')) {
    prompt = `Real DSLR photograph of ${trigger} woman, a 25-year-old Indian content creator with ${CURVY_BODY}. ${prompt}`;
  } else if (!prompt.toLowerCase().includes('hourglass') && !prompt.toLowerCase().includes('curves')) {
    // LLM-supplied prompt didn't describe the body — inject the curvy descriptor early.
    prompt = prompt.replace(
      /Indian content creator/i,
      `Indian content creator with ${CURVY_BODY}`
    );
  }
  // Reinforce style if the LLM forgot
  if (!prompt.toLowerCase().includes('iphone') && !prompt.toLowerCase().includes('photographic style')) {
    prompt += ` ${STYLE_ANCHOR}`;
  }
  return prompt;
}

async function renderLurePhoto({ persona, sceneKey, calendarId }) {
  const trigger = persona.active_lora_trigger || 'AVI_TOK';
  const prompt = buildPrompt(sceneKey, persona, trigger);
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
      aspect_ratio: '4:5',
      num_outputs: 1,
      num_inference_steps: 50,
      guidance: 3.5,
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
