#!/usr/bin/env node
/**
 * EverythinInAI — Video Worker (Phase 11 v2 — talking-head)
 *
 * Final assembly. Takes the SadTalker-generated talking-head MP4
 * and burns word-level captions on top.
 *
 * Pre-conditions:
 *   1. concept.voice_url is set       (voice_worker.js)
 *   2. reel_keyframes has hero        (hero_worker.js)
 *   3. lipsync_worker.js produced concept.video_url (talking-head MP4)
 *
 * Usage:
 *   node avatar/video/video_worker.js <concept_id>
 *   node avatar/video/video_worker.js --winner
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { spawnSync } = require('child_process');
const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const { generateCaptions } = require('./caption_generator');
const { buildAssSubtitles } = require('./video_assembler');

const log = createLogger('video_worker');

const W = 1080;
const H = 1350;     // 4:5

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
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 300_000 });
  fs.writeFileSync(destPath, Buffer.from(resp.data));
  return destPath;
}

async function uploadVideo(localPath, conceptId) {
  const db = dbModule.getClient();
  const buf = fs.readFileSync(localPath);
  const storagePath = `reels/${conceptId}/${Date.now()}-final.mp4`;
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

/**
 * Burn ASS captions onto a talking-head MP4 + scale to 1080x1350.
 */
function burnCaptions(inputMp4, subAssPath, outputMp4) {
  // Scale to fit 1080x1350 (pad with blur if aspect doesn't match)
  // Then burn the ASS subtitles
  const escapedSub = subAssPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  const filter = [
    // Scale to fit, preserve aspect, pad with blurred copy of self for cinematic look
    `[0:v]split=2[main][bg]`,
    `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=30[bg2]`,
    `[main]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg]`,
    `[bg2][fg]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[v]`,
    `[v]ass=${escapedSub}[vout]`,
  ].join(';');

  const args = [
    '-y',
    '-i', inputMp4,
    '-filter_complex', filter,
    '-map', '[vout]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-r', '30',
    '-shortest',
    outputMp4,
  ];

  log.info(`Running ffmpeg burn (${args.length} args)...`);
  const r = spawnSync('ffmpeg', args, { stdio: 'inherit', timeout: 300_000 });
  if (r.status !== 0) throw new Error(`ffmpeg burn failed (status=${r.status})`);
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
    log.error('No voice_url. Run voice_worker.js first.');
    process.exit(1);
  }
  if (!concept.video_url) {
    log.error('No video_url (talking-head). Run lipsync_worker.js first.');
    process.exit(1);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `final-${concept.id.slice(0, 8)}-`));
  log.info(`Workspace: ${workDir}`);

  try {
    // 1. Generate captions from voice
    log.info(`Generating word-level captions from voice...`);
    const captions = await generateCaptions(concept.voice_url);

    // 2. Write ASS file
    const subPath = path.join(workDir, 'captions.ass');
    fs.writeFileSync(subPath, buildAssSubtitles(captions.cues, captions.duration));

    // 3. Download the talking-head MP4
    const talkingHeadPath = path.join(workDir, 'talking-head.mp4');
    log.info(`Downloading talking-head MP4...`);
    await downloadFile(concept.video_url, talkingHeadPath);

    // 4. Burn captions + scale to 1080x1350
    const outputPath = path.join(workDir, 'final.mp4');
    burnCaptions(talkingHeadPath, subPath, outputPath);

    // 5. Upload final
    log.info(`Uploading final MP4 to Supabase Storage...`);
    const hosted = await uploadVideo(outputPath, concept.id);

    // 6. Update concept (overwrite video_url with the FINAL captioned version)
    await db.from('reel_concepts').update({
      video_url: hosted.publicUrl,
      state: 'ready',
      updated_at: new Date().toISOString(),
    }).eq('id', concept.id);

    log.info(`══════════════════════════════════════════════`);
    log.info(`✓ FINAL Reel ready.`);
    log.info(`   url       : ${hosted.publicUrl}`);
    log.info(`   duration  : ${captions.duration.toFixed(2)}s`);
    log.info(`   size      : ${(hosted.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
    log.info(`   captions  : ${captions.cues.length} cues`);
    log.info(`══════════════════════════════════════════════`);
  } finally {
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
