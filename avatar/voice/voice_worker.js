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

/**
 * Split a script into chunks of <= maxChars each, breaking at sentence boundaries.
 * Chatterbox has an internal ~200-character / ~16-second hard cap on output audio.
 * Anything beyond that gets silently truncated. Splitting + concatenating WAVs
 * is the only way to get long-form scripts spoken end-to-end.
 */
function splitIntoChunks(text, maxChars = 180) {
  if ((text || '').length <= maxChars) return [text];
  // Split on sentence-ending punctuation, keeping punctuation attached
  const sentences = text.match(/[^.!?…]+[.!?…]+/g) || [text];
  const chunks = [];
  let current = '';
  for (const sent of sentences) {
    const trimmed = sent.trim();
    if (!trimmed) continue;
    if ((current + ' ' + trimmed).trim().length <= maxChars) {
      current = (current + ' ' + trimmed).trim();
    } else {
      if (current) chunks.push(current);
      // If a single sentence exceeds maxChars, force-split on commas as last resort
      if (trimmed.length > maxChars) {
        const subs = trimmed.split(/,\s+/);
        let sub = '';
        for (const s of subs) {
          if ((sub + ', ' + s).trim().length <= maxChars) sub = (sub + ', ' + s).replace(/^,\s*/, '').trim();
          else { if (sub) chunks.push(sub); sub = s; }
        }
        if (sub) chunks.push(sub);
        current = '';
      } else {
        current = trimmed;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Concatenate multiple WAV buffers into one using ffmpeg's concat demuxer.
 * Returns the combined WAV as a Buffer.
 */
async function concatWavBuffers(buffers) {
  if (buffers.length === 1) return buffers[0];
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { spawnSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-concat-'));
  const inputs = [];
  for (let i = 0; i < buffers.length; i++) {
    const p = path.join(tmp, `part_${i}.wav`);
    fs.writeFileSync(p, buffers[i]);
    inputs.push(p);
  }
  const listFile = path.join(tmp, 'list.txt');
  fs.writeFileSync(listFile, inputs.map(p => `file '${p}'`).join('\n'));
  const outPath = path.join(tmp, 'combined.wav');
  const r = spawnSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath], { stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error('ffmpeg concat failed: ' + (r.stderr?.toString().slice(-300) || 'unknown'));
  }
  const combined = fs.readFileSync(outPath);
  // Cleanup
  try { for (const p of inputs) fs.unlinkSync(p); fs.unlinkSync(listFile); fs.unlinkSync(outPath); fs.rmdirSync(tmp); } catch {}
  return combined;
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
  const persona = await personaService.getActivePersona();

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
  const chunks = splitIntoChunks(script, 180);
  log.info(`Generating audio with Chatterbox (${chunks.length} chunk${chunks.length>1?'s':''}, max 180 chars each)...`);
  chunks.forEach((c, i) => log.info(`  chunk ${i+1}/${chunks.length} (${c.length} chars): ${c.slice(0, 80)}${c.length>80?'…':''}`));

  // Generate each chunk (parallel for speed)
  const axios = require('axios');
  const chunkResults = await Promise.all(chunks.map(async (chunkText) => {
    const r = await runModel('chatterbox', {
      prompt: chunkText,
      audio_prompt: persona.active_voice_ref_url,
      cfg_weight: settings.cfg_weight ?? 0.5,
      temperature: settings.temperature ?? 0.8,
      exaggeration: settings.exaggeration ?? 0.5,
      seed: 0,
    }, { timeoutMs: 300_000 });
    const url = Array.isArray(r.output) ? r.output[0] : r.output;
    const dl = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000 });
    return { buf: Buffer.from(dl.data), cost: r.cost_usd };
  }));

  // Stitch the chunks together with ffmpeg
  const combined = await concatWavBuffers(chunkResults.map(r => r.buf));
  const totalCost = chunkResults.reduce((s, r) => s + (r.cost || 0), 0);
  log.info(`✓ Combined ${chunks.length} chunk(s) into ${(combined.length/1024).toFixed(0)} KB WAV (cost: $${totalCost.toFixed(3)})`);

  // Upload the combined WAV directly to Supabase (skip rehostAudio since we already have buffer)
  const dbStorage = dbModule.getClient();
  const destPath = `voice-tracks/${concept.id}/${Date.now()}.wav`;
  const { error: upErr } = await dbStorage.storage.from('avi-images').upload(destPath, combined, {
    contentType: 'audio/wav', upsert: true, cacheControl: '31536000',
  });
  if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
  const { data: pub } = dbStorage.storage.from('avi-images').getPublicUrl(destPath);
  const hosted = { publicUrl: pub.publicUrl, storagePath: destPath, sizeBytes: combined.length };
  // Fake a result object to match downstream code
  const result = { cost_usd: totalCost };

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
