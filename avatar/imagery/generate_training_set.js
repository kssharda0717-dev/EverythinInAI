#!/usr/bin/env node
/**
 * EverythinInAI — Generate Avi Training Set
 *
 * Generates 20 photoreal portraits of Avi using Flux 1.1 Pro from her
 * canonical face anchor + persona DNA. These become the training data
 * for the LoRA.
 *
 * Strategy: We use the existing chosen face anchor as a "seed" via Flux
 * Redux's image_prompt feature, so all 20 training portraits resemble
 * the same girl. Each portrait varies pose, expression, lighting,
 * outfit, and background to give the LoRA enough diversity.
 *
 * Cost: 20 × $0.04 = $0.80
 * Time: ~6-8 min (parallel where rate limits allow)
 *
 * Usage:
 *   node avatar/imagery/generate_training_set.js
 *   node avatar/imagery/generate_training_set.js --count=20
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');
const { runModel } = require('./replicate_client');
const { rehostImage } = require('./storage');

const log = createLogger('training_set');

function parseArgs(argv) {
  const args = { count: 20 };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--count=')) args.count = parseInt(a.split('=')[1], 10);
  }
  return args;
}

// 20 distinct prompt variations for training-set diversity
const VARIATIONS = [
  { pose: 'looking directly at camera, soft confident smile', outfit: 'fitted ribbed cream knit top with high crew neck', light: 'soft golden hour window light from left', bg: 'minimalist Bandra apartment, beige wall, soft plants in bokeh' },
  { pose: 'three-quarter angle looking slightly off-camera, gentle smile', outfit: 'oversized beige cardigan over high-neck cream top', light: 'soft natural overcast diffused light', bg: 'cozy book-lined corner, warm wood, hardcover books in bokeh' },
  { pose: 'looking down thoughtfully, soft contemplative expression', outfit: 'fitted forest green ribbed knit turtleneck', light: 'studio editorial side light, soft fill', bg: 'cream studio backdrop, subtle vignette' },
  { pose: 'slight smirk, eyes meeting camera, hair tucked behind one ear', outfit: 'cream silk blouse buttoned up to high neck, layered gold pendant', light: 'warm tungsten interior light', bg: 'warm cafe ambience with pendant lights in deep bokeh' },
  { pose: 'gentle laugh caught mid-moment, eyes crinkling', outfit: 'fitted ivory cashmere sweater', light: 'soft natural window light from right', bg: 'minimalist apartment, plants, hardcover books on shelf' },
  { pose: 'serious editorial expression, calm confidence', outfit: 'tailored beige blazer buttoned over high-neck cream top', light: 'studio editorial key + soft fill at 45 degrees', bg: 'soft cream gradient backdrop' },
  { pose: 'close-up portrait looking at camera, hair softly framing face', outfit: 'cream ribbed turtleneck', light: 'golden hour soft warm light', bg: 'soft beige wall, subtle out-of-focus plants' },
  { pose: 'side profile, head turned slightly toward camera, eyes glancing back', outfit: 'olive green oversized blazer over high-neck top', light: 'natural daylight, soft shadows', bg: 'art-gallery white wall' },
  { pose: 'looking up slightly, gentle warm expression', outfit: 'fitted forest green ribbed top', light: 'soft window light with subtle rim light', bg: 'cozy reading nook, books and plants' },
  { pose: 'sitting at a desk, hands on keyboard, looking up at camera', outfit: 'cream ribbed knit top with high crew neck', light: 'natural daylight from large window', bg: 'minimalist studio apartment with matte black laptop visible' },
  { pose: 'leaning slightly forward, focused engaged expression', outfit: 'beige cashmere turtleneck', light: 'soft editorial three-point lighting', bg: 'soft warm interior, plants in bokeh' },
  { pose: 'hand near chin in thoughtful gesture, slight smile', outfit: 'oversized cream cardigan over high-neck top', light: 'natural warm light from window', bg: 'cozy interior with hardcover books' },
  { pose: 'natural candid expression, soft smile, hair in low loose bun', outfit: 'fitted ivory ribbed knit top', light: 'soft studio softbox lighting', bg: 'minimalist beige wall with one framed art piece' },
  { pose: 'gentle smile, head slightly tilted, soft eye contact', outfit: 'forest green high-neck knit', light: 'golden hour warm rim light', bg: 'plants and warm wood interior' },
  { pose: 'looking at camera with calm confident expression, holding ceramic matcha cup', outfit: 'cream ribbed knit top', light: 'soft daylight, subtle highlights', bg: 'kitchen counter with plants and ceramic items' },
  { pose: 'soft laugh with hand near collarbone, candid moment', outfit: 'beige oversized cardigan over high-neck cream top', light: 'natural daylight from large window', bg: 'minimalist apartment with bookshelf' },
  { pose: 'reading a hardcover book, glancing up at camera, soft expression', outfit: 'forest green ribbed turtleneck', light: 'warm interior tungsten light', bg: 'library-style book wall in soft focus' },
  { pose: 'eyes meeting camera, soft asymmetric smile, head tilted', outfit: 'cream silk blouse buttoned to neck, gold pendant', light: 'editorial soft key light from left', bg: 'cream studio backdrop' },
  { pose: 'standing thoughtful pose, hand resting near collarbone, looking at camera', outfit: 'tailored beige blazer over high-neck top', light: 'natural soft daylight', bg: 'minimalist studio with one plant' },
  { pose: 'gentle warm smile, hair softly waved framing face', outfit: 'fitted ivory ribbed knit top with high crew neck', light: 'soft golden hour, warm tones', bg: 'soft beige wall with subtle bokeh greenery' },
];

function buildPrompt(variation) {
  return [
    `Real DSLR photograph (NOT illustration, NOT painting, NOT cartoon, NOT cgi, NOT digital art) of a 25-year-old Indian woman of mixed Tamil-North Indian heritage.`,
    `Warm wheatish skin tone with natural visible pores and fine peach fuzz, soft heart-shaped face with defined cheekbones, full natural lips, large almond-shaped dark brown eyes with thick natural lashes, neat naturally-shaped eyebrows.`,
    `Long dark brown hair softly waved or in an effortless low bun, athletic-feminine build with normal proportions, defined collarbones, narrow waist.`,
    `Pose: ${variation.pose}.`,
    `Wearing: ${variation.outfit}. Modest, sophisticated, NEVER plunging neckline, NEVER showing cleavage. Delicate matte gold jewelry only.`,
    `Lighting: ${variation.light}.`,
    `Background: ${variation.bg}.`,
    `Editorial portrait photograph, shot on Sony A7R IV with 85mm f/1.8 lens, shallow depth of field, photorealistic, ultra-detailed natural skin texture with fine pores, subtle 35mm film grain, magazine quality, Vogue India aesthetic.`,
  ].join(' ');
}

async function main() {
  const args = parseArgs(process.argv);
  const persona = await personaService.getActivePersona('avi');
  const anchor = persona.canonical_face_url;
  if (!anchor) {
    log.error('Persona has no canonical_face_url. Run choose_face_anchor.js first.');
    process.exit(1);
  }

  log.info(`Generating ${args.count} training portraits for ${persona.display_name}...`);
  log.info(`Using face anchor as visual reference: ${anchor}`);

  const db = dbModule.getClient();
  const variations = VARIATIONS.slice(0, args.count);
  const generated = [];

  for (let i = 0; i < variations.length; i++) {
    const v = variations[i];
    log.info(`──────────────────────────────────────────`);
    log.info(`Training image ${i + 1}/${variations.length}`);

    const prompt = buildPrompt(v);
    const seed = Math.floor(Math.random() * 1_000_000);

    let result;
    try {
      result = await runModel('flux_pro', {
        prompt,
        image_prompt: anchor,         // Flux Redux: use anchor as composition guide
        aspect_ratio: '4:5',
        output_format: 'webp',
        output_quality: 95,
        safety_tolerance: 2,
        seed,
      });
    } catch (err) {
      log.error(`Image ${i + 1} failed: ${err.message}`);
      continue;
    }

    const remoteUrl = result.output[0];
    const destPath = `training/${persona.slug}/${Date.now()}-${i}.webp`;
    let hosted;
    try {
      hosted = await rehostImage(remoteUrl, destPath);
    } catch (err) {
      log.error(`Rehost failed: ${err.message}`);
      continue;
    }

    // Reuse face_anchors table to store training images (with notes='training')
    await db.from('face_anchors').insert({
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
      notes: 'training_set',
    });

    generated.push({ idx: i + 1, url: hosted.publicUrl });
    log.info(`✓ ${i + 1}: ${hosted.publicUrl}`);

    // Small breather to be gentle on Replicate's rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  log.info(`──────────────────────────────────────────`);
  log.info(`✓ Generated ${generated.length}/${variations.length} training portraits.`);
  log.info(`   Total cost: ~$${(0.04 * generated.length).toFixed(2)}`);
  log.info(`   Storage path prefix: training/${persona.slug}/`);
  log.info(`   Next step: node avatar/imagery/train_lora.js`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
