#!/usr/bin/env node
/**
 * EverythinInAI — Train Avi's LoRA
 *
 * Workflow:
 *   1. Fetch all training-set portraits for the active persona
 *   2. Download each image, zip them locally
 *   3. Upload the zip to Supabase Storage (so Replicate can fetch it)
 *   4. Submit a training job to ostris/flux-dev-lora-trainer
 *   5. Poll until completion (~25 min)
 *   6. Save the resulting .safetensors URL to persona_loras
 *   7. Mark it active and update personas.active_lora_url
 *
 * Cost: ~$2-3 (one-time)
 * Time: ~25 min
 *
 * Usage:
 *   node avatar/imagery/train_lora.js
 *   node avatar/imagery/train_lora.js --steps=1500       # more steps = better but $$$
 *   node avatar/imagery/train_lora.js --rank=32          # higher rank = more capacity
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const archiver = require('archiver');
const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');
const { TRAINER, BASE, authHeaders } = require('./replicate_client');

const log = createLogger('train_lora');

const TRIGGER_WORD = 'AVI_TOK';

function parseArgs(argv) {
  const args = { steps: 1000, rank: 16 };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--steps=')) args.steps = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--rank=')) args.rank = parseInt(a.split('=')[1], 10);
  }
  return args;
}

async function downloadImage(url, destPath) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60_000 });
  fs.writeFileSync(destPath, Buffer.from(resp.data));
}

async function zipImages(imageUrls, zipPath) {
  return new Promise(async (resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avi-train-'));
    log.info(`Downloading ${imageUrls.length} images to ${tmpDir}...`);

    const localPaths = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const local = path.join(tmpDir, `${String(i).padStart(3, '0')}.webp`);
      try {
        await downloadImage(imageUrls[i], local);
        localPaths.push(local);
      } catch (err) {
        log.warn(`Skipping image ${i}: ${err.message}`);
      }
    }

    log.info(`Zipping ${localPaths.length} images to ${zipPath}...`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve({ zipPath, count: localPaths.length, sizeBytes: archive.pointer() });
    });
    archive.on('error', reject);
    archive.pipe(output);
    for (const p of localPaths) {
      archive.file(p, { name: path.basename(p) });
    }
    await archive.finalize();
  });
}

async function uploadZipToStorage(zipPath, persona) {
  const db = dbModule.getClient();
  const buf = fs.readFileSync(zipPath);
  const storagePath = `training-sets/${persona.slug}/${Date.now()}.zip`;
  const { error } = await db.storage
    .from('avi-images')
    .upload(storagePath, buf, {
      contentType: 'application/zip',
      upsert: true,
      cacheControl: '3600',
    });
  if (error) throw new Error(`Zip upload failed: ${error.message}`);
  const { data: pub } = db.storage.from('avi-images').getPublicUrl(storagePath);
  return { publicUrl: pub.publicUrl, storagePath, sizeBytes: buf.length };
}

async function submitTraining(zipUrl, args, destination) {
  // Trainings use a different endpoint: /v1/models/{owner}/{name}/versions/{version}/trainings
  const [owner, name] = TRAINER.id.split('/');
  const url = `${BASE}/models/${owner}/${name}/versions/${TRAINER.version}/trainings`;

  const body = {
    destination,                  // 'kssharda0717-dev/avi-lora' — must exist on Replicate
    input: {
      input_images: zipUrl,
      trigger_word: TRIGGER_WORD,
      steps: args.steps,
      lora_rank: args.rank,
      learning_rate: 0.0004,
      batch_size: 1,
      resolution: '512,768,1024',
      autocaption: true,
      autocaption_prefix: 'a photograph of AVI_TOK woman, ',
      caption_dropout_rate: 0.05,
      optimizer: 'adamw8bit',
      cache_latents_to_disk: false,
      gradient_checkpointing: false,
    },
  };

  const resp = await axios.post(url, body, { headers: authHeaders(), timeout: 30_000 });
  return resp.data;
}

async function pollTraining(trainingId) {
  const url = `${BASE}/trainings/${trainingId}`;
  const startMs = Date.now();
  let last = null;
  while (true) {
    const r = await axios.get(url, { headers: authHeaders(), timeout: 30_000 });
    const t = r.data;
    if (t.status !== last) {
      log.info(`Training ${trainingId} → ${t.status}  (${Math.round((Date.now() - startMs) / 1000)}s elapsed)`);
      last = t.status;
    }
    if (['succeeded', 'failed', 'canceled'].includes(t.status)) return t;
    await new Promise(r => setTimeout(r, 15_000));   // poll every 15s
  }
}

async function ensureDestinationModel(destination) {
  // Check if the model exists; create it if not. Trainings need a destination
  // (a model owned by the user that will hold the trained weights).
  const [owner, name] = destination.split('/');
  try {
    await axios.get(`${BASE}/models/${owner}/${name}`, { headers: authHeaders(), timeout: 15_000 });
    log.info(`Destination model ${destination} exists.`);
    return;
  } catch (err) {
    if (err.response?.status !== 404) throw err;
  }
  log.info(`Creating destination model ${destination}...`);
  await axios.post(`${BASE}/models`, {
    owner,
    name,
    description: 'Avi persona LoRA — EverythinInAI',
    visibility: 'private',
    hardware: 'gpu-h100',
  }, { headers: authHeaders(), timeout: 30_000 });
  log.info(`✓ Created ${destination}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const persona = await personaService.getActivePersona();
  const db = dbModule.getClient();

  // 1. Fetch training images
  const { data: trainingRows, error } = await db
    .from('face_anchors')
    .select('image_url, prompt')
    .eq('persona_id', persona.id)
    .eq('notes', 'training_set');
  if (error) throw error;
  if (!trainingRows || trainingRows.length < 8) {
    throw new Error(`Need at least 8 training images, found ${trainingRows?.length || 0}. Run generate_training_set.js first.`);
  }
  log.info(`Found ${trainingRows.length} training images for ${persona.slug}.`);

  // 2. Download + zip
  const tmpZip = path.join(os.tmpdir(), `avi-train-${Date.now()}.zip`);
  const zipMeta = await zipImages(trainingRows.map(r => r.image_url), tmpZip);
  log.info(`✓ Zip ready: ${zipMeta.sizeBytes} bytes, ${zipMeta.count} images`);

  // 3. Upload zip to public storage
  const uploaded = await uploadZipToStorage(tmpZip, persona);
  log.info(`✓ Zip uploaded: ${uploaded.publicUrl}`);
  fs.unlinkSync(tmpZip);

  // 4. Determine destination (Replicate user's model)
  // Get the username from /v1/account
  const acct = await axios.get(`${BASE}/account`, { headers: authHeaders() });
  const username = acct.data.username;
  const destinationModel = `${username}/avi-lora`;
  await ensureDestinationModel(destinationModel);

  // 5. Insert pending lora row
  const { data: loraRow, error: insErr } = await db.from('persona_loras').insert({
    persona_id: persona.id,
    trigger_word: TRIGGER_WORD,
    training_status: 'pending',
    training_steps: args.steps,
    lora_rank: args.rank,
    learning_rate: 0.0004,
    training_zip_url: uploaded.publicUrl,
    training_image_count: zipMeta.count,
    is_active: false,
  }).select('id').single();
  if (insErr) throw insErr;
  log.info(`Pending lora row: ${loraRow.id}`);

  // 6. Submit training
  log.info(`Submitting training to ${TRAINER.id} (steps=${args.steps}, rank=${args.rank})...`);
  const training = await submitTraining(uploaded.publicUrl, args, destinationModel);
  log.info(`Training submitted: ${training.id}  (urls=${training.urls?.get})`);

  await db.from('persona_loras').update({
    training_id: training.id,
    training_status: 'training',
    updated_at: new Date().toISOString(),
  }).eq('id', loraRow.id);

  // 7. Poll
  log.info(`Polling training ${training.id}...  (this takes ~25 min)`);
  const finalT = await pollTraining(training.id);

  if (finalT.status !== 'succeeded') {
    await db.from('persona_loras').update({
      training_status: finalT.status,
      error_message: String(finalT.error || '').substring(0, 1000),
      updated_at: new Date().toISOString(),
    }).eq('id', loraRow.id);
    throw new Error(`Training ${finalT.status}: ${finalT.error}`);
  }

  // 8. Capture result
  // Output is typically a URL to the .safetensors file (sometimes wrapped in array)
  let weightsUrl = finalT.output;
  if (typeof weightsUrl === 'object' && weightsUrl !== null) {
    weightsUrl = weightsUrl.weights || weightsUrl.url || (Array.isArray(weightsUrl) ? weightsUrl[0] : null);
  }
  // The destination version page is also a viable inference target:
  const versionUrl = `https://replicate.com/${destinationModel}`;

  log.info(`✓ Training succeeded.`);
  log.info(`   weights URL: ${weightsUrl}`);
  log.info(`   model page : ${versionUrl}`);

  // 9. Save + activate
  // Deactivate existing active LoRAs
  await db.from('persona_loras')
    .update({ is_active: false })
    .eq('persona_id', persona.id)
    .eq('is_active', true);

  await db.from('persona_loras').update({
    weights_url: typeof weightsUrl === 'string' ? weightsUrl : null,
    storage_path: destinationModel,            // re-use field as model identifier
    training_status: 'succeeded',
    cost_usd: 3.0,                              // approximate
    is_active: true,
    activated_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', loraRow.id);

  // Update persona quick-lookup fields
  await db.from('personas').update({
    active_lora_url: typeof weightsUrl === 'string' ? weightsUrl : null,
    active_lora_trigger: TRIGGER_WORD,
    updated_at: new Date().toISOString(),
  }).eq('id', persona.id);
  personaService.clearCache();

  log.info(`══════════════════════════════════════════════`);
  log.info(`✓ LoRA training complete and activated.`);
  log.info(`   Trigger word: "${TRIGGER_WORD}"`);
  log.info(`   Use with black-forest-labs/flux-dev-lora`);
  log.info(`   Persona row updated.`);
  log.info(`══════════════════════════════════════════════`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
