/**
 * EverythinInAI — Video Assembler v2 (engagement edit)
 *
 * Takes a base talking-head MP4 and applies the engagement plan:
 *   - B-roll cuts (overlay screenshots / stat callouts at planned times)
 *   - Zoom punches (zoom 1.0 → 1.10-1.15× during emphasis windows)
 *   - Bouncy captions burned in
 *   - Audio mix: voice (existing in talking-head) + music bed (-18dB) + SFX layer
 *
 * Strategy: chain ffmpeg filters carefully. Multi-pass to avoid filter explosion.
 *   Pass 1: zoom punches + B-roll overlays + scale to 1080x1350
 *   Pass 2: audio mix (voice + music + SFX)
 *   Pass 3: burn captions on top
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const axios = require('axios');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('assembler');

const W = 1080;
const H = 1350;
const FPS = 30;

function runFfmpeg(args, label = 'ffmpeg') {
  log.info(`Running ${label} (${args.length} args)...`);
  const r = spawnSync('ffmpeg', args, { stdio: 'inherit', timeout: 600_000 });
  if (r.status !== 0) throw new Error(`${label} failed (status=${r.status})`);
}

/**
 * Pass 1: Apply zoom punches + B-roll overlays, scale to 1080x1350.
 *
 * Approach for zoom punches: split the video into segments at zoom boundaries,
 * apply a per-segment scale animation, concat. Too complex for one filter.
 *
 * Simpler: use a single zoompan that follows a piecewise function via expressions.
 * We use `if(between(t,a,b),...)` to vary scale only during punch windows.
 */
function buildBaseFilter(plan, totalDuration) {
  // Build a piecewise zoom expression using nested if(between(t,...)...)
  // Default scale is 1.0. During each zoom_punch, scale rises to N then settles back.
  let scaleExpr = '1.0';
  for (const z of plan.zoom_punches) {
    const dur = z.to_sec - z.from_sec;
    const half = dur / 2;
    // Zoom in over first half, hold/fade out second half
    const expr = `if(between(t,${z.from_sec},${z.to_sec}),${z.scale}-${(z.scale - 1).toFixed(3)}*abs(2*(t-${z.from_sec})/${dur}-1),REPLACE)`;
    scaleExpr = expr.replace('REPLACE', scaleExpr);
  }

  // Final filter: zoompan implements the dynamic scale. Then scale to 1080x1350.
  // zoompan's `z` is the per-frame scale factor.
  const filter = [
    // Background: blurred copy of self for letterboxing
    `[0:v]split=2[main][bg]`,
    `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=40[bg2]`,
    // Main: scale to fit, then dynamic zoom
    `[main]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg0]`,
    `[fg0]scale=2*iw:2*ih,zoompan=z='${scaleExpr}':d=1:s=${W}x${H}:fps=${FPS}[fg]`,
    // Composite
    `[bg2][fg]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[v]`,
  ].join(';');

  return filter;
}

/**
 * Build B-roll overlay filter chain (separate ffmpeg pass for clarity).
 *   For each B-roll cut, the still image is shown over the talking-head
 *   for `duration` seconds starting at `at_sec`.
 */
function buildBrollOverlay(brollLocalPaths, brollEvents) {
  // brollLocalPaths is the list of local image paths in order matching brollEvents
  // We chain N overlays sequentially.
  const filters = [`[0:v]null[base0]`];
  for (let i = 0; i < brollEvents.length; i++) {
    const ev = brollEvents[i];
    const inputIdx = i + 1;       // input 0 = base video, 1+ = b-roll images
    const prev = `base${i}`;
    const next = `base${i + 1}`;
    // overlay only between [at_sec, at_sec+duration]
    filters.push(
      `[${inputIdx}:v]scale=${W}:${H}:force_original_aspect_ratio=cover,crop=${W}:${H}[bv${i}]`
    );
    filters.push(
      `[${prev}][bv${i}]overlay=enable='between(t,${ev.at_sec},${ev.at_sec + ev.duration})'[${next}]`
    );
  }
  filters.push(`[base${brollEvents.length}]null[v]`);
  return filters.join(';');
}

/**
 * Pass 1: Apply B-roll overlays + zoom punches + scale to 1080×1350.
 */
async function applyVisualEdits({ inputMp4, plan, brollLocalPaths, outputMp4, totalDuration }) {
  const brollEvents = plan.broll_cuts;
  const hasBroll = brollEvents.length > 0 && brollLocalPaths.length === brollEvents.length;

  // Build filter
  const baseFilter = buildBaseFilter(plan, totalDuration);
  const brollFilter = hasBroll ? buildBrollOverlay(brollLocalPaths, brollEvents) : '';

  let filter;
  let inputs = ['-i', inputMp4];
  if (hasBroll) {
    // Add B-roll inputs
    for (const p of brollLocalPaths) {
      inputs.push('-loop', '1', '-t', String(totalDuration + 1), '-i', p);
    }
    // Combine: do B-roll overlay first (on raw input), then zoom + scale on the result
    // Restructure: input 0 = video; we run brollFilter first → [base], then baseFilter on [base]
    // Easier: apply broll on raw [0:v] producing [vbroll], then re-feed as if it were input 0.
    // For simplicity here: use single mega-filter combining both.
    filter = brollFilter.replace('[0:v]null[base0]', '[0:v]null[base0]') +
             ';' +
             baseFilter.replace('[0:v]', '[v]').replace('[v]', '[vfinal]');
    // hmm tricky. Cleaner: run broll-pass first, THEN visual-edits pass. Two ffmpeg calls.
  }

  // === Two-pass approach (cleaner) ===
  if (hasBroll) {
    // Pass 1a: broll only
    const tmpA = outputMp4.replace(/\.mp4$/, '.broll.mp4');
    const args1 = [
      '-y',
      '-i', inputMp4,
      ...brollLocalPaths.flatMap(p => ['-loop', '1', '-t', String(totalDuration + 1), '-i', p]),
      '-filter_complex', brollFilter,
      '-map', '[v]',
      '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-c:a', 'copy',
      '-pix_fmt', 'yuv420p',
      '-shortest',
      tmpA,
    ];
    runFfmpeg(args1, 'broll-pass');

    // Pass 1b: zoom + scale
    const args2 = [
      '-y',
      '-i', tmpA,
      '-filter_complex', baseFilter,
      '-map', '[v]',
      '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-c:a', 'copy',
      '-pix_fmt', 'yuv420p',
      '-r', String(FPS),
      '-shortest',
      outputMp4,
    ];
    runFfmpeg(args2, 'zoom-pass');
    fs.unlinkSync(tmpA);
  } else {
    // Single pass with just zoom + scale
    const args = [
      '-y',
      '-i', inputMp4,
      '-filter_complex', baseFilter,
      '-map', '[v]',
      '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-c:a', 'copy',
      '-pix_fmt', 'yuv420p',
      '-r', String(FPS),
      '-shortest',
      outputMp4,
    ];
    runFfmpeg(args, 'zoom-only');
  }
}

/**
 * Pass 2: Mix audio (voice already in input) + music bed + SFX layer.
 */
async function mixAudio({ inputMp4, musicPath, sfxEvents, sfxAssetMap, outputMp4, totalDuration }) {
  const inputs = ['-i', inputMp4];
  let nextIdx = 1;

  // Music input (if exists)
  let musicIdx = null;
  if (musicPath && fs.existsSync(musicPath)) {
    inputs.push('-i', musicPath);
    musicIdx = nextIdx++;
  }

  // SFX inputs
  const sfxInputIndices = [];
  for (const ev of sfxEvents) {
    const sfxPath = sfxAssetMap[ev.type];
    if (sfxPath && fs.existsSync(sfxPath)) {
      inputs.push('-i', sfxPath);
      sfxInputIndices.push({ idx: nextIdx++, ev });
    }
  }

  // Build audio filter
  const audioParts = [`[0:a]volume=1.0[voice]`];
  let mixInputs = ['[voice]'];

  if (musicIdx !== null) {
    audioParts.push(`[${musicIdx}:a]aloop=loop=-1:size=2e9,atrim=0:${totalDuration},asetpts=N/SR/TB,volume=0.20[music]`);
    mixInputs.push('[music]');
  }
  for (const s of sfxInputIndices) {
    audioParts.push(`[${s.idx}:a]adelay=${Math.round(s.ev.at_sec * 1000)}|${Math.round(s.ev.at_sec * 1000)},volume=0.5[sfx${s.idx}]`);
    mixInputs.push(`[sfx${s.idx}]`);
  }

  audioParts.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0[aout]`);
  const filter = audioParts.join(';');

  const args = [
    '-y',
    ...inputs,
    '-filter_complex', filter,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-shortest',
    outputMp4,
  ];
  runFfmpeg(args, 'audio-mix');
}

/**
 * Pass 3: Burn ASS subtitles on top.
 */
async function burnCaptions({ inputMp4, subAssPath, outputMp4 }) {
  const escapedSub = subAssPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const args = [
    '-y',
    '-i', inputMp4,
    '-vf', `ass=${escapedSub}`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-r', String(FPS),
    outputMp4,
  ];
  runFfmpeg(args, 'caption-burn');
}

async function downloadFile(url, destPath) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000 });
  fs.writeFileSync(destPath, Buffer.from(resp.data));
  return destPath;
}

module.exports = {
  applyVisualEdits,
  mixAudio,
  burnCaptions,
  downloadFile,
  W, H, FPS,
};
