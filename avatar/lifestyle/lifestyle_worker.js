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
 *   - music_mood: which music track to layer ('upbeat', 'calm', 'energetic', 'luxury')
 */
const MOODS = {
  // --- ATHLETIC ---
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
  yoga: {
    label: 'Sunrise yoga',
    keyframe_prompt: 'on a yoga mat on a serene beach at sunrise, holding a graceful warrior pose, eyes closed in deep concentration, soft golden light catching her face and outline, peaceful spiritual energy',
    motion_prompt: 'a young woman flowing through a graceful yoga sequence at sunrise, slow controlled transitions between poses, peaceful breathing, golden hour ambient light',
    outfit: 'fitted matching sage green yoga set, high-waisted leggings and a fitted long-sleeve top, hair in a low loose bun, no jewelry',
    music_mood: 'calm',
  },
  running: {
    label: 'Morning run',
    keyframe_prompt: 'mid-stride running along a scenic coastal path, looking forward with determination, hair in a ponytail swaying with movement, bright morning sunshine, ocean in the background',
    motion_prompt: 'a fit young woman running confidently along a coastal path, smooth athletic running motion, dynamic camera tracking, bright morning light',
    outfit: 'high-end running gear, white sports bra, black running shorts, sleek running shoes, athletic chic',
    music_mood: 'energetic',
  },

  // --- ADVENTURE ---
  surfing: {
    label: 'Goa beach surfing',
    keyframe_prompt: 'walking out of the ocean carrying a surfboard under one arm, water dripping from her skin and hair, confident radiant smile, golden hour sunset light, tropical beach vibe',
    motion_prompt: 'a beautiful young woman walking out of the ocean carrying a surfboard, water glistening, slow motion cinematic walk, golden hour sunset light, tropical beach',
    outfit: 'stylish minimalist black bikini, sporty but elegant, sunkissed skin, wet hair pushed back',
    music_mood: 'upbeat',
  },
  driving_mountains: {
    label: 'Manali mountain drive',
    keyframe_prompt: 'driving an open-top jeep on a winding mountain road, laughing with pure joy, wind blowing through her hair, majestic snow-capped peaks in the background, crisp clear daylight',
    motion_prompt: 'a young woman driving an open-top vehicle on a mountain road, laughing joyfully, hair blowing wildly in the wind, dynamic driving shot, cinematic mountain scenery',
    outfit: 'cozy oversized vintage leather jacket over a white t-shirt, dark denim, adventurous and stylish',
    music_mood: 'energetic',
  },
  snorkeling: {
    label: 'Lakshadweep snorkeling',
    keyframe_prompt: 'sitting on the edge of a luxury boat looking out at crystal clear turquoise water, holding snorkeling gear, excited adventurous smile, bright tropical sunlight, deep blue ocean',
    motion_prompt: 'a young woman sitting on a boat edge, looking at the turquoise ocean with an excited smile, gentle boat rocking motion, bright tropical sunlight',
    outfit: 'elegant white one-piece swimsuit, chic resort wear, oversized sunglasses resting on head',
    music_mood: 'upbeat',
  },
  beach_walk: {
    label: 'Beach walk',
    keyframe_prompt: 'walking barefoot along the edge of a pristine beach at golden hour, gentle waves lapping at her feet, holding sandals in one hand, looking back over her shoulder with a serene smile, hair flowing in the ocean breeze',
    motion_prompt: 'a young woman walking peacefully along a beach at sunset, gentle ocean waves at her feet, soft wind in her hair, golden hour cinematic ambient light',
    outfit: 'flowing white linen sundress with a low V back, classy beachwear aesthetic, hair softly waved and sun-kissed',
    music_mood: 'calm',
  },

  // --- GLAMOUR ---
  rooftop_cocktail: {
    label: 'Rooftop cocktail night',
    keyframe_prompt: 'standing at a high-end rooftop bar at night, holding a martini glass, looking over her shoulder with a magnetic confident smirk, blurred city lights in the background, cinematic flash photography style',
    motion_prompt: 'an elegant young woman at a rooftop bar at night, turning her head to look at the camera with a confident smile, holding a cocktail, blurred city lights twinkling, cinematic night lighting',
    outfit: 'bold tailored red blazer with nothing underneath, sleek black trousers, delicate diamond necklace, high-fashion glamour',
    music_mood: 'luxury',
  },
  diwali_party: {
    label: 'Diwali party',
    keyframe_prompt: 'twirling gracefully in a beautifully lit courtyard decorated with diyas and marigolds, laughing joyfully, motion blur on the edges of her dress, warm festive lighting',
    motion_prompt: 'a beautiful young woman twirling joyfully in a festive courtyard, elegant dress flowing dynamically, warm glowing light from diyas, festive celebratory atmosphere',
    outfit: 'breathtaking contemporary midnight-blue sequined saree, hair in sleek waves, heavy oxidized silver jhumkas, traditional glamour',
    music_mood: 'upbeat',
  },
  dance_studio: {
    label: 'Dance studio',
    keyframe_prompt: 'mid-dance move in a spacious mirrored dance studio, dynamic energetic pose, focused but joyful expression, warm studio lighting, professional dancer aesthetic',
    motion_prompt: 'a young woman performing a dynamic dance routine in a mirrored studio, fluid energetic movement, joyful expression, smooth camera tracking',
    outfit: 'loose comfortable streetwear, oversized vintage graphic tee, baggy cargo pants, cool effortless street style',
    music_mood: 'energetic',
  },
  fashion_week: {
    label: 'Fashion week front row',
    keyframe_prompt: 'sitting front row at a fashion show, legs crossed elegantly, looking intently at the runway, paparazzi flash lighting style, highly sophisticated and wealthy aura',
    motion_prompt: 'an elegant young woman sitting front row at a fashion show, looking attentively, subtle confident movements, paparazzi flash lighting, high-fashion editorial feel',
    outfit: 'avant-garde designer outfit, structured oversized beige suit with a white silk camisole, bold statement earrings, editorial styling',
    music_mood: 'luxury',
  },

  // --- QUIET LUXURY ---
  vineyard_reading: {
    label: 'Reading at a vineyard',
    keyframe_prompt: 'sitting on a rustic terrace overlooking rolling vineyard hills in Tuscany, reading a hardcover book, holding a glass of red wine, soft late afternoon sunlight, deeply peaceful and cultured vibe',
    motion_prompt: 'a sophisticated young woman reading a book on a vineyard terrace, gently turning a page, taking a sip of wine, peaceful slow cinematic motion, golden afternoon light',
    outfit: 'elegant minimalist cream cashmere sweater, white linen trousers, understated old-money wealth',
    music_mood: 'calm',
  },
  spa_day: {
    label: 'Spa day',
    keyframe_prompt: 'relaxing on a lounger in a luxury high-end spa, cucumber water in hand, eyes closed with a serene smile, soft diffused warm lighting, pure relaxation and self-care',
    motion_prompt: 'a young woman relaxing in a luxury spa, breathing deeply with a serene smile, slow peaceful cinematic motion, soft warm diffused light',
    outfit: 'plush white luxury hotel robe, hair wrapped in a towel, glowing natural skin, clean girl aesthetic',
    music_mood: 'calm',
  },
  business_class: {
    label: 'Business class travel',
    keyframe_prompt: 'sitting in a lie-flat business class seat on an international flight, looking out the window at the clouds with a contented smile, holding a glass of champagne, jet-setter aspiration',
    motion_prompt: 'a sophisticated young woman in a business class airplane seat, looking out the window, taking a sip of champagne, smooth cinematic motion, luxury travel aesthetic',
    outfit: 'matching camel-colored cashmere lounge set, comfortable but extremely expensive-looking, effortless travel chic',
    music_mood: 'luxury',
  },
  driving_city: {
    label: 'City night drive',
    keyframe_prompt: 'driving a luxury car through a neon-lit city at night, hands on the leather steering wheel, looking forward with calm focus, neon lights reflecting on her face and the car interior, cinematic cyberpunk vibe',
    motion_prompt: 'a confident young woman driving a luxury car through a neon-lit city at night, smooth driving motion, neon lights reflecting dynamically on her face, cinematic night drive',
    outfit: 'sleek black turtleneck, minimalist gold watch, sophisticated urban night look',
    music_mood: 'luxury',
  },
};

function parseArgs(argv) {
  const args = { mood: null, conceptId: null, calendarId: null, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--mood=')) args.mood = a.split('=')[1];
    else if (a.startsWith('--concept=')) args.conceptId = a.split('=')[1];
    else if (a.startsWith('--calendar=')) args.calendarId = a.split('=')[1];
  }
  return args;
}

function pickMood(forceKey) {
  const keys = Object.keys(MOODS);
  if (forceKey && MOODS[forceKey]) return forceKey;
  return keys[Math.floor(Math.random() * keys.length)];
}

function buildHeroPrompt(mood, trigger) {
  // If the LLM-generated keyframe prompt already includes the trigger, use it directly.
  if (mood.keyframe_prompt && mood.keyframe_prompt.includes(trigger)) {
    return mood.keyframe_prompt + (mood.outfit ? ` Wearing: ${mood.outfit}.` : '') + ' Photographic style: cinematic action photograph, shot on Sony A7R IV, photorealistic ultra-detailed natural skin texture, dynamic engaging composition, highly attractive and aspirational, lifestyle Instagram aesthetic, NOT illustration, NOT cartoon, NOT cgi.';
  }
  return [
    `Real DSLR photograph of ${trigger} woman, a 25-year-old Indian content creator.`,
    mood.keyframe_prompt + '.',
    mood.outfit ? `Wearing: ${mood.outfit}.` : '',
    `Photographic style: cinematic action photograph, shot on Sony A7R IV with 50mm prime at f/2.0, photorealistic ultra-detailed natural skin texture, dynamic engaging composition, highly attractive and aspirational, lifestyle Instagram aesthetic, NOT illustration, NOT cartoon, NOT cgi.`,
  ].filter(Boolean).join(' ');
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
  const persona = await personaService.getActivePersona();
  if (!persona.active_lora_url) {
    log.error('Persona has no active_lora_url. Train Avi LoRA first.');
    process.exit(1);
  }

  const trigger = persona.active_lora_trigger || 'AVI_TOK';
  const db = dbModule.getClient();

  // ===== Resolve calendar row to check weekend_mode =====
  let calendarRow = null;
  if (args.calendarId) {
    const { data: cal } = await db.from('content_calendar').select('*').eq('id', args.calendarId).maybeSingle();
    calendarRow = cal;
  }

  // ===== DANCE MODE BRANCH =====
  // If calendar row has weekend_mode='dance' and dance_audio_url is set,
  // we render a lip-synced dance reel via Pruna instead of the standard Kling flow.
  if (calendarRow && calendarRow.weekend_mode === 'dance' && calendarRow.dance_audio_url) {
    log.info(`💃 DANCE MODE — lip-syncing to: ${calendarRow.dance_audio_filename || calendarRow.dance_audio_url}`);
    const runId = `dance-${Date.now()}`;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `dance-${runId.slice(0, 14)}-`));

    // Step 1: hero image — Rhea in dance pose, mid-move
    const danceHeroPrompt = `Real DSLR photograph of ${trigger} woman, a 25-year-old Indian content creator. Mid-dance pose in a beautifully lit dance studio with full-length mirrors, dynamic energetic stance with confident gaze at the camera, head and shoulders framing prominent. Wearing: chic crop top and high-waisted wide-leg pants, hair flowing dynamically with the motion. Photographic style: cinematic action photograph, shot on Sony A7R IV, photorealistic ultra-detailed natural skin texture, dynamic engaging composition, high-fashion editorial quality, NOT illustration, NOT cartoon, NOT cgi.`;
    const heroSeed = Math.floor(Math.random() * 1_000_000);
    log.info(`[1/3] Rendering dance hero image (Flux+LoRA)...`);
    const heroResult = await runModel('flux_dev_lora', {
      prompt: danceHeroPrompt,
      lora_weights: persona.active_lora_url,
      lora_scale: 1.0,
      aspect_ratio: '9:16',
      num_outputs: 1,
      num_inference_steps: 28,
      guidance: 3.0,
      output_format: 'webp',
      output_quality: 95,
      go_fast: false,
      seed: heroSeed,
    }, { timeoutMs: 240_000 });
    const heroRemoteUrl = heroResult.output[0];
    const heroDestPath = `lifestyle/${runId}/hero-${Date.now()}.webp`;
    const heroHosted = await rehostImage(heroRemoteUrl, heroDestPath);
    log.info(`  ✓ Hero: ${heroHosted.publicUrl}`);

    // Step 2: lip-sync via Pruna using user-supplied audio
    log.info(`[2/3] Pruna lip-sync (~3-5 min)...`);
    const pruna = await runModel('pruna_avatar', {
      image: heroHosted.publicUrl,
      audio: calendarRow.dance_audio_url,
      resolution: '720p',
    }, { timeoutMs: 600_000 });
    const pruneVideoUrl = Array.isArray(pruna.output) ? pruna.output[0] : pruna.output;
    log.info(`  ✓ Pruna video: ${pruneVideoUrl}`);

    // Step 3: download Pruna video and upload to our storage (already has audio embedded)
    const finalLocalPath = path.join(workDir, 'final.mp4');
    log.info(`[3/3] Downloading Pruna video and uploading to Supabase...`);
    await downloadFile(pruneVideoUrl, finalLocalPath);
    const hosted = await uploadFinal(finalLocalPath, runId);

    const totalCost = heroResult.cost_usd + pruna.cost_usd;
    log.info(`═`.repeat(46));
    log.info(`💃 Dance Reel ready.`);
    log.info(`   url      : ${hosted.publicUrl}`);
    log.info(`   audio    : ${calendarRow.dance_audio_filename}`);
    log.info(`   size     : ${(hosted.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
    log.info(`   cost     : ~$${totalCost.toFixed(3)} (~₹${(totalCost * 84).toFixed(0)})`);
    log.info(`═`.repeat(46));

    // Update calendar row
    await db.from('content_calendar').update({
      output_url: hosted.publicUrl,
      state: 'done',
      completed_at: new Date().toISOString(),
      cost_usd: totalCost,
      updated_at: new Date().toISOString(),
    }).eq('id', calendarRow.id);
    return;
  }

  // ===== NEW PATH: LLM-generated concept =====
  let concept = null;
  if (args.conceptId) {
    const { data } = await db.from('reel_concepts').select('*').eq('id', args.conceptId).maybeSingle();
    concept = data;
  } else if (calendarRow?.concept_id) {
    const { data } = await db.from('reel_concepts').select('*').eq('id', calendarRow.concept_id).maybeSingle();
    concept = data;
  }

  let mood;
  let moodKey;
  if (concept && concept.keyframe_prompt && concept.motion_prompt) {
    log.info(`Using LLM-generated lifestyle prompts from concept ${concept.id} (angle: ${concept.angle})`);
    moodKey = concept.angle || 'llm_concept';
    // Build the mood object from concept fields. The LLM's prompts override the static MOODS map.
    let kfPrompt = concept.keyframe_prompt;
    if (!kfPrompt.includes(trigger) && !kfPrompt.includes('AVI_TOK')) {
      kfPrompt = `Real DSLR photograph of ${trigger} woman, a 25-year-old Indian content creator. ${kfPrompt}`;
    }
    mood = {
      label: concept.title || 'LLM Lifestyle Concept',
      keyframe_prompt: kfPrompt,
      motion_prompt: concept.motion_prompt,
      outfit: '',  // LLM bakes outfit into the keyframe prompt
      music_mood: concept.music_mood || 'upbeat',
    };
  } else {
    // ===== LEGACY PATH: hardcoded mood (alert user via Telegram) =====
    const reason = concept ? `concept ${concept.id.slice(0,8)} is missing keyframe_prompt` : 'no concept passed';
    log.warn(`SILENT-FALLBACK ALERT: ${reason}. Using hardcoded MOODS.`);
    try {
      const axios = require('axios');
      const TBT = process.env.TELEGRAM_BOT_TOKEN;
      const TCID = process.env.TELEGRAM_CHAT_ID;
      if (TBT && TCID) {
        await axios.post(`https://api.telegram.org/bot${TBT}/sendMessage`, {
          chat_id: TCID,
          text: `⚠️ *Lifestyle Worker Fallback*\n\n${reason}\n\nUsing hardcoded MOODS instead of LLM-drafted concept. Investigate.`,
          parse_mode: 'Markdown',
        }, { timeout: 8000 }).catch(()=>{});
      }
    } catch {}
    moodKey = pickMood(args.mood);
    mood = MOODS[moodKey];
  }

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
