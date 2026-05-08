/**
 * EverythinInAI — Asset Library
 *
 * Manages royalty-free music + SFX bundled with the repo. On first use,
 * fetches them from a public CDN (Pixabay's static cdn.pixabay.com) and
 * caches in avatar/video/assets/.
 *
 * Audio assets are CC0 / Pixabay-licensed (free for commercial use).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('asset_lib');

const ASSET_DIR = path.join(__dirname, 'assets');

// Curated CC0 / Pixabay-licensed audio.  Each URL serves a permanent file.
// (If any URL 404s, we fall back to a silent placeholder.)
const MUSIC_TRACKS = [
  // Calm cinematic / lofi — good for tech reviews
  { name: 'lofi_warm_keys.mp3',     url: 'https://cdn.pixabay.com/audio/2024/02/05/audio_1cf45e75d6.mp3', mood: 'calm' },
  { name: 'minimal_corporate.mp3',  url: 'https://cdn.pixabay.com/audio/2023/06/07/audio_5b8f0e7b1f.mp3', mood: 'corporate' },
  { name: 'soft_intro.mp3',         url: 'https://cdn.pixabay.com/audio/2023/03/10/audio_2c8ff09e08.mp3', mood: 'inspiring' },
];

const SFX = [
  { name: 'whoosh.mp3', url: 'https://cdn.pixabay.com/audio/2022/03/15/audio_9e9b3f8d6f.mp3', purpose: 'cut_transition' },
  { name: 'tick.mp3',   url: 'https://cdn.pixabay.com/audio/2022/03/15/audio_5a3a8a8d44.mp3', purpose: 'callout' },
  { name: 'pop.mp3',    url: 'https://cdn.pixabay.com/audio/2022/03/10/audio_2cae5c7eb3.mp3', purpose: 'punch' },
];

async function downloadIfMissing(asset) {
  const localPath = path.join(ASSET_DIR, asset.name);
  if (fs.existsSync(localPath) && fs.statSync(localPath).size > 1000) return localPath;

  log.info(`Downloading ${asset.name}...`);
  try {
    const resp = await axios.get(asset.url, { responseType: 'arraybuffer', timeout: 60_000 });
    fs.mkdirSync(ASSET_DIR, { recursive: true });
    fs.writeFileSync(localPath, Buffer.from(resp.data));
    log.info(`✓ ${asset.name} (${resp.data.byteLength} bytes)`);
    return localPath;
  } catch (err) {
    log.warn(`Could not download ${asset.name}: ${err.message}. Using fallback silence.`);
    // Generate 30 sec silence as fallback
    const { spawnSync } = require('child_process');
    fs.mkdirSync(ASSET_DIR, { recursive: true });
    spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '30', '-q:a', '9', '-acodec', 'libmp3lame', localPath], { stdio: 'ignore' });
    return localPath;
  }
}

async function getMusicTrack(mood = 'calm') {
  const candidates = MUSIC_TRACKS.filter(t => t.mood === mood);
  const pool = candidates.length > 0 ? candidates : MUSIC_TRACKS;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return downloadIfMissing(pick);
}

async function getSfx(purpose) {
  const found = SFX.find(s => s.purpose === purpose) || SFX[0];
  return downloadIfMissing(found);
}

async function ensureAllAssets() {
  log.info(`Caching ${MUSIC_TRACKS.length + SFX.length} audio assets...`);
  for (const a of [...MUSIC_TRACKS, ...SFX]) {
    await downloadIfMissing(a);
  }
  log.info(`✓ Assets cached in ${ASSET_DIR}`);
}

module.exports = { getMusicTrack, getSfx, ensureAllAssets, ASSET_DIR };
