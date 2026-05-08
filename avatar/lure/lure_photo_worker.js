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

// 6 lure scene templates. Each is intellectual + attractive + classy.
const SCENES = {
  cafe_book: {
    label: 'Cafe with hardcover book',
    scene: 'sitting at a marble cafe table near a sunlit window, leaning slightly forward with a hardcover hardback book open in her lap, looking up softly at the camera with a warm knowing half-smile, ceramic latte cup beside the book, candid editorial moment, soft warm cafe ambience with pendant lights in deep bokeh',
    outfit: 'fitted cream cashmere sweater with high crew neck, modest sophisticated, no cleavage, hair softly waved and loose over shoulders, simple gold stud earrings, no necklace',
  },
  golden_rooftop: {
    label: 'Bandra rooftop at golden hour',
    scene: 'standing on a Bandra rooftop balcony with the Mumbai skyline in soft golden bokeh, three-quarter angle to camera with body slightly turned, hair gently moving in evening breeze, looking back over her shoulder toward camera with a soft confident smile, golden warm rim light catching her face',
    outfit: 'fitted ivory ribbed knit turtleneck tucked into high-waisted dark trousers, modest sophisticated, no cleavage, hair softly waved long, simple gold hoop earrings',
  },
  library_corner: {
    label: 'Library reading nook',
    scene: 'sitting in a cozy reading nook with floor-to-ceiling oak bookshelves behind, knees up with a hardcover book balanced on them, looking up softly at the camera mid-thought with finger pressed gently against her lower lip, sunlight from a high window catching one side of her face',
    outfit: 'oversized cream knit cardigan over fitted high-neck cream blouse, modest sophisticated, no cleavage, hair in low loose elegant bun with soft tendrils framing face, simple gold stud earrings',
  },
  apartment_laptop: {
    label: 'Minimalist apartment workspace',
    scene: 'sitting at a sleek minimalist desk in a sunlit Bandra apartment, three-quarter body angle, one hand resting on a matte black laptop keyboard, the other tucking a strand of hair behind her ear, looking sideways at the camera with a soft warm smile, plants and bookshelf in deep warm bokeh',
    outfit: 'tailored beige blazer over high-neck cream silk top, modest sophisticated, no cleavage, hair in low loose bun, simple small gold stud earrings, classy intellectual',
  },
  garden_morning: {
    label: 'Garden bench, morning light',
    scene: 'sitting elegantly on a wooden bench in a leafy private garden in the morning, leaves and soft greenery in bokeh, holding a steaming ceramic mug close to her face with both hands, looking softly at the camera with a peaceful contented smile, soft golden morning sunlight from camera-left',
    outfit: 'fitted cream cashmere sweater with high crew neck and oversized cream wool overcoat draped on her shoulders, modest sophisticated, no cleavage, hair softly waved long',
  },
  balcony_evening: {
    label: 'Apartment balcony at dusk',
    scene: 'standing leaning against an apartment balcony railing at dusk with city lights and warm fairy lights in deep bokeh behind, half-turned to camera, looking softly over her shoulder with a warm slightly mysterious smile, warm tungsten ambient light catching her cheekbones',
    outfit: 'fitted ivory silk blouse buttoned to high neck with delicate gold buttons, tucked into high-waisted dark trousers, modest sophisticated, no cleavage, hair softly waved',
  },
};

function parseArgs(argv) {
  const args = { scene: null, calendarId: null, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--scene=')) args.scene = a.split('=')[1];
    else if (a.startsWith('--calendar=')) args.calendarId = a.split('=')[1];
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
    `Photographic style: editorial portrait, shot on Sony A7R IV with 85mm prime at f/2.0, beautiful shallow depth of field, photorealistic ultra-detailed natural skin texture with visible pores, subtle 35mm film grain, magazine-quality, Vogue India aesthetic, candid documentary feel, intellectual + attractive + classy + sophisticated, NEVER skimpy, NEVER thirst-trap, NOT illustration, NOT cartoon, NOT cgi, NOT 3D render.`,
  ].join(' ');
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
  const persona = await personaService.getActivePersona('avi');
  if (!persona.active_lora_url) {
    log.error('Persona has no active_lora_url. Train Avi LoRA first.');
    process.exit(1);
  }

  const sceneKey = (args.scene && SCENES[args.scene]) ? args.scene : pickSceneForToday();
  log.info(`Scene: ${sceneKey} — ${SCENES[sceneKey].label}`);

  if (args.dryRun) {
    log.info(`DRY RUN — would render with prompt:`);
    log.info(buildPrompt(sceneKey, persona, persona.active_lora_trigger || 'AVI_TOK'));
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
