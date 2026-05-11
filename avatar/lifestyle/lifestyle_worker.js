#!/usr/bin/env node
/**
 * EverythinInAI — Lifestyle Reel Worker (Phase 16: Action Edition)
 *
 * Generates a high-engagement, action-driven lifestyle Reel of Rhea Kapoor.
 * Used Saturday/Sunday for weekend lifestyle posts.
 *
 * Pipeline:
 *   1. Pick a random action mood (gym, pilates, driving, swimming, etc.)
 *   2. Generate ONE high-quality action hero image via Flux+LoRA  ($0.025)
 *   3. Send hero image to Kling v1.6 Standard for animation        ($0.50, 10s clip)
 *   4. Add ambient/upbeat background music via ffmpeg              ($0)
 *
 * Cost: ~$0.525 per Lifestyle Reel (~₹44)
 *
 * Usage:
 *   node avatar/lifestyle/lifestyle_worker.js                    # random mood
 *   node avatar/lifestyle/lifestyle_worker.js --mood=gym
 *   node avatar/lifestyle/lifestyle_worker.js --mood=pilates --dry-run
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');
const { runModel } = require('../imagery/replicate_client');
const { rehostImage } = require('../imagery/storage');
const { getMusicTrack } = require('../video/asset_library');
const { spawnSync } = require('child_process');

const log = createLogger('lifestyle');

const W = 1080;
const H = 1920;  // 9:16 vertical for Reels
const FPS = 30;
const KLING_DURATION = 10;  // 10-second Kling clip

/**
 * Action moods - each has:
 *   - keyframe_prompt: prompt for the static hero image (Flux+LoRA)
 *   - motion_prompt: prompt for Kling animation (describes the action movement)
 *   - outfit: outfit string
 *   - music_mood: which music track to layer ('upbeat', 'calm', 'energetic')
 */
const MOODS = {
  gym: {
    label: 'Gym workout',
    keyframe_prompt: 'mid-action at a luxury modern gym, lifting a kettlebell with focused intensity, slight sweat glistening on her forehead, hair tied up in a high ponytail, athletic body confidence, motivational morning sunlight from floor-to-ceiling windows',
    motion_prompt: 'a fit young woman performing a controlled kettlebell swing, smooth athletic motion, breathing rhythmically, gym ambient lighting, professional fitness influencer aesthetic',
    outfit: 'sleek matching black athletic set, fitted high-waisted leggings and matching crop tank top, athletic premium look, no necklace',
    music_mood: 'energetic',
  },
  pilates: {
    label: 'Pilates studio',
    keyframe_prompt: 'in a pristine bright pilates studio on a reformer machine, mid-stretch with one leg extended gracefully, balanced and elegant pose, natural light flooding through large windows, calm focused expression',
    motion_prompt: 'a young woman performing a graceful pilates reformer exercise, slow controlled flowing movement, serene focused breathing, soft natural studio light',
    outfit: 'minimalist matching beige pilates set, fitted leggings and a fitted long-sleeve top, classic clean aesthetic, no jewelry',
    music_mood: 'calm',
  },
  driving: {
    label: 'Sunset drive',
    keyframe_prompt: 'in the driver seat of a luxury sports car (sleek matte black or white) at golden hour, hands gripping the steering wheel, looking forward with relaxed confidence, golden sunlight streaming across her face, hair gently moving in the breeze from open windows',
    motion_prompt: 'a confident young woman driving a luxury car at sunset, hair flowing in the breeze, smooth camera motion, golden hour ambient light, cinematic driving footage',
    outfit: 'casual chic, oversized linen shirt unbuttoned over a fitted camisole, designer aviator sunglasses on, hair softly waved',
    music_mood: 'upbeat',
  },
  swimming: {
    label: 'Pool swim',
    keyframe_prompt: 'emerging from a luxury infinity pool at golden hour, water glistening, hair slicked back wet, slight smile of pure joy, gentle ripples of water around her, mountain or ocean view in the background, classy resort vibe',
    motion_prompt: 'a young woman emerging gracefully from crystal blue pool water, water droplets falling, slow motion cinematic shot, golden hour reflection on water surface',
    outfit: 'classy modest one-piece swimsuit in deep emerald or black, sophisticated and elegant, no jewelry',
    music_mood: 'calm',
  },
  climbing: {
    label: 'Mountain hiking',
    keyframe_prompt: 'standing on a rocky mountain trail with sweeping valley views behind, mid-stride with one hand resting on a hiking pole, looking out at the vista with confident smile, soft early morning light, adventurous spirit',
    motion_prompt: 'a young woman hiking confidently on a scenic mountain trail, smooth walking motion, light wind moving her hair, sweeping cinematic landscape',
    outfit: 'practical chic hiking outfit, fitted black leggings, fitted thermal long-sleeve top, lightweight technical jacket, hair in a high ponytail with cap',
    music_mood: 'energetic',
  },
  dancing: {
    label: 'Apartment dance',
    keyframe_prompt: 'mid-twirl in a beautiful minimalist apartment with warm evening lighting, captured mid-laugh, head thrown back slightly with pure joy, hair flowing dynamically, motion blur on the edges',
    motion_prompt: 'a young woman dancing playfully in a minimalist apartment, twirling and laughing freely, dynamic flowing motion, warm ambient evening light, joyful candid moment',
    outfit: 'flowing silk slip dress in cream or champagne, elegant and feminine, bare feet, natural makeup',
    music_mood: 'upbeat',
  },
  yoga: {
    label: 'Sunrise yoga',
    keyframe_prompt: 'on a yoga mat on a serene rooftop or beach at sunrise, holding a graceful warrior pose, eyes closed in deep concentration, soft golden light catching her face and outline, peaceful spiritual energy',
    motion_prompt: 'a young woman flowing through a graceful yoga sequence at sunrise, slow controlled transitions between poses, peaceful breathing, golden hour ambient light',
    outfit: 'fitted matching sage green yoga set, high-waisted leggings and a fitted long-sleeve top, hair in a low loose bun, no jewelry',
    music_mood: 'calm',
  },
  bowling: {
    label: 'Bowling night',
    keyframe_prompt: 'mid-throw at a trendy retro bowling alley, captured in motion releasing the bowling ball, focused playful expression, neon lights and friends slightly blurred in the background, fun social ambience',
    motion_prompt: 'a young woman bowling at a stylish bowling alley, smooth throwing motion, walking forward with the ball release, neon ambient lighting, dynamic social setting',
    outfit: 'casual stylish look, fitted dark wash jeans, vintage band t-shirt tucked in, leather jacket draped on shoulders, hair in messy waves',
    music_mood: 'upbeat',
  },
  beach: {
    label: 'Beach walk',
    keyframe_prompt: 'walking barefoot along the edge of a pristine beach at golden hour, gentle waves lapping at her feet, holding sandals in one hand, looking back over her shoulder with a serene smile, hair flowing in the ocean breeze',
    motion_prompt: 'a young woman walking peacefully along a beach at sunset, gentle ocean waves at her feet, soft wind in her hair, golden hour cinematic ambient light',
    outfit: 'flowing white linen sundress with a low V back, classy beachwear aesthetic, hair softly waved and sun-kissed',
    music_mood: 'calm',
  },
};

function parseArgs(argv) {
  const args = { mood: null, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--mood=')) args.mood = a.split('=')[1];
  }
  return args;
}

function pickMood(forceKey) {
  const keys = Object.keys(MOODS);
  if (forceKey && MOODS[forceKey]) return forceKey;
  return keys[Math.floor(Math.random() * keys.length)];
}

function buildHeroPrompt(mood, trigger) {
  return [
    `Real DSLR photograph of ${trigger} woman, a 25-year-old Indian content creator.`,
    mood.keyframe_prompt + '.',
    `Wearing: ${mood.outfit}.`,
    `Photographic style: cinematic action photograph, shot on Sony A7R IV with 50mm prime at f/2.0, photorealistic ultra-detailed natural skin texture, dynamic engaging composition, highly attractive and aspirational, lifestyle Instagram aesthetic, NOT illustration, NOT cartoon, NOT cgi.`,
  ].join(' ');
}

async function renderHeroImage({ persona, mood, trigger, runId }) {
  const prompt = buildHeroPrompt(mood, trigger);
  const seed = Math.floor(Math.random() * 1_000_000);

  log.info(`[1/3] Rendering action hero image (Flux+LoRA)...`);
  const result = await runModel('flux_dev_lora', {
    prompt,
    lora_weights: persona.active_lora_url,
    lora_scale: 1.0,
    aspect_ratio: '9:16',  // 9:16 vertical for Reels
    num_outputs: 1,
    num_inference_steps: 28,
    guidance: 3.0,
    output_format: 'webp',
    output_quality: 95,
    go_fast: false,
    seed,
  }, { timeoutMs: 240_000 });

  const remoteUrl = result.output[0];
  const destPath = `lifestyle/${runId}/hero-${Date.now()}.webp`;
  const hosted = await rehostImage(remoteUrl, destPath);
  return { ...hosted, prompt, seed, cost: result.cost_usd };
}

async function animateWithKling({ heroImageUrl, mood }) {
  log.info(`[2/3] Animating with Kling v1.6 Standard (~2-3 min)...`);
  const result = await runModel('kling_v1_6_std', {
    prompt: mood.motion_prompt,
    start_image: heroImageUrl,
    duration: KLING_DURATION,
    aspect_ratio: '9:16',
    cfg_scale: 0.5,
    negative_prompt: 'distorted face, deformed body, multiple people, extra limbs, blurry, low quality',
  }, { timeoutMs: 600_000 });

  const remoteUrl = Array.isArray(result.output) ? result.output[0] : result.output;
  log.info(`Kling returned: ${remoteUrl}`);
  return { url: remoteUrl, cost: result.cost_usd };
}

async function downloadFile(url, destPath) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000 });
  fs.writeFileSync(destPath, Buffer.from(resp.data));
  return destPath;
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
  const mood = MOODS[moodKey];
  const trigger = persona.active_lora_trigger || 'AVI_TOK';

  const runId = `${moodKey}-${Date.now()}`;
  log.info(`Lifestyle Reel run ${runId}  mood=${moodKey} (${mood.label})`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `lifestyle-${runId.slice(0, 14)}-`));
  log.info(`Workspace: ${workDir}`);

  if (args.dryRun) {
    log.info(`DRY RUN — mood "${moodKey}" (${mood.label})`);
    log.info(`  Hero prompt: ${buildHeroPrompt(mood, trigger).substring(0, 200)}...`);
    log.info(`  Motion prompt: ${mood.motion_prompt}`);
    log.info(`  Music mood: ${mood.music_mood}`);
    return;
  }

  let totalCost = 0;

  // Step 1: Generate hero action image
  const hero = await renderHeroImage({ persona, mood, trigger, runId });
  totalCost += hero.cost;
  log.info(`  ✓ Hero: ${hero.publicUrl}`);

  // Step 2: Animate with Kling
  const kling = await animateWithKling({ heroImageUrl: hero.publicUrl, mood });
  totalCost += kling.cost;
  log.info(`  ✓ Kling video: ${kling.url}`);

  // Step 3: Download Kling video locally
  const klingLocalPath = path.join(workDir, 'kling.mp4');
  log.info(`[3/3] Downloading Kling video and adding music...`);
  await downloadFile(kling.url, klingLocalPath);

  // Get music track matching the mood
  const musicPath = await getMusicTrack(mood.music_mood);

  // Mux Kling video with music via ffmpeg
  const outputMp4 = path.join(workDir, 'final.mp4');
  const ffArgs = [
    '-y',
    '-i', klingLocalPath,
    '-stream_loop', '-1', '-i', musicPath,
    '-filter_complex',
    `[1:a]volume=0.6,atrim=0:${KLING_DURATION},afade=t=in:st=0:d=1,afade=t=out:st=${KLING_DURATION - 1.5}:d=1.5[abed]`,
    '-map', '0:v',
    '-map', '[abed]',
    '-c:v', 'copy',  // pass through Kling's video
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-shortest',
    '-t', String(KLING_DURATION),
    outputMp4,
  ];

  log.info(`Running ffmpeg to mux music...`);
  const r = spawnSync('ffmpeg', ffArgs, { stdio: 'inherit', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`ffmpeg failed (status=${r.status})`);

  // Step 4: Upload final
  log.info(`Uploading lifestyle Reel...`);
  const hosted = await uploadFinal(outputMp4, runId);

  log.info(`══════════════════════════════════════════════`);
  log.info(`✓ Lifestyle Reel ready.`);
  log.info(`   url      : ${hosted.publicUrl}`);
  log.info(`   mood     : ${moodKey} (${mood.label})`);
  log.info(`   duration : ${KLING_DURATION}s`);
  log.info(`   size     : ${(hosted.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
  log.info(`   cost     : ~$${totalCost.toFixed(3)} (~₹${(totalCost * 84).toFixed(0)})`);
  log.info(`══════════════════════════════════════════════`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
