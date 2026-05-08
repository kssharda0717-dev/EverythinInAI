/**
 * EverythinInAI — Video Assembler
 *
 * Takes:
 *   - 4 keyframe URLs (from reel_keyframes)
 *   - voice track URL (from reel_concepts.voice_url)
 *   - SRT cues (from caption_generator)
 * Produces:
 *   - 1080×1350 MP4 H.264 30 fps (IG Reel safe)
 *
 * Each keyframe is shown for ~total_duration / 4 with a slow Ken Burns zoom-pan.
 * Crossfades between keyframes (~0.5s).
 * Captions burned in TikTok-style (one or two words at a time, big bold center).
 *
 * The caller passes already-downloaded local file paths.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('video_assembler');

const W = 1080;
const H = 1350;          // 4:5 IG-Reel safe
const FPS = 30;

/**
 * Build the ffmpeg complex filter for a Ken Burns + crossfade slideshow.
 */
function buildFilter(numImages, perImageDuration, transitionDuration) {
  // Each image gets:  scale → zoompan (Ken Burns) → fps → setsar
  // Then we xfade them sequentially.

  const zoomFrames = Math.round(perImageDuration * FPS);
  const inputFilters = [];

  for (let i = 0; i < numImages; i++) {
    // Alternate between zoom-in and zoom-out for variety
    const zoomDir = i % 2 === 0
      ? `zoom='min(zoom+0.0008,1.20)'`
      : `zoom='if(lte(zoom,1.001),1.20,max(zoom-0.0008,1.0))'`;

    // Random pan direction (top-left, top-right, bottom-left, bottom-right)
    const panDirs = [
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,                                      // center hold
      `x='iw/2-(iw/zoom/2)+sin(on/${zoomFrames}*PI)*30':y='ih/2-(ih/zoom/2)'`,          // small horizontal sway
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)+sin(on/${zoomFrames}*PI)*30'`,          // small vertical sway
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    ];
    const pan = panDirs[i % panDirs.length];

    inputFilters.push(
      `[${i}:v]scale=${W * 1.5}:${H * 1.5}:force_original_aspect_ratio=increase,` +
      `crop=${W * 1.5}:${H * 1.5},` +
      `zoompan=${zoomDir}:${pan}:d=${zoomFrames}:s=${W}x${H}:fps=${FPS},` +
      `setsar=1[v${i}]`
    );
  }

  // xfade chain
  const xfadeFilters = [];
  let prev = 'v0';
  for (let i = 1; i < numImages; i++) {
    const offset = (perImageDuration * i) - transitionDuration;
    const out = (i === numImages - 1) ? 'vout' : `vx${i}`;
    xfadeFilters.push(
      `[${prev}][v${i}]xfade=transition=fade:duration=${transitionDuration}:offset=${offset.toFixed(3)}[${out}]`
    );
    prev = out;
  }

  return [...inputFilters, ...xfadeFilters].join(';');
}

/**
 * Generate ASS subtitle file (better styling than SRT for burned-in captions)
 */
function buildAssSubtitles(cues, totalSeconds) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Montserrat,84,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,2,2,80,80,330,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = cues.map(c => {
    const start = assTime(c.start);
    const end = assTime(c.end);
    // Add a subtle pop/scale animation: \fad fade-in/out + \fscx grow
    const text = `{\\fad(80,80)\\fscx100\\fscy100}${c.text}`;
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`;
  }).join('\n');

  return header + events;
}

function assTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(2);
  const [sec, cs] = s.split('.');
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${cs}`;
}

/**
 * Main entry: assemble a Reel.
 *
 * @param {Object} opts
 *   - imageUrls:   string[] (4 keyframe URLs)
 *   - voicePath:   string (local path to voice WAV)
 *   - cues:        Array<{start, end, text}>
 *   - duration:    number (total voice duration in seconds)
 *   - workDir:     string (temp dir for downloads + intermediate files)
 *   - outputPath:  string (where to write final mp4)
 * @returns {Promise<{outputPath: string, duration: number, sizeBytes: number}>}
 */
async function assembleReel(opts) {
  const { imageUrls, voicePath, cues, duration, workDir, outputPath } = opts;
  const numImages = imageUrls.length;
  if (numImages < 2) throw new Error('Need at least 2 keyframes');

  fs.mkdirSync(workDir, { recursive: true });

  // 1. Download keyframes locally (ffmpeg can't xfade chain remote URLs reliably)
  const axios = require('axios');
  const localImages = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const localPath = path.join(workDir, `kf${i}.webp`);
    log.info(`Downloading keyframe ${i + 1}/${numImages}...`);
    const resp = await axios.get(imageUrls[i], { responseType: 'arraybuffer', timeout: 60_000 });
    fs.writeFileSync(localPath, Buffer.from(resp.data));
    localImages.push(localPath);
  }

  // 2. Compute timing
  const transitionDuration = 0.6;
  // Total visible time per image must include the overlap of the next xfade.
  // If we set perImageDuration = duration / numImages, the last image cuts short.
  // Fix: extend each image segment so xfade overlaps cleanly.
  const perImageDuration = duration / numImages + transitionDuration;
  log.info(`Total ${duration.toFixed(2)}s / ${numImages} keyframes → ${perImageDuration.toFixed(2)}s each w/ ${transitionDuration}s crossfade`);

  // 3. Write subtitle file
  const subPath = path.join(workDir, 'captions.ass');
  fs.writeFileSync(subPath, buildAssSubtitles(cues, duration));

  // 4. Build ffmpeg filter (xfade chain ending in [vmid], then subtitle-burn into [vout])
  const xfadeChain = buildFilter(numImages, perImageDuration, transitionDuration);
  // Append subtitle filter to the chain
  // Note: ass= filter wants forward slashes even on Linux; escape colons in path.
  const escapedSubPath = subPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const filterComplex = xfadeChain.replace(/\[vout\]$/, '[vmid]') + `;[vmid]ass=${escapedSubPath}[vout]`;

  // 5. Run ffmpeg
  const args = [
    '-y',
    // Image inputs (loop each so zoompan can run as long as it needs)
    ...localImages.flatMap(p => ['-loop', '1', '-t', String(perImageDuration + 1), '-i', p]),
    // Audio input
    '-i', voicePath,
    // Filter (xfade + subtitle burn)
    '-filter_complex', filterComplex,
    // Map: filtered video + audio
    '-map', '[vout]',
    '-map', `${numImages}:a`,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-shortest',
    '-r', String(FPS),
    outputPath,
  ];

  log.info(`Running ffmpeg with ${args.length} args (this takes 30-60s)...`);
  const r = spawnSync('ffmpeg', args, { stdio: 'inherit', timeout: 300_000 });
  if (r.status !== 0) throw new Error(`ffmpeg assembly failed (status=${r.status})`);

  const stat = fs.statSync(outputPath);
  log.info(`✓ Reel assembled: ${outputPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

  return { outputPath, duration, sizeBytes: stat.size };
}

module.exports = { assembleReel, buildFilter, buildAssSubtitles };
