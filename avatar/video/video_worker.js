#!/usr/bin/env node
/**
 * EverythinInAI — Video Worker (Phase 11)
 *
 * Final assembly step. Pulls all the pre-generated artifacts for a Reel
 * concept and stitches them into the final MP4.
 *
 * Pre-conditions (must be done before this runs):
 *   1. reel_keyframes has 4 rows for the concept (run image_worker.js)
 *   2. reel_concepts.voice_url is set (run voice_worker.js)
 *
 * Pipeline:
 *   1. Fetch concept + keyframes + voice URL from DB
 *   2. Download voice WAV locally
 *   3. Run Whisper to get word-level cues
 *   4. Run ffmpeg assembler → MP4
 *   5. Upload MP4 to Supabase Storage
 *   6. Update reel_concepts: video_url, state='ready'
 *
 * Usage:
 *   node avatar/video/video_worker.js <concept_id>
 *   node avatar/video/video_worker.js --winner
 *   node avatar/video/video_worker.js --winner --date=2026-05-08
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const { generateCaptions } = require('./caption_generator');
const { assembleReel } = require('./video_assembler');

const log = createLogger('video_worker');

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

async function downloadFile(url, destPath) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000 });
  fs.writeFileSync(destPath, Buffer.from(resp.data));
  return destPath;
}

async function uploadVideo(localPath, conceptId) {
  const db = dbModule.getClient();
  const buf = fs.readFileSync(localPath);
  const storagePath = `reels/${conceptId}/${Date.now()}.mp4`;
  const { error } = await db.storage
    .from('avi-images')
    .upload(storagePath, buf, {
      contentType: 'video/mp4',
      upsert: true,
      cacheControl: '31536000',
    });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  const { data: pub } = db.storage.from('avi-images').getPublicUrl(storagePath);
  return { publicUrl: pub.publicUrl, storagePath, sizeBytes: buf.length };
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

  // Fetch keyframes
  const { data: keyframes, error: kfErr } = await db.from('reel_keyframes')
    .select('*')
    .eq('concept_id', concept.id)
    .order('keyframe_idx', { ascending: true });
  if (kfErr) throw kfErr;
  if (!keyframes || keyframes.length < 2) {
    log.error(`Concept has only ${keyframes?.length || 0} keyframes. Run image_worker.js first.`);
    process.exit(1);
  }
  log.info(`Found ${keyframes.length} keyframes.`);

  // Update state
  await db.from('reel_concepts').update({
    state: 'assembling',
    updated_at: new Date().toISOString(),
  }).eq('id', concept.id);

  // Workspace
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `reel-${concept.id.slice(0, 8)}-`));
  log.info(`Workspace: ${workDir}`);

  try {
    // 1. Download voice
    const voicePath = path.join(workDir, 'voice.wav');
    log.info(`Downloading voice ${concept.voice_url}...`);
    await downloadFile(concept.voice_url, voicePath);

    // 2. Generate captions
    log.info(`Generating word-level captions...`);
    const captions = await generateCaptions(concept.voice_url);

    // 3. Assemble video
    const outputPath = path.join(workDir, 'reel.mp4');
    const result = await assembleReel({
      imageUrls: keyframes.map(k => k.image_url),
      voicePath,
      cues: captions.cues,
      duration: captions.duration,
      workDir,
      outputPath,
    });

    // 4. Upload to storage
    log.info(`Uploading MP4 to Supabase Storage...`);
    const hosted = await uploadVideo(result.outputPath, concept.id);

    // 5. Update concept
    await db.from('reel_concepts').update({
      video_url: hosted.publicUrl,
      state: 'ready',
      updated_at: new Date().toISOString(),
    }).eq('id', concept.id);

    log.info(`══════════════════════════════════════════════`);
    log.info(`✓ Reel assembled and uploaded.`);
    log.info(`   url       : ${hosted.publicUrl}`);
    log.info(`   duration  : ${result.duration.toFixed(2)}s`);
    log.info(`   size      : ${(hosted.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
    log.info(`   captions  : ${captions.cues.length} cues, ~$${captions.cost_usd}`);
    log.info(`══════════════════════════════════════════════`);
  } finally {
    // Clean up workspace (keep on error for debugging)
    if (process.exitCode !== 1) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  }
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
