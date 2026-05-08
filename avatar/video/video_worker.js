#!/usr/bin/env node
/**
 * EverythinInAI — Video Worker (Phase 11.5: engagement edit)
 *
 * Pipeline (after lipsync_worker has produced the talking-head MP4):
 *   1. Generate word-level captions (Whisper)
 *   2. Plan engagement (B-roll cuts + zoom punches + SFX events)
 *   3. Generate B-roll assets (Microlink screenshots / stat callouts)
 *   4. Cache music + SFX assets
 *   5. Apply visual edits (B-roll overlays + zoom punches + scale)
 *   6. Mix audio (voice + music bed + SFX)
 *   7. Burn bouncy captions
 *   8. Upload final MP4
 *
 * Usage:
 *   node avatar/video/video_worker.js --winner
 *   node avatar/video/video_worker.js <concept_id>
 *   node avatar/video/video_worker.js --winner --no-music   # skip music bed
 *   node avatar/video/video_worker.js --winner --no-broll   # skip B-roll cuts
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const { generateCaptions, buildBouncyAss } = require('./caption_generator');
const { planEngagement } = require('./engagement_planner');
const { screenshotUrl, generateStatCallout } = require('./broll_generator');
const { getMusicTrack, getSfx } = require('./asset_library');
const {
  applyVisualEdits, mixAudio, burnCaptions, downloadFile,
  W, H,
} = require('./video_assembler');

const log = createLogger('video_worker');

function parseArgs(argv) {
  const args = { conceptId: null, useWinner: false, date: null, noMusic: false, noBroll: false };
  for (const a of argv.slice(2)) {
    if (a === '--winner') args.useWinner = true;
    else if (a === '--no-music') args.noMusic = true;
    else if (a === '--no-broll') args.noBroll = true;
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

async function getSignalUrl(db, signalId) {
  if (!signalId) return null;
  const { data } = await db.from('ai_signals').select('url, entities, topics').eq('id', signalId).maybeSingle();
  return data;
}

async function uploadFinal(localPath, conceptId) {
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

async function main() {
  const args = parseArgs(process.argv);
  const db = dbModule.getClient();

  const concept = await getConcept(db, args);
  if (!concept) { log.error('No concept. Use --winner or pass id.'); process.exit(1); }
  log.info(`Concept: ${concept.title}`);

  if (!concept.voice_url) { log.error('No voice_url'); process.exit(1); }
    if (!concept.talking_head_url) { log.error('No talking_head_url (run lipsync_worker.js first)'); process.exit(1); }


  // Enrich concept with signal data
  const signalData = await getSignalUrl(db, concept.signal_id);
  const enrichedConcept = {
    ...concept,
    signal_url: signalData?.url || null,
    entities: signalData?.entities || [],
    topics: signalData?.topics || [],
  };

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `final-${concept.id.slice(0, 8)}-`));
  log.info(`Workspace: ${workDir}`);

  try {
    // 1. Captions
    log.info(`[1/7] Generating word-level captions...`);
    const captions = await generateCaptions(concept.voice_url);

    // 2. Engagement plan
    log.info(`[2/7] Planning engagement...`);
    const plan = planEngagement(captions.cues, enrichedConcept);

    if (args.noBroll) {
      plan.broll_cuts = [];
      log.info('   B-roll disabled by flag');
    }

    // 3. Generate B-roll assets
    log.info(`[3/7] Generating ${plan.broll_cuts.length} B-roll asset(s)...`);
    const brollLocalPaths = [];
    for (let i = 0; i < plan.broll_cuts.length; i++) {
      const cut = plan.broll_cuts[i];
      const brollPath = path.join(workDir, `broll-${i}.png`);
      try {
        if (cut.type === 'screenshot' && cut.source_url) {
          await screenshotUrl(cut.source_url, brollPath, { width: W, height: H });
        } else if (cut.type === 'stat_callout') {
          generateStatCallout(cut.stat_text || '?', cut.stat_subtext || '', brollPath, { width: W, height: H });
        }
        if (fs.existsSync(brollPath) && fs.statSync(brollPath).size > 1000) {
          brollLocalPaths.push(brollPath);
        } else {
          log.warn(`   Skipped B-roll #${i} (empty file)`);
          plan.broll_cuts.splice(i, 1);
          i--;
        }
      } catch (err) {
        log.warn(`   B-roll #${i} failed: ${err.message} \u2014 skipping`);
        plan.broll_cuts.splice(i, 1);
        i--;
      }
    }

    // 4. Cache audio assets
    log.info(`[4/7] Caching audio assets...`);
    const musicPath = args.noMusic ? null : await getMusicTrack('calm');
    const sfxAssetMap = {};
    for (const ev of plan.sfx_events) {
      if (!sfxAssetMap[ev.type]) sfxAssetMap[ev.type] = await getSfx(ev.type);
    }

    // 5. Download base talking-head
    const baseMp4 = path.join(workDir, 'base.mp4');
    log.info(`Downloading talking-head MP4...`);
        await downloadFile(concept.talking_head_url, baseMp4);


    // 6. Apply visual edits (B-roll + zoom + scale to 1080x1350)
    log.info(`[5/7] Applying visual edits...`);
    const visualMp4 = path.join(workDir, 'visual.mp4');
    await applyVisualEdits({
      inputMp4: baseMp4,
      plan,
      brollLocalPaths,
      outputMp4: visualMp4,
      totalDuration: captions.duration,
    });

    // 7. Audio mix
    log.info(`[6/7] Mixing audio (voice + music + SFX)...`);
    const mixedMp4 = path.join(workDir, 'mixed.mp4');
    await mixAudio({
      inputMp4: visualMp4,
      musicPath,
      sfxEvents: plan.sfx_events,
      sfxAssetMap,
      outputMp4: mixedMp4,
      totalDuration: captions.duration,
    });

    // 8. Captions
    log.info(`[7/7] Burning bouncy captions...`);
    const subPath = path.join(workDir, 'captions.ass');
    fs.writeFileSync(subPath, buildBouncyAss(captions.cues, captions.duration, { width: W, height: H }));
    const finalMp4 = path.join(workDir, 'final.mp4');
    await burnCaptions({ inputMp4: mixedMp4, subAssPath: subPath, outputMp4: finalMp4 });

    // 9. Upload
    log.info(`Uploading final MP4...`);
    const hosted = await uploadFinal(finalMp4, concept.id);

    await db.from('reel_concepts').update({
      video_url: hosted.publicUrl,
      state: 'ready',
      updated_at: new Date().toISOString(),
    }).eq('id', concept.id);

    log.info(`══════════════════════════════════════════════`);
    log.info(`✓ ENGAGEMENT-EDITED Reel ready.`);
    log.info(`   url       : ${hosted.publicUrl}`);
    log.info(`   duration  : ${captions.duration.toFixed(2)}s`);
    log.info(`   size      : ${(hosted.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
    log.info(`   captions  : ${captions.cues.length} bouncy cues`);
    log.info(`   B-roll    : ${plan.broll_cuts.length} cuts`);
    log.info(`   zoom punches: ${plan.zoom_punches.length}`);
    log.info(`   SFX       : ${plan.sfx_events.length} events`);
    log.info(`   music     : ${musicPath ? path.basename(musicPath) : 'disabled'}`);
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
