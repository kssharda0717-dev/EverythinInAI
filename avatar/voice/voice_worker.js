#!/usr/bin/env node
/**
 * EverythinInAI — Voice Worker
 *
 * Reads a Reel concept's full_script, sends to Chatterbox with Avi's active
 * voice reference, downloads the MP3, hosts it on Supabase Storage, and
 * updates the concept row.
 *
 * Usage:
 *   node avatar/voice/voice_worker.js <concept_id>
 *   node avatar/voice/voice_worker.js --winner
 *   node avatar/voice/voice_worker.js --winner --date=2026-05-07
 *   node avatar/voice/voice_worker.js <concept_id> --dry-run
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');
const { runModel } = require('../imagery/replicate_client');
const { rehostImage } = require('../imagery/storage');

const log = createLogger('voice_worker');

function parseArgs(argv) {
  const args = { conceptId: null, useWinner: false, date: null, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--winner') args.useWinner = true;
    else if (a === '--dry-run') args.dryRun = true;
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

// Pronunciation overrides for Chatterbox TTS (no SSML support).
// Format: { /word_or_pattern/gi: 'phonetic spelling that TTS reads correctly' }
// Keys are RegExp; values are the replacement string. Word boundaries (\b) recommended.
const PRONUNCIATION_OVERRIDES = [
  // Persona name: Chatterbox reads "RHEA" as "rar-ich-ya"; "Ria" reads as "ree-ah" ✓
  [/\bRHEA\b/g,        'Ria'],
  [/\bRhea\b/g,        'Ria'],
  [/\brhea\b/g,        'Ria'],
  // Common AI brand pronunciations the TTS gets wrong
  [/\bGPT\b/g,         'G P T'],
  [/\bLLM\b/g,         'L L M'],
  [/\bLLMs\b/g,        'L L Ms'],
  [/\bRAG\b/g,         'rag'],
  [/\bLightRAG\b/g,    'Light-rag'],
  [/\bAGI\b/g,         'A G I'],
  [/\bAPI\b/g,         'A P I'],
  [/\bAPIs\b/g,        'A P Is'],
  [/\bSDK\b/g,         'S D K'],
  [/\bGUI\b/g,         'gooey'],
  [/\bCLI\b/g,         'C L I'],
  [/\bSaaS\b/g,        'sass'],
  [/\bUI\b/g,          'U I'],
  [/\bUX\b/g,          'U X'],
  [/\bHKUDS\b/g,       'H K U D S'],
  // Brand names
  [/\bHuggingFace\b/g, 'Hugging Face'],
  [/\bArXiv\b/g,       'archive'],
  [/\barxiv\b/g,       'archive'],
  [/\bGemini\b/g,      'Geminee'],
];

function preprocessScript(text) {
  // Light cleanup: collapse whitespace, ensure trailing period.
  let out = (text || '').replace(/\s+/g, ' ').trim();
  if (!/[.!?…]$/.test(out)) out += '.';
  // Apply pronunciation overrides
  for (const [pattern, replacement] of PRONUNCIATION_OVERRIDES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

async function rehostAudio(sourceUrl, destPath) {
  const dbModule2 = require('../../engine/core/database');
  const axios = require('axios');
  const db = dbModule2.getClient();

  const resp = await axios.get(sourceUrl, { responseType: 'arraybuffer', timeout: 120_000 });
  const buf = Buffer.from(resp.data);

  const { error } = await db.storage
    .from('avi-images')
    .upload(destPath, buf, {
      contentType: 'audio/wav',                // chatterbox returns wav typically
      upsert: true,
      cacheControl: '31536000',
    });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  const { data: pub } = db.storage.from('avi-images').getPublicUrl(destPath);
  return { publicUrl: pub.publicUrl, storagePath: destPath, sizeBytes: buf.length };
}

async function main() {
  const args = parseArgs(process.argv);
  const db = dbModule.getClient();
  const persona = await personaService.getActivePersona('avi');

  if (!persona.active_voice_ref_url) {
    log.error('Persona has no active_voice_ref_url. Run setup_voice_reference.js + activate_voice.js first.');
    process.exit(1);
  }

  const concept = await getConcept(db, args);
  if (!concept) {
    log.error('No concept found. Use --winner or pass a concept_id.');
    process.exit(1);
  }
  log.info(`Concept: ${concept.title} (${concept.id})`);

  const script = preprocessScript(concept.full_script);
  log.info(`Script (${script.length} chars):  ${script.substring(0, 200)}...`);

  if (args.dryRun) {
    log.info(`DRY RUN — would call chatterbox with audio_prompt=${persona.active_voice_ref_url}`);
    return;
  }

  // Update concept state
  await db.from('reel_concepts').update({
    state: 'voicing',
    updated_at: new Date().toISOString(),
  }).eq('id', concept.id);

  const settings = persona.active_voice_settings || {};
  log.info(`Generating audio with Chatterbox...`);
  const result = await runModel('chatterbox', {
    prompt: script,
    audio_prompt: persona.active_voice_ref_url,
    cfg_weight: settings.cfg_weight ?? 0.5,
    temperature: settings.temperature ?? 0.8,
    exaggeration: settings.exaggeration ?? 0.5,
    seed: 0,
  }, { timeoutMs: 300_000 });

  const remoteUrl = Array.isArray(result.output) ? result.output[0] : result.output;
  const destPath = `voice-tracks/${concept.id}/${Date.now()}.wav`;
  const hosted = await rehostAudio(remoteUrl, destPath);

  // Estimate duration assuming 16 kHz mono PCM ≈ buf.length / 32000 sec.
  // We don't have ffprobe, but we can compute roughly from content-length.
  const estDuration = Math.round(hosted.sizeBytes / 16000);   // very rough

  await db.from('reel_concepts').update({
    voice_url: hosted.publicUrl,
    voice_storage_path: hosted.storagePath,
    voice_duration_sec: estDuration,
    voice_cost_usd: result.cost_usd,
    voice_model: 'chatterbox',
    state: 'assembling',                 // hand off to video assembly
    updated_at: new Date().toISOString(),
  }).eq('id', concept.id);

  log.info(`══════════════════════════════════════════════`);
  log.info(`✓ Voice generation complete.`);
  log.info(`   audio    : ${hosted.publicUrl}`);
  log.info(`   est dur  : ~${estDuration}s`);
  log.info(`   cost     : ~$${result.cost_usd}`);
  log.info(`   gen time : ${(result.generation_ms / 1000).toFixed(1)}s`);
  log.info(`══════════════════════════════════════════════`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
