#!/usr/bin/env node
/**
 * EverythinInAI — Setup Voice Reference for Avi
 *
 * Downloads a public YouTube clip (the reference voice we'll clone),
 * extracts a clean 10-second audio sample using ffmpeg, uploads to
 * Supabase Storage, generates a test sample with Chatterbox, and
 * inserts a persona_voice_refs row.
 *
 * Reference voice: Mostly Sane (Prajakta Koli) — Indian English creator,
 *   warm, calm, dryly funny — closest match to Avi's tone.
 *
 * After review, mark the chosen ref as active with:
 *   node avatar/voice/activate_voice.js <voice_ref_id>
 *
 * Cost: ~$0.05 (one test sample)
 *
 * Usage:
 *   node avatar/voice/setup_voice_reference.js
 *   node avatar/voice/setup_voice_reference.js --url=<youtube_url> --label=mostly_sane --start=120 --duration=10
 *   node avatar/voice/setup_voice_reference.js --audio-url=<direct_mp3_url> --label=...
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');
const axios = require('axios');
const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');
const { runModel } = require('../imagery/replicate_client');
const { rehostImage } = require('../imagery/storage');

const log = createLogger('voice_setup');

// ─────────────────────────────────────────────────────────────────────────────
// Pre-vetted YouTube clips that yield clean voice samples.
// Each entry: a Mostly Sane vlog with mostly her voice (no music/sfx) at the start.
// We'll grab a 10-sec window starting at `start` seconds.
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_REFERENCES = [
  {
    label: 'barkha_singh_tedx',
    url: 'https://www.youtube.com/watch?v=AGRGLh1FyyQ',  // TEDxNSIT "Be the change you want to see" — 8min solo monologue, clean audio
    source_url: 'https://www.youtube.com/watch?v=AGRGLh1FyyQ',
    start_sec: 60,                          // skip the intro applause/music
    duration_sec: 10,
    notes: 'Barkha Singh TEDx solo monologue — calm articulate Indian English, no background music.',
  },
];

function parseArgs(argv) {
  const args = {
    url: null, audioUrl: null, localFile: null, label: null,
    start: 0, duration: 10, notes: '',
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--url=')) args.url = a.split('=').slice(1).join('=');
    else if (a.startsWith('--audio-url=')) args.audioUrl = a.split('=').slice(1).join('=');
    else if (a.startsWith('--local-file=')) args.localFile = a.split('=').slice(1).join('=');
    else if (a.startsWith('--label=')) args.label = a.split('=')[1];
    else if (a.startsWith('--start=')) args.start = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--duration=')) args.duration = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--notes=')) args.notes = a.split('=').slice(1).join('=');
  }
  return args;
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ensureTools() {
  if (!commandExists('ffmpeg')) {
    log.error('ffmpeg is required. Install with: sudo apt-get install -y ffmpeg');
    process.exit(1);
  }
}

async function downloadYouTubeClip(youtubeUrl, outPath) {
  if (!commandExists('yt-dlp')) {
    log.info('Installing yt-dlp...');
    execSync('sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp', { stdio: 'inherit' });
  }
  log.info(`Downloading audio from ${youtubeUrl}...`);
  const tmpAudio = outPath.replace(/\.\w+$/, '.full.m4a');

  // 2026 YouTube extraction needs a JS runtime + multi-client fallback.
  // We use spawnSync with an argument array (no shell) so semicolons in
  // extractor-args don't get parsed as shell separators.
  const nodePath = execSync('command -v node').toString().trim();

  const args = [
    '--js-runtimes', `node:${nodePath}`,
    '--extractor-args', 'youtube:player_client=web,android,ios;use_pot=true',
    '--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
    '--no-playlist',
    '-o', tmpAudio,
    youtubeUrl,
  ];
  log.info(`Running yt-dlp with ${args.length} args...`);
  const r = spawnSync('yt-dlp', args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`yt-dlp exited with code ${r.status}`);
  return tmpAudio;
}

async function downloadDirectAudio(url, outPath) {
  log.info(`Downloading audio file from ${url}...`);
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000 });
  fs.writeFileSync(outPath, Buffer.from(resp.data));
  return outPath;
}

function extractClip(srcPath, startSec, durationSec, outPath) {
  log.info(`Extracting ${durationSec}s clip starting at ${startSec}s → ${outPath}`);
  // Trim, downmix to mono, export as 22050 Hz MP3 (Chatterbox-friendly).
  // Skip loudnorm — iPhone recording is already at decent loudness AND loudnorm's
  // 2-pass analysis can stall on a 1GB RAM VM. Use simple peak-norm via volume filter.
  const r = spawnSync('ffmpeg', [
    '-y',
    '-ss', String(startSec),
    '-i', srcPath,
    '-t', String(durationSec),
    '-ac', '1',
    '-ar', '22050',
    '-af', 'dynaudnorm=p=0.71:g=15',   // single-pass normalization, fast
    '-b:a', '128k',
    outPath,
  ], { stdio: 'inherit', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`ffmpeg extraction failed (status=${r.status})`);
}

async function uploadAudio(localPath, persona, label) {
  const db = dbModule.getClient();
  const buf = fs.readFileSync(localPath);
  const storagePath = `voice-refs/${persona.slug}/${label}-${Date.now()}.mp3`;
  const { error } = await db.storage
    .from('avi-images')                  // reuse existing bucket
    .upload(storagePath, buf, {
      contentType: 'audio/mpeg',
      upsert: true,
      cacheControl: '31536000',
    });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  const { data: pub } = db.storage.from('avi-images').getPublicUrl(storagePath);
  return { publicUrl: pub.publicUrl, storagePath, sizeBytes: buf.length };
}

async function generateTestSample(refUrl) {
  const TEST_TEXT = "Okay but actually, this AI tool is honestly unhinged. I've been testing it all week — yaar, this is the future. Comment LINK if you want me to break it down.";
  log.info(`Generating test sample with Chatterbox...`);
  const result = await runModel('chatterbox', {
    prompt: TEST_TEXT,
    audio_prompt: refUrl,
    cfg_weight: 0.5,
    temperature: 0.8,
    exaggeration: 0.5,
  }, { timeoutMs: 180_000 });
  return { audioUrl: result.output[0], cost: result.cost_usd, text: TEST_TEXT };
}

async function processReference(ref) {
  const persona = await personaService.getActivePersona('avi');
  const db = dbModule.getClient();

  ensureTools();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avi-voice-'));
  const clipPath = path.join(tmpDir, `${ref.label}.mp3`);

  let sourceAudioPath;
  if (ref.local_file) {
    if (!fs.existsSync(ref.local_file)) {
      throw new Error(`Local file not found: ${ref.local_file}`);
    }
    sourceAudioPath = ref.local_file;
    log.info(`Using local file: ${sourceAudioPath}`);
  } else if (ref.audio_url) {
    sourceAudioPath = path.join(tmpDir, 'source.bin');
    await downloadDirectAudio(ref.audio_url, sourceAudioPath);
  } else if (ref.url) {
    sourceAudioPath = await downloadYouTubeClip(ref.url, clipPath);
  } else {
    throw new Error('Reference needs either local_file, audio_url, or url');
  }

  // Extract the trimmed/normalized clip
  extractClip(sourceAudioPath, ref.start_sec, ref.duration_sec, clipPath);

  // Upload reference clip
  const uploaded = await uploadAudio(clipPath, persona, ref.label);
  log.info(`✓ Reference uploaded: ${uploaded.publicUrl}`);

  // Generate a test sample
  let test = { audioUrl: null, cost: 0, text: null };
  try {
    test = await generateTestSample(uploaded.publicUrl);
    log.info(`✓ Test sample: ${test.audioUrl}`);
  } catch (err) {
    log.warn(`Test sample failed (continuing): ${err.message}`);
  }

  // Insert row
  const ins = await db.from('persona_voice_refs').insert({
    persona_id: persona.id,
    source_label: ref.label,
    source_url: ref.source_url || ref.url || ref.audio_url,
    audio_url: uploaded.publicUrl,
    storage_path: uploaded.storagePath,
    duration_sec: ref.duration_sec,
    test_sample_url: test.audioUrl,
    test_sample_text: test.text,
    notes: ref.notes || '',
    is_active: false,
  }).select('id').single();
  if (ins.error) throw new Error(`DB insert failed: ${ins.error.message}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { id: ins.data.id, refUrl: uploaded.publicUrl, testUrl: test.audioUrl };
}

async function main() {
  const args = parseArgs(process.argv);

  let refs;
  if (args.url || args.audioUrl || args.localFile) {
    refs = [{
      label: args.label || `custom-${Date.now()}`,
      url: args.url,
      audio_url: args.audioUrl,
      local_file: args.localFile,
      source_url: args.url || args.audioUrl || `local:${args.localFile || ''}`,
      start_sec: args.start,
      duration_sec: args.duration,
      notes: args.notes,
    }];
  } else {
    refs = DEFAULT_REFERENCES;
  }

  const created = [];
  for (const ref of refs) {
    log.info(`──────────────────────────────────────────`);
    log.info(`Processing reference: ${ref.label}`);
    try {
      const r = await processReference(ref);
      created.push({ label: ref.label, ...r });
    } catch (err) {
      log.error(`Reference ${ref.label} failed: ${err.message}`);
    }
  }

  log.info(`──────────────────────────────────────────`);
  log.info(`✓ Created ${created.length} voice reference(s).`);
  for (const c of created) {
    log.info(`  ${c.label}  (id=${c.id.slice(0, 8)})`);
    log.info(`    reference clip: ${c.refUrl}`);
    if (c.testUrl) log.info(`    test sample   : ${c.testUrl}`);
  }
  log.info(``);
  log.info(`Listen to test samples and pick a winner. Then activate with:`);
  log.info(`  node avatar/voice/activate_voice.js <id_prefix>`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
