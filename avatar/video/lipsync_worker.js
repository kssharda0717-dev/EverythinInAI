#!/usr/bin/env node
/**
 * EverythinInAI — Lip-Sync Worker
 *
 * Takes:
 *   - One hero keyframe URL (front-facing Avi)
 *   - Voice WAV URL
 * Produces:
 *   - Talking-head MP4 with Avi's lips synced to the audio
 *
 * Uses wan-video/wan-2.2-s2v (~$0.60/Reel, ~2-3 min) for cost-effective high-quality lip-sync.
 *
 * Usage (standalone):
 *   node avatar/video/lipsync_worker.js <concept_id>
 *   node avatar/video/lipsync_worker.js --winner
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const { runModel } = require('../imagery/replicate_client');

const log = createLogger('lipsync');

function parseArgs(argv) {
  const args = { conceptId: null, useWinner: false, date: null };
  for (const a of argv.slice(2)) {
    if (a === '--winner') args.useWinner = true;
    else if (a.startsWith('--date=')) args.date = a.split('=')[1];
    else if (!a.startsWith('--')) args.conceptId = a;
  }
  return args;
}

async function getConcept(db, args) {
  if (args.conceptId) {
    const { data } = await db.from('reel_concepts').select('*').eq('id', args.conceptId).maybeSingle();
    return data;
  }
  if (args.useWinner) {
    const date = args.date || new Date().toISOString().slice(0, 10);
    const { data } = await db.from('reel_concepts')
      .select('*')
      .eq('target_date', date)
      .eq('is_winner', true)
      .maybeSingle();
    return data;
  }
  return null;
}

async function rehostVideo(sourceUrl, destPath) {
  const db = dbModule.getClient();
  const resp = await axios.get(sourceUrl, { responseType: 'arraybuffer', timeout: 300_000 });
  const buf = Buffer.from(resp.data);
  const { error } = await db.storage
    .from('avi-images')
    .upload(destPath, buf, {
      contentType: 'video/mp4',
      upsert: true,
      cacheControl: '31536000',
    });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  const { data: pub } = db.storage.from('avi-images').getPublicUrl(destPath);
  return { publicUrl: pub.publicUrl, storagePath: destPath, sizeBytes: buf.length };
}

/**
 * Run Pruna p-video-avatar (official Replicate model, $0.025/s at 720p).
 *   - Input:  hero image URL + voice WAV URL
 *   - Output: talking-head MP4 (~₹25-30 for a 12-second reel)
 *   - Phoneme-aware lip-sync, fast (10-15s render), head-and-shoulders friendly.
 *   - Falls back to OmniHuman ONLY if Pruna hard-fails (very rare for official models).
 * @returns {Promise<string>} URL of the rehosted MP4
 */
async function generateTalkingHead({ heroImageUrl, voiceUrl, conceptId }) {
  log.info(`Sending to Pruna p-video-avatar (image=${heroImageUrl.substring(0, 60)}... audio=${voiceUrl.substring(0, 60)}...)`);
  log.info(`(Expect ~10-15s render on L40S GPU)`);

  let result;
  let usedModel = 'pruna_avatar';
  try {
    result = await runModel('pruna_avatar', {
      image: heroImageUrl,
      audio: voiceUrl,
      resolution: '720p',
      video_prompt: 'The person is speaking calmly to the camera, natural subtle facial expressions, head and shoulders framing',
    }, { timeoutMs: 300_000 });
  } catch (err) {
    log.warn(`Pruna failed (${err.message?.slice(0,150)}), falling back to OmniHuman (₹280)...`);
    usedModel = 'omni_human';
    result = await runModel('omni_human', {
      image: heroImageUrl,
      audio: voiceUrl,
    }, { timeoutMs: 900_000 });
  }

  const remoteUrl = Array.isArray(result.output) ? result.output[0] : result.output;
  log.info(`${usedModel} returned: ${remoteUrl}`);
  log.info(`Cost: ~$${result.cost_usd}, time: ${(result.generation_ms / 1000).toFixed(1)}s`);

  // Rehost to Supabase
  const destPath = `talking-heads/${conceptId}/${Date.now()}.mp4`;
  const hosted = await rehostVideo(remoteUrl, destPath);
  return { ...hosted, cost_usd: result.cost_usd, generation_ms: result.generation_ms };
}

async function main() {
  const args = parseArgs(process.argv);
  const db = dbModule.getClient();
  const concept = await getConcept(db, args);
  if (!concept) {
    log.error('No concept found. Use --winner or pass a concept_id.');
    process.exit(1);
  }
  log.info(`Concept: ${concept.title} (${concept.id})`);

  if (!concept.voice_url) {
    log.error('Concept has no voice_url. Run voice_worker.js first.');
    process.exit(1);
  }

  // Get the hero keyframe (keyframe_idx=0)
  const { data: keyframes } = await db.from('reel_keyframes')
    .select('*')
    .eq('concept_id', concept.id)
    .order('keyframe_idx', { ascending: true })
    .limit(1);
  if (!keyframes || keyframes.length === 0) {
    log.error('Concept has no keyframes. Run hero_worker.js first.');
    process.exit(1);
  }

  const heroImageUrl = keyframes[0].image_url;
  log.info(`Hero keyframe: ${heroImageUrl}`);

  await db.from('reel_concepts').update({
    state: 'assembling',
    updated_at: new Date().toISOString(),
  }).eq('id', concept.id);

  const result = await generateTalkingHead({
    heroImageUrl,
    voiceUrl: concept.voice_url,
    conceptId: concept.id,
  });

  // Save raw talking-head URL (engagement editor reads this; it's pre-edit)
  await db.from('reel_concepts').update({
    talking_head_url: result.publicUrl,
    updated_at: new Date().toISOString(),
  }).eq('id', concept.id);

  log.info(`══════════════════════════════════════════════`);
  log.info(`✓ Talking-head video generated.`);
  log.info(`   url   : ${result.publicUrl}`);
  log.info(`   size  : ${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
  log.info(`   cost  : ~$${result.cost_usd}`);
  log.info(`══════════════════════════════════════════════`);
  log.info(``);
  log.info(`Next: node avatar/video/video_worker.js --winner    (burns captions onto this)`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
