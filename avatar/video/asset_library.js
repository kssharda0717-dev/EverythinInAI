/**
 * EverythinInAI — Asset Library v2
 *
 * Synthesizes a soft ambient pad with ffmpeg if external download fails.
 * No external dependencies — works offline forever.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawnSync } = require('child_process');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('asset_lib');

const ASSET_DIR = path.join(__dirname, 'assets');

const MUSIC_TRACKS = [
  { name: 'lofi_warm.mp3', url: 'https://invalid.example/will-fall-back.mp3', mood: 'calm' },
];

const SFX = [
  { name: 'whoosh.mp3', url: 'https://invalid.example/will-fall-back.mp3', purpose: 'cut_transition' },
  { name: 'tick.mp3',   url: 'https://invalid.example/will-fall-back.mp3', purpose: 'callout' },
  { name: 'pop.mp3',    url: 'https://invalid.example/will-fall-back.mp3', purpose: 'punch' },
];

function synthesizeMusic(localPath ) {
  // Soft ambient pad: two warm sine waves at A2 + E3, low-pass filtered, fade in/out
  const r = spawnSync('ffmpeg', ['-y',
    '-f','lavfi','-i','sine=frequency=110:duration=30',
    '-f','lavfi','-i','sine=frequency=165:duration=30',
    '-filter_complex',
      '[0:a]volume=0.06[a1];' +
      '[1:a]volume=0.04[a2];' +
      '[a1][a2]amix=inputs=2:duration=first,lowpass=f=1200,afade=t=in:st=0:d=2,afade=t=out:st=27:d=3',
    '-q:a','5','-acodec','libmp3lame',
    localPath,
  ], { stdio: 'ignore' });
  return r.status === 0;
}

function synthesizeSfx(purpose, localPath) {
  // Generate appropriate SFX based on purpose
  let filter;
  let duration;
  if (purpose === 'cut_transition') {
    // whoosh: pink noise sweep with band-pass
    filter = 'anoisesrc=color=pink:duration=0.4,bandpass=f=800:w=600,volume=0.5,afade=t=in:st=0:d=0.05,afade=t=out:st=0.2:d=0.2';
    duration = 0.4;
  } else if (purpose === 'punch') {
    // sub-bass thud
    filter = 'sine=frequency=70:duration=0.25,volume=0.5,afade=t=out:st=0.1:d=0.15';
    duration = 0.25;
  } else {
    // tick: short high pop
    filter = 'sine=frequency=2200:duration=0.06,volume=0.3,afade=t=out:st=0.02:d=0.04';
    duration = 0.06;
  }
  const r = spawnSync('ffmpeg', ['-y','-f','lavfi','-i', filter, '-q:a','5','-acodec','libmp3lame', localPath], { stdio: 'ignore' });
  return r.status === 0;
}

async function ensureAsset(asset, isSfx = false) {
  const localPath = path.join(ASSET_DIR, asset.name);
  if (fs.existsSync(localPath) && fs.statSync(localPath).size > 1000) return localPath;

  fs.mkdirSync(ASSET_DIR, { recursive: true });

  // Try download first
  try {
    const resp = await axios.get(asset.url, { responseType: 'arraybuffer', timeout: 30_000 });
    fs.writeFileSync(localPath, Buffer.from(resp.data));
    if (fs.statSync(localPath).size > 1000) {
      log.info(`✓ ${asset.name} downloaded`);
      return localPath;
    }
  } catch (err) {
    // fall through to synthesis
  }

  // Synthesize
  log.info(`Synthesizing ${asset.name} via ffmpeg...`);
  const ok = isSfx ? synthesizeSfx(asset.purpose, localPath) : synthesizeMusic(localPath);
  if (ok && fs.existsSync(localPath) && fs.statSync(localPath).size > 1000) {
    log.info(`✓ ${asset.name} synthesized (${fs.statSync(localPath).size} bytes)`);
    return localPath;
  }
  log.warn(`Failed to synthesize ${asset.name}; returning silence-or-empty path`);
  return localPath;
}

async function getMusicTrack(mood = 'calm') {
  const candidates = MUSIC_TRACKS.filter(t => t.mood === mood);
  const pool = candidates.length > 0 ? candidates : MUSIC_TRACKS;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return ensureAsset(pick, false);
}

async function getSfx(purpose) {
  const found = SFX.find(s => s.purpose === purpose) || SFX[0];
  return ensureAsset(found, true);
}

async function ensureAllAssets() {
  for (const a of MUSIC_TRACKS) await ensureAsset(a, false);
  for (const a of SFX)          await ensureAsset(a, true);
  log.info(`✓ Assets cached in ${ASSET_DIR}`);
}

module.exports = { getMusicTrack, getSfx, ensureAllAssets, ASSET_DIR };
