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
const SCENES = {
  mirror_selfie: {
    label: 'Getting ready mirror selfie',
    scene: 'taking a casual mirror selfie with her phone covering part of her face, standing in a chic modern bathroom or walk-in closet, looking effortlessly stunning, soft warm vanity lighting, highly natural candid feel',
    outfit: 'elegant fitted black evening dress, classy yet alluring, hair perfectly styled with loose waves falling over one shoulder',
  },
  cafe_candid: {
    label: 'Candid cafe moment',
    scene: 'sitting at a trendy aesthetic cafe, looking up from her iced coffee with a genuine radiant smile, candid mid-laugh expression, natural sunlight hitting her face, blurry background of cafe patrons and greenery',
    outfit: 'stylish oversized white linen shirt slightly unbuttoned over a simple fitted camisole, effortless weekend chic, delicate gold jewelry',
  },
  golden_hour_car: {
    label: 'Driving at golden hour',
    scene: 'sitting in the driver seat of a luxury car with the window down, golden hour sunlight streaming in and illuminating her hair, looking out the window with a serene confident expression, wind slightly blowing her hair',
    outfit: 'casual but expensive-looking beige knit top, designer sunglasses resting on her head',
  },
  dancing_candid: {
    label: 'Random dancing candid',
    scene: 'captured mid-twirl or dancing playfully in a beautiful minimalist apartment living room, motion blur on the edges, big genuine laugh, looking away from the camera, warm evening ambient lighting',
    outfit: 'flowing silk slip dress, elegant and fluid, bare feet, hair moving dynamically with the motion',
  },
  vacation_stroll: {
    label: 'Vacation evening stroll',
    scene: 'walking down a cobblestone street in a European-style town at dusk, looking back over her shoulder at the camera with an inviting smile, fairy lights and blurred restaurant patios in the background',
    outfit: 'chic summer evening outfit, off-the-shoulder top with a flowing skirt, effortless high-end vacation aesthetic',
  },
  morning_routine: {
    label: 'Morning routine natural',
    scene: 'standing in a bright modern kitchen, holding a matcha latte, looking directly at the camera with a fresh-faced, "I woke up like this" natural smile, bright morning light filling the room',
    outfit: 'cozy high-end matching lounge set, hair tied up in a messy bun with face-framing pieces, minimal makeup look',
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

function buildPrompt(sceneKey, persona, trigger) {
  const scene = SCENES[sceneKey];
  return [
    `Real DSLR photograph of ${trigger} woman, a 25-year-old Indian content creator.`,
    scene.scene + '.',
    `Wearing: ${scene.outfit}.`,
    `Photographic style: shot on iPhone 15 Pro, casual Instagram influencer aesthetic, photorealistic ultra-detailed natural skin texture, candid documentary feel, highly engaging, highly attractive and desirable but classy, natural slice-of-life moment, NOT illustration, NOT cartoon, NOT cgi, NOT 3D render.`,
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
    prompt = `Real DSLR photograph of ${trigger} woman, a 25-year-old Indian content creator. ${prompt}`;
  }
  // Reinforce style if the LLM forgot
  if (!prompt.toLowerCase().includes('iphone') && !prompt.toLowerCase().includes('photographic style')) {
    prompt += ' Shot on iPhone 15 Pro, casual Instagram influencer aesthetic, photorealistic ultra-detailed natural skin texture, candid documentary feel.';
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
    num_inference_steps: 28,
    guidance: 3.0,
    output_format: 'webp',
    output_quality: 95,
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
      num_inference_steps: 28,
      guidance: 3.0,
      output_format: 'webp',
      output_quality: 95,
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
