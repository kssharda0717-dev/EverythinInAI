#!/usr/bin/env node
/**
 * EverythinInAI — Lifestyle Reel Worker (Phase 14)
 *
 * Generates "day-in-life" Reels for the IG Subscription paywall.
 * No script, no scraped signal — just pure aesthetic Avi content.
 *
 * Each Reel is built from 4 lifestyle keyframes generated via Avi's LoRA,
 * stitched with Ken Burns motion, ambient music bed, and a brand watermark.
 *
 * Moods (each picks 4 distinct micro-moments):
 *   - morning_routine   : waking up, matcha, journaling, sunlight stretches
 *   - cafe              : laptop at cafe, sipping coffee, looking at phone, candid laugh
 *   - working           : at desk, typing, reading, thoughtful pose
 *   - golden_hour       : balcony, rooftop, sunset light, contemplative
 *   - reading           : book corner, pages, soft window light
 *
 * Cost: 4 × $0.025 (LoRA) + ffmpeg = ~$0.10 per Lifestyle Reel
 *
 * Usage:
 *   node avatar/lifestyle/lifestyle_worker.js                       # random mood
 *   node avatar/lifestyle/lifestyle_worker.js --mood=morning_routine
 *   node avatar/lifestyle/lifestyle_worker.js --mood=cafe --outfit=oversized_cardigan
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');
const { runModel } = require('../imagery/replicate_client');
const { rehostImage } = require('../imagery/storage');
const { getMusicTrack } = require('../video/asset_library');
const { spawnSync } = require('child_process');

const log = createLogger('lifestyle');

const W = 1080;
const H = 1350;
const FPS = 30;

// Mood → 4 keyframe prompts each
const MOODS = {
  morning_routine: [
    'sitting on a bed in soft morning light from a large window, sheer curtains, hands holding a steaming ceramic mug, gazing softly out the window, peaceful contemplative expression',
    'standing in a minimalist sunlit kitchen, pouring matcha into a ceramic cup, slight smile, hair slightly tousled in a relaxed low bun',
    'sitting cross-legged on a plush cream rug with a leather journal open in her lap, pen in hand, thoughtful soft expression, sunlight falling across the page',
    'standing by an apartment window with morning city skyline in soft bokeh behind, holding the matcha cup near her face, eyes closed for a moment of stillness',
  ],
  cafe: [
    'sitting at a marble cafe table with a matte black laptop open, hands on keyboard, looking thoughtful at the screen, soft warm cafe ambience with pendant lights in deep bokeh',
    'leaning forward slightly with a ceramic latte cup in hand, looking off-camera with a soft warm smile, slight motion blur of cafe people in background',
    'looking down at her phone with a soft amused expression, half-eaten croissant and latte on table, golden afternoon window light',
    'leaning back relaxed in a cafe chair, holding the latte close to her face, candid genuine laugh caught mid-moment, eyes crinkling',
  ],
  working: [
    'at a minimalist Bandra apartment desk, hands resting on a matte black laptop keyboard, slight three-quarter angle to camera, focused thoughtful expression with the barest hint of a smile',
    'leaning back in her desk chair, one hand resting on chin, looking up at the camera with calm warm eyes, plants and bookshelf in soft warm bokeh',
    'standing at a tall workspace, leaning over the desk reading something on a tablet, hair falling forward, soft side window light',
    'sitting at the desk with a leather journal open, pen in hand, pausing mid-thought, soft smile of quiet focus',
  ],
  golden_hour: [
    'standing on a Bandra rooftop balcony with the Mumbai skyline in soft golden bokeh, hair gently moving in evening breeze, looking out toward the horizon with a calm contemplative expression',
    'leaning against the rooftop railing, profile view, warm golden sunset light catching her face, eyes closed for a moment of stillness',
    'walking slowly along the rooftop, hand brushing the railing, mid-stride three-quarter angle to camera, golden hour warm rim light',
    'sitting on a low stool against the rooftop wall, knees up, arms wrapped around them, gazing into the sunset with a soft warm smile',
  ],
  reading: [
    'sitting in a cozy reading nook with floor-to-ceiling bookshelves behind, hardcover book open in her lap, finger pressed to page mid-thought',
    'lying on a cream sofa with the book held above her face, slight smile, sunlight falling across her shoulders, soft warm ambience',
    'standing in front of the bookshelf reaching up to pull a book down, profile angle, sunlight from a high window catching her face',
    'sitting cross-legged on the floor surrounded by an open book and a steaming ceramic cup, looking up at the camera with a soft engaged expression',
  ],
};

const OUTFIT_BY_MOOD = {
  morning_routine: 'fitted ivory ribbed knit top with high crew neck OR oversized cream cotton sweatshirt, no jewelry, hair softly down or in low loose bun',
  cafe:            'fitted cream ribbed knit turtleneck OR oversized beige cardigan over high-neck top, no necklace, simple gold stud earrings',
  working:         'fitted forest green ribbed knit turtleneck OR tailored beige blazer over high-neck cream top, no necklace, hair in low loose bun',
  golden_hour:     'fitted ivory cashmere sweater OR cream silk blouse buttoned to high neck, no necklace, hair softly waved and loose',
  reading:         'oversized cream knit cardigan over fitted high-neck top OR ivory cashmere sweater, no necklace, hair in low loose bun',
};

function parseArgs(argv) {
  const args = { mood: null, outfit: null, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--mood=')) args.mood = a.split('=')[1];
    else if (a.startsWith('--outfit=')) args.outfit = a.split('=')[1];
  }
  return args;
}

function pickMood(forceKey) {
  const keys = Object.keys(MOODS);
  if (forceKey && MOODS[forceKey]) return forceKey;
  return keys[Math.floor(Math.random() * keys.length)];
}

function buildPrompt(scene, outfitDescriptor, trigger) {
  return [
    `Real DSLR photograph of ${trigger} woman, a 25-year-old Indian content creator.`,
    scene + '.',
    `Wearing: ${outfitDescriptor}. Modest, sophisticated, NEVER plunging neckline, NEVER showing cleavage.`,
    `Photographic style: editorial lifestyle photograph, shot on Sony A7R IV with 50mm prime at f/2.0, shallow depth of field, photorealistic ultra-detailed natural skin texture with visible pores, subtle 35mm film grain, magazine quality, Vogue India aesthetic, candid documentary feel, NOT illustration, NOT cartoon, NOT cgi.`,
  ].join(' ');
}

async function renderKeyframe({ persona, scene, outfit, trigger, runId, idx }) {
  const prompt = buildPrompt(scene, outfit, trigger);
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
    output_quality: 92,
    go_fast: false,
    seed,
  }, { timeoutMs: 240_000 });

  const remoteUrl = result.output[0];
  const destPath = `lifestyle/${runId}/kf-${idx}-${Date.now()}.webp`;
  const hosted = await rehostImage(remoteUrl, destPath);
  return { ...hosted, prompt, seed, cost: result.cost_usd };
}

function buildKenBurnsFilter(numImages, perImageDur, transitionDur) {
  const zoomFrames = Math.round(perImageDur * FPS);
  const inputFilters = [];
  // Pre-scale to a larger canvas so zoompan has room to zoom into without
  // blurring. Source webp from Flux is ~896x1088; we upscale to W*2 x H*2 first,
  // then center-crop to the W*2 x H*2 canvas, THEN zoompan rescales down to W x H.
  const upW = W * 2;
  const upH = H * 2;
  for (let i = 0; i < numImages; i++) {
    const zoomDir = i % 2 === 0
      ? `zoom='min(zoom+0.0006,1.18)'`
      : `zoom='if(lte(zoom,1.001),1.18,max(zoom-0.0006,1.0))'`;
    const pan = `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
    // Use scale=upW:upH (no force_original_aspect_ratio) so the source ALWAYS
    // gets resized to the target canvas regardless of input dimensions. Then
    // zoompan does the actual Ken Burns zoom and outputs at W x H.
    inputFilters.push(
      `[${i}:v]scale=${upW}:${upH}:flags=lanczos,setsar=1,` +
      `zoompan=${zoomDir}:${pan}:d=${zoomFrames}:s=${W}x${H}:fps=${FPS}[v${i}]`
    );
  }
  const xfade = [];
  let prev = 'v0';
  for (let i = 1; i < numImages; i++) {
    const offset = (perImageDur * i) - transitionDur;
    const out = (i === numImages - 1) ? 'vout' : `vx${i}`;
    xfade.push(`[${prev}][v${i}]xfade=transition=fade:duration=${transitionDur}:offset=${offset.toFixed(3)}[${out}]`);
    prev = out;
  }
  return [...inputFilters, ...xfade].join(';');
}

async function uploadFinal(localPath, runId) {
  const db = dbModule.getClient();
  const buf = fs.readFileSync(localPath);
  const storagePath = `reels/lifestyle/${runId}/${Date.now()}.mp4`;
  const { error } = await db.storage
    .from('avi-images')
    .upload(storagePath, buf, { contentType: 'video/mp4', upsert: true, cacheControl: '31536000' });
  if (error) throw error;
  const { data: pub } = db.storage.from('avi-images').getPublicUrl(storagePath);
  return { publicUrl: pub.publicUrl, storagePath, sizeBytes: buf.length };
}

async function main() {
  const args = parseArgs(process.argv);
  const persona = await personaService.getActivePersona('avi');
  if (!persona.active_lora_url) {
    log.error('Persona has no active_lora_url. Train Avi LoRA first.');
    process.exit(1);
  }

  const moodKey = pickMood(args.mood);
  const scenes = MOODS[moodKey];
  const outfit = args.outfit && OUTFIT_BY_MOOD[args.outfit] ? OUTFIT_BY_MOOD[args.outfit] : OUTFIT_BY_MOOD[moodKey];
  const trigger = persona.active_lora_trigger || 'AVI_TOK';

  const runId = `${moodKey}-${Date.now()}`;
  log.info(`Lifestyle Reel run ${runId}  mood=${moodKey}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `lifestyle-${runId.slice(0, 14)}-`));
  log.info(`Workspace: ${workDir}`);

  if (args.dryRun) {
    log.info(`DRY RUN \u2014 would render 4 keyframes for mood "${moodKey}"`);
    scenes.forEach((s, i) => log.info(`  kf[${i}]: ${s.substring(0, 100)}...`));
    return;
  }

  // 1. Render 4 keyframes
  log.info(`Rendering 4 lifestyle keyframes...`);
  const keyframes = [];
  let totalCost = 0;
  for (let i = 0; i < scenes.length; i++) {
    log.info(`  [${i + 1}/4] ${scenes[i].substring(0, 70)}...`);
    const r = await renderKeyframe({ persona, scene: scenes[i], outfit, trigger, runId, idx: i });
    keyframes.push(r);
    totalCost += r.cost;
    log.info(`    \u2713 ${r.publicUrl}`);
  }

  // 2. Download keyframes locally for ffmpeg
  const axios = require('axios');
  const localImages = [];
  for (let i = 0; i < keyframes.length; i++) {
    const localPath = path.join(workDir, `kf${i}.webp`);
    const resp = await axios.get(keyframes[i].publicUrl, { responseType: 'arraybuffer', timeout: 60_000 });
    fs.writeFileSync(localPath, Buffer.from(resp.data));
    localImages.push(localPath);
  }

  // 3. Get music
  const musicPath = await getMusicTrack('calm');

  // 4. Ken Burns video assembly
  const TOTAL_DURATION = 20;        // 20-sec lifestyle reel
  const transitionDur = 0.7;
  const perImageDur = TOTAL_DURATION / keyframes.length + transitionDur;

  const filter = buildKenBurnsFilter(keyframes.length, perImageDur, transitionDur);

  // 5. Clean output — NO watermark, NO outro (premium aesthetic).
  //    Branding lives in the IG caption + handle, not burned into the pixels.
  const outputMp4 = path.join(workDir, 'final.mp4');

  // ffmpeg: 4 image inputs + 1 music input + Ken Burns filter (no overlay text)
  const args2 = [
    '-y',
    ...localImages.flatMap(p => ['-loop', '1', '-t', String(perImageDur + 1), '-i', p]),
    '-stream_loop', '-1', '-i', musicPath,
    '-filter_complex', filter + `;[${keyframes.length}:a]volume=0.55,atrim=0:${TOTAL_DURATION},afade=t=in:st=0:d=1.5,afade=t=out:st=${TOTAL_DURATION - 2}:d=2[abed]`,
    '-map', '[vout]',
    '-map', '[abed]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-r', String(FPS),
    '-shortest',
    '-t', String(TOTAL_DURATION),
    outputMp4,
  ];

  log.info(`Running ffmpeg lifestyle assembly...`);
  const r = spawnSync('ffmpeg', args2, { stdio: 'inherit', timeout: 300_000 });
  if (r.status !== 0) throw new Error(`ffmpeg failed (status=${r.status})`);

  // 6. Upload
  log.info(`Uploading lifestyle Reel...`);
  const hosted = await uploadFinal(outputMp4, runId);

  log.info(`══════════════════════════════════════════════`);
  log.info(`✓ Lifestyle Reel ready.`);
  log.info(`   url      : ${hosted.publicUrl}`);
  log.info(`   mood     : ${moodKey}`);
  log.info(`   duration : ${TOTAL_DURATION}s`);
  log.info(`   size     : ${(hosted.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
  log.info(`   cost     : ~$${totalCost.toFixed(3)}`);
  log.info(`══════════════════════════════════════════════`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
