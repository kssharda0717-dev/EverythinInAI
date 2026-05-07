#!/usr/bin/env node
/**
 * EverythinInAI — Resume an in-flight LoRA training
 *
 * Picks up the most recent persona_loras row that is still in 'training' or
 * 'pending' state, polls the corresponding Replicate training, then activates
 * the LoRA when it succeeds.
 *
 * Use this if the original train_lora.js process died (SSH disconnect, etc.)
 * but the Replicate training is still running on their servers.
 *
 * Usage:
 *   node avatar/imagery/resume_lora.js                       # resume latest
 *   node avatar/imagery/resume_lora.js <training_id>          # resume specific
 */

const axios = require('axios');
const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');
const { BASE, authHeaders } = require('./replicate_client');

const log = createLogger('resume_lora');

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
    await new Promise(r => setTimeout(r, 15_000));
  }
}

async function main() {
  const persona = await personaService.getActivePersona('avi');
  const db = dbModule.getClient();
  const explicitId = process.argv[2];

  let loraRow;
  let trainingId;

  if (explicitId) {
    trainingId = explicitId;
    const { data } = await db.from('persona_loras')
      .select('*')
      .eq('training_id', trainingId)
      .maybeSingle();
    loraRow = data;
  } else {
    // Find the most recent row for this persona that hasn't been activated yet,
    // regardless of training_status (covers cases where status was stale).
    const { data } = await db.from('persona_loras')
      .select('*')
      .eq('persona_id', persona.id)
      .eq('is_active', false)
      .not('training_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1);
    if (!data || data.length === 0) {
      log.error('No un-activated LoRA training found. Run train_lora.js to start a new one.');
      process.exit(1);
    }
    loraRow = data[0];
    trainingId = loraRow.training_id;
  }

  log.info(`Found lora row ${loraRow.id} with training ${trainingId} (current status=${loraRow.training_status})`);

  if (!trainingId) {
    log.error(`Lora row ${loraRow?.id} has no training_id. Cannot resume.`);
    process.exit(1);
  }

  log.info(`Resuming training ${trainingId} (lora row ${loraRow.id})...`);
  const finalT = await pollTraining(trainingId);

  if (finalT.status !== 'succeeded') {
    await db.from('persona_loras').update({
      training_status: finalT.status,
      error_message: String(finalT.error || '').substring(0, 1000),
      updated_at: new Date().toISOString(),
    }).eq('id', loraRow.id);
    log.error(`Training ${finalT.status}: ${finalT.error}`);
    process.exit(1);
  }

  // Capture weights URL
  let weightsUrl = finalT.output;
  if (typeof weightsUrl === 'object' && weightsUrl !== null) {
    weightsUrl = weightsUrl.weights || weightsUrl.url || (Array.isArray(weightsUrl) ? weightsUrl[0] : null);
  }
  // Also note the destination model page
  const destModel = finalT.input?.destination || `kssharda0717-dev/avi-lora`;

  log.info(`✓ Training succeeded.`);
  log.info(`   weights URL : ${weightsUrl}`);
  log.info(`   model id    : ${destModel}`);

  // Deactivate any existing active LoRAs
  await db.from('persona_loras')
    .update({ is_active: false })
    .eq('persona_id', persona.id)
    .eq('is_active', true);

  await db.from('persona_loras').update({
    weights_url: typeof weightsUrl === 'string' ? weightsUrl : null,
    storage_path: destModel,
    training_status: 'succeeded',
    cost_usd: 3.0,
    is_active: true,
    activated_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', loraRow.id);

  await db.from('personas').update({
    active_lora_url: typeof weightsUrl === 'string' ? weightsUrl : null,
    active_lora_trigger: loraRow.trigger_word || 'AVI_TOK',
    updated_at: new Date().toISOString(),
  }).eq('id', persona.id);
  personaService.clearCache();

  log.info(`══════════════════════════════════════════════`);
  log.info(`✓ LoRA activated for ${persona.display_name}.`);
  log.info(`   Trigger word: "${loraRow.trigger_word || 'AVI_TOK'}"`);
  log.info(`══════════════════════════════════════════════`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
