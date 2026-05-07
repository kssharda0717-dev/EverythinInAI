#!/usr/bin/env node
/**
 * EverythinInAI — Generate Face Anchor Candidates
 *
 * One-shot setup script. Generates 4 candidate portraits of Avi using
 * Flux 1.1 Pro + her DNA from the personas table, uploads them to
 * Supabase Storage, and inserts rows into face_anchors so the user can
 * pick a winner via the next script (choose_face_anchor.js) or via the
 * frontend gallery (Phase 9b).
 *
 * Usage:
 *   node avatar/imagery/generate_face_anchors.js
 *   node avatar/imagery/generate_face_anchors.js --count=6
 *
 * Cost: ~$0.16 for 4 images @ Flux Pro
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');
const { runModel } = require('./replicate_client');
const { rehostImage } = require('./storage');

const log = createLogger('face_anchors');

function parseArgs(argv) {
  const args = { count: 4 };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--count=')) args.count = parseInt(a.split('=')[1], 10);
  }
  return args;
}

const POSE_VARIANTS = [
  'looking directly at camera, soft confident asymmetric smile, head tilted slightly',
  'three-quarter angle, gentle natural smile, looking slightly off-camera',
  'looking down thoughtfully, soft contemplative expression, lashes catching the light',
  'slight smirk, eyes meeting camera, hair tucked behind one ear',
  'gentle laugh caught mid-moment, eyes crinkling, natural warmth',
  'serious editorial expression, calm confidence, neutral mouth',
];

const LIGHTING_VARIANTS = [
  'soft golden hour window light from the left, warm tones, subtle rim light',
  'soft natural overcast light, even skin tones, slight cool undertone',
  'studio editorial lighting, key light at 45 degrees, soft fill, gentle background gradient',
  'warm interior tungsten light, slight bokeh background of plants and books',
];

const BACKGROUND_VARIANTS = [
  'minimalist Bandra studio apartment, beige wall, soft out-of-focus plants',
  'cozy book-lined corner, warm wood tones, hardcover books out of focus',
  'soft cream studio backdrop, subtle vignette, professional editorial portrait',
  'warm cafe ambience, soft bokeh of pendant lights in the deep background',
];

function buildAnchorPrompt(persona, idx) {
  const pose = POSE_VARIANTS[idx % POSE_VARIANTS.length];
  const lighting = LIGHTING_VARIANTS[idx % LIGHTING_VARIANTS.length];
  const background = BACKGROUND_VARIANTS[idx % BACKGROUND_VARIANTS.length];

  return [
    persona.visual_descriptor,
    `Wearing a fitted ribbed cream knit top, simple gold pendant necklace, no makeup beyond a touch of nude lip and natural eyeliner.`,
    `Pose: ${pose}.`,
    `Lighting: ${lighting}.`,
    `Background: ${background}.`,
    `Editorial portrait photograph, shot on Sony A7R IV, 85mm f/1.8 lens, shallow depth of field, photorealistic, ultra-detailed skin texture with natural fine pores and subtle film grain.`,
    `--no plastic skin, cartoon, anime, illustration, painting, deformed, extra limbs, low quality, watermark, text, logo, oversaturated`,
  ].join(' ');
}

async function main() {
  const args = parseArgs(process.argv);
  const persona = await personaService.getActivePersona('avi');
  log.info(`Generating ${args.count} face anchor candidates for ${persona.display_name}...`);

  const db = dbModule.getClient();
  const rows = [];

  for (let i = 0; i < args.count; i++) {
    const prompt = buildAnchorPrompt(persona, i);
    log.info(`──────────────────────────────────────────`);
    log.info(`Candidate ${i + 1}/${args.count}`);

    const seed = Math.floor(Math.random() * 1_000_000);

    let result;
    try {
      result = await runModel('flux_pro', {
        prompt,
        aspect_ratio: '4:5',
        output_format: 'webp',
        output_quality: 95,
        safety_tolerance: 2,   // strict — Flux Pro 1=most strict, 6=most permissive
        seed,
      });
    } catch (err) {
      log.error(`Candidate ${i + 1} failed: ${err.message}`);
      continue;
    }

    const remoteUrl = result.output[0];
    const destPath = `face-anchors/${persona.slug}/${Date.now()}-${i}.webp`;

    let hosted;
    try {
      hosted = await rehostImage(remoteUrl, destPath);
    } catch (err) {
      log.error(`Rehost failed: ${err.message}`);
      continue;
    }

    const { data, error } = await db.from('face_anchors').insert({
      persona_id: persona.id,
      image_url: hosted.publicUrl,
      storage_path: hosted.storagePath,
      model: 'flux-1.1-pro',
      prompt,
      seed,
      width: 832,
      height: 1024,
      cost_usd: result.cost_usd,
      is_chosen: false,
    }).select('id').single();

    if (error) {
      log.error(`DB insert failed: ${error.message}`);
      continue;
    }

    rows.push({ id: data.id, url: hosted.publicUrl, idx: i + 1 });
    log.info(`✓ Candidate ${i + 1} saved: ${hosted.publicUrl}`);
  }

  log.info(`──────────────────────────────────────────`);
  log.info(`✓ Generated ${rows.length} face anchor candidates.`);
  log.info(``);
  log.info(`To preview, open these URLs in your browser:`);
  for (const r of rows) {
    log.info(`  Candidate ${r.idx}  (id=${r.id.slice(0, 8)})`);
    log.info(`    ${r.url}`);
  }
  log.info(``);
  log.info(`Once you've picked your favorite, run:`);
  log.info(`  node avatar/imagery/choose_face_anchor.js <id>`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
