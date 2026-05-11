#!/usr/bin/env node
/**
 * EverythinInAI — Generate Avi Training Set (v2)
 *
 * Generates 20 photoreal portraits of Avi using Flux 1.1 Pro from her
 * persona DNA. The set is GENUINELY diverse: different outfits, framings,
 * angles, lighting, settings, expressions — so the LoRA learns Avi's
 * IDENTITY rather than memorizing one specific outfit + pose.
 *
 * Diversity matrix:
 *   - 5 framings: tight headshot / portrait / medium shot / 3/4 body / wide
 *   - 6 outfits: cream knit / forest green turtleneck / beige blazer /
 *                ivory silk blouse / olive cardigan / black hoodie
 *   - 4 settings: studio / Bandra apartment / cafe / library
 *   - 4 lighting: golden hour / studio editorial / overcast natural /
 *                 warm tungsten interior
 *   - 5 expressions: soft smile / neutral / laughing / thoughtful / mid-speech
 *
 * Cost: 20 × $0.04 = $0.80
 * Time: ~6-8 min
 *
 * Usage:
 *   node avatar/imagery/generate_training_set.js              # default 20
 *   node avatar/imagery/generate_training_set.js --reset      # delete prior set first
 *   node avatar/imagery/generate_training_set.js --count=24
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');
const { runModel } = require('./replicate_client');
const { rehostImage } = require('./storage');

const log = createLogger('training_set');

function parseArgs(argv) {
  const args = { count: 20, reset: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--count=')) args.count = parseInt(a.split('=')[1], 10);
    else if (a === '--reset') args.reset = true;
  }
  return args;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 20 GENUINELY DIVERSE training prompts.
// Each varies framing + outfit + setting + lighting + expression + angle.
// ═══════════════════════════════════════════════════════════════════════════════
const VARIATIONS = [
  // 1: Tight headshot, golden hour, soft smile, classic
  { framing: 'tight close-up headshot, face filling 60% of frame, eye-level camera', outfit: 'fitted cream ribbed knit turtleneck', setting: 'soft beige wall', light: 'soft golden hour window light from left, warm tones, subtle rim light', expression: 'gentle confident smile, eyes meeting camera directly' },

  // 2: Portrait shot, studio editorial, neutral
  { framing: 'shoulders-up portrait, eye-level camera', outfit: 'tailored beige blazer over high-neck cream top, layered gold pendant', setting: 'cream studio backdrop with subtle vignette', light: 'studio editorial three-point lighting, soft key from 45 degrees, soft fill', expression: 'calm neutral expression, slight asymmetric smirk' },

  // 3: Medium shot, Bandra apartment, mid-speech
  { framing: 'medium shot from chest up, slight three-quarter angle', outfit: 'oversized beige cardigan over high-neck cream tank', setting: 'minimalist Bandra apartment with plants and bookshelf in soft bokeh background', light: 'natural daylight from large window, soft warm tones', expression: 'mid-speech expression with hand gesturing near face' },

  // 4: 3/4 body shot, library, thoughtful
  { framing: '3/4 body shot showing waist up, slight three-quarter angle, hands holding hardcover book', outfit: 'fitted forest green ribbed knit turtleneck with high jeans', setting: 'cozy library with floor-to-ceiling bookshelves in warm bokeh', light: 'warm tungsten interior light with golden highlights', expression: 'soft thoughtful look down at the book, slight gentle smile' },

  // 5: Wide-ish shot, cafe, candid laugh
  { framing: 'wider shot showing torso and surroundings, sitting at a small marble cafe table', outfit: 'cream silk blouse buttoned to high neck with delicate gold necklace', setting: 'warm minimalist Bandra cafe with pendant lights and matcha latte on table', light: 'soft afternoon daylight with warm pendant lights bokeh', expression: 'genuine laugh caught mid-moment, eyes crinkling, head slightly tilted' },

  // 6: Profile shot, art gallery, serious
  { framing: 'side profile portrait, head turned slightly toward camera, eyes glancing back', outfit: 'olive green oversized blazer over high-neck cream top', setting: 'minimalist art gallery white wall with one framed black-and-white photograph', light: 'soft directional natural daylight from left, soft shadows', expression: 'serious editorial expression, calm confidence, neutral mouth' },

  // 7: High angle close-up, looking up, gentle
  { framing: 'close-up portrait shot from slightly above, head tilted up to look at camera', outfit: 'simple ivory tank top with oversized cream cardigan draped over shoulders', setting: 'soft cream studio backdrop', light: 'soft natural overcast diffused light, even skin tones', expression: 'gentle warm smile, soft eyes looking up, hair tucked behind one ear' },

  // 8: Low angle waist-up, courtyard, confident
  { framing: 'medium portrait from slightly below, looking down at camera, confident posture', outfit: 'fitted black ribbed knit top with high jeans (NOT plunging neckline)', setting: 'minimalist outdoor courtyard with white walls and a single tropical plant', light: 'soft afternoon daylight, golden hour rim light', expression: 'confident slight smile, direct eye contact' },

  // 9: Sitting at desk, working, focused
  { framing: 'medium shot from across desk, sitting at matte black laptop, hands on keyboard, slight three-quarter angle, looking up at camera', outfit: 'fitted beige ribbed knit top with high crew neck', setting: 'minimalist Bandra studio apartment desk with plants, books, ceramic mug, matte black laptop', light: 'natural daylight from large window with subtle warm rim light', expression: 'focused thoughtful expression with slight smile, looking up from screen' },

  // 10: Holding matcha, kitchen counter, warm
  { framing: 'medium shot, hands holding ceramic matcha cup near collarbone, soft natural pose', outfit: 'oversized cream knit cardigan over fitted cream tank with high neck', setting: 'cozy minimalist kitchen with marble counter, ceramic items, plants', light: 'soft warm morning light, golden highlights', expression: 'gentle warm smile, eyes meeting camera, calm' },

  // 11: Reading, bookshelf, contemplative
  { framing: 'medium shot, reading a hardcover book, soft side angle, glancing up at camera', outfit: 'fitted forest green knit turtleneck with high jeans', setting: 'cozy reading corner with floor-to-ceiling bookshelves, plants, soft warm wood', light: 'warm tungsten reading lamp light with subtle ambient', expression: 'peaceful contemplative expression with slight gentle smile' },

  // 12: Standing portrait, white wall, editorial
  { framing: 'wider portrait shot showing full torso, standing pose, hands relaxed at sides', outfit: 'ivory cashmere sweater with high-waisted dark trousers', setting: 'minimalist gallery-white wall with subtle texture', light: 'studio editorial soft key from above with gentle fill', expression: 'calm direct gaze at camera, slight asymmetric smile' },

  // 13: Window light, soft moment, hand near face
  { framing: 'close-up portrait, hand near chin in thoughtful gesture', outfit: 'fitted cream ribbed turtleneck', setting: 'minimalist apartment near tall window with sheer curtain', light: 'soft diffused window light, slightly cool morning tones', expression: 'soft thoughtful expression with eyes looking off-camera left' },

  // 14: Wide shot, balcony, sunset
  { framing: 'wider 3/4 body shot leaning against balcony railing, slight side angle', outfit: 'fitted cream silk blouse with mid-rise dark jeans, gold layered necklaces', setting: 'rooftop balcony in Bandra with city skyline in soft bokeh at sunset', light: 'golden hour sunset light, warm orange tones, soft rim light', expression: 'gentle warm smile, hair gently moving in breeze' },

  // 15: Studio portrait, high fashion, head tilt
  { framing: 'portrait shot, head tilted slightly, hand at jawline', outfit: 'tailored cream blazer over high-neck black silk camisole (top button done up)', setting: 'cream studio backdrop with subtle vignette', light: 'editorial beauty lighting with soft key and rim light', expression: 'editorial calm expression with slight smolder, eyes meeting camera' },

  // 16: Medium walking shot, street style
  { framing: 'medium shot mid-walk on a quiet city street, slight motion, three-quarter angle', outfit: 'oversized beige trench coat over fitted cream turtleneck and dark jeans', setting: 'quiet Mumbai street with vintage architecture in soft bokeh', light: 'soft afternoon daylight, slight overcast', expression: 'natural candid expression, slight smile, hair softly moving' },

  // 17: Sitting on couch, laptop, cozy
  { framing: 'medium shot sitting cross-legged on a beige sofa, matte black laptop on lap, looking at camera', outfit: 'fitted forest green ribbed knit top with comfy oatmeal trousers', setting: 'cozy minimalist living room with plants, throw blanket, warm wood', light: 'warm interior tungsten light with subtle natural fill', expression: 'gentle smile, relaxed pose, eyes meeting camera' },

  // 18: Natural light, garden, full smile
  { framing: 'medium shot in soft natural setting, slight three-quarter angle', outfit: 'fitted ivory ribbed knit top with high crew neck', setting: 'lush garden with greenery and soft natural backdrop, slight bokeh', light: 'soft natural daylight with leaf-dappled highlights', expression: 'genuine warm smile showing natural teeth, eyes lit up' },

  // 19: Bedroom morning, soft contemplative
  { framing: 'close-up portrait, soft morning vibe, head resting on hand', outfit: 'oversized cream cotton sweatshirt with high crew neck', setting: 'soft bedroom with white linen bedding visible, morning light', light: 'soft cool morning light from window with warm fill', expression: 'soft contemplative morning expression, gentle barely-there smile' },

  // 20: Outdoor cafe, daytime, conversation
  { framing: 'medium shot at outdoor cafe table, leaning slightly forward, hands gesturing softly', outfit: 'fitted black ribbed knit top with high crew neck and high-waisted dark jeans', setting: 'outdoor cafe with greenery and other tables in soft bokeh', light: 'soft afternoon daylight with golden warm highlights', expression: 'engaged conversation expression with slight smile, eyes warm and present' },
];

function buildPrompt(v) {
  return [
    `Real DSLR photograph (NOT illustration, NOT painting, NOT cartoon, NOT cgi, NOT digital art, NOT 3D render) of a 25-year-old Indian woman content creator of mixed Tamil-North Indian heritage.`,
    `Warm wheatish skin tone with natural visible pores and fine peach fuzz, soft heart-shaped face with defined cheekbones, full natural lips, large almond-shaped dark brown eyes with thick natural lashes, neat naturally-shaped eyebrows, long dark brown hair softly waved or in low loose bun, athletic-feminine build with natural normal body proportions.`,
    `Framing: ${v.framing}.`,
    `Outfit: ${v.outfit}. Modest, sophisticated, NEVER plunging neckline, NEVER showing cleavage. Delicate matte gold jewelry only.`,
    `Setting: ${v.setting}.`,
    `Lighting: ${v.light}.`,
    `Expression: ${v.expression}.`,
    `Photographic style: editorial fashion photograph, shot on Sony A7R IV with 35mm or 85mm prime lens at f/1.8 to f/2.8, shallow depth of field, photorealistic ultra-detailed natural skin texture with visible pores and natural imperfections, subtle 35mm film grain, magazine quality, Vogue India aesthetic, candid documentary feel.`,
  ].join(' ');
}

async function main() {
  const args = parseArgs(process.argv);
  const persona = await personaService.getActivePersona();
  const db = dbModule.getClient();

  if (args.reset) {
    log.info('Resetting prior training set...');
    const { error, count } = await db.from('face_anchors')
      .delete({ count: 'exact' })
      .eq('persona_id', persona.id)
      .eq('notes', 'training_set');
    if (error) log.warn(`Reset error: ${error.message}`);
    else log.info(`✓ Deleted ${count || 0} prior training rows.`);
  }

  log.info(`Generating ${args.count} GENUINELY DIVERSE training portraits for ${persona.display_name}...`);
  log.info(`(no anchor image_prompt this time \u2014 lets Flux explore varied compositions)`);

  const variations = VARIATIONS.slice(0, args.count);
  const generated = [];

  for (let i = 0; i < variations.length; i++) {
    const v = variations[i];
    log.info(`──────────────────────────────────────────`);
    log.info(`Training image ${i + 1}/${variations.length}  ::  ${v.framing.substring(0, 50)}...`);

    const prompt = buildPrompt(v);
    const seed = Math.floor(Math.random() * 1_000_000);

    let result;
    try {
      // No image_prompt — we want diversity. The LoRA training will tie identity together.
      result = await runModel('flux_pro', {
        prompt,
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

    await new Promise(r => setTimeout(r, 1000));
  }

  log.info(`──────────────────────────────────────────`);
  log.info(`✓ Generated ${generated.length}/${variations.length} training portraits.`);
  log.info(`   Total cost: ~$${(0.04 * generated.length).toFixed(2)}`);
  log.info(`   Storage path prefix: training/${persona.slug}/`);
  log.info(``);
  log.info(`   Open all ${generated.length} URLs in your browser. If 16+ look like the same girl,`);
  log.info(`   we're ready to train. Otherwise tell me which ones look "off" and I'll regenerate.`);
  log.info(``);
  log.info(`   Next step:  node avatar/imagery/train_lora.js`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
