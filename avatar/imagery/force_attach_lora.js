#!/usr/bin/env node
/**
 * EverythinInAI — Force Attach LoRA (recovery utility)
 *
 * Hardcoded recovery for the case where train_lora.js died mid-run and
 * resume_lora.js can't find the row. We:
 *   1. List ALL persona_loras rows for the persona
 *   2. Fetch the training directly from Replicate by ID
 *   3. If succeeded, write the result and activate
 *
 * Usage:
 *   node avatar/imagery/force_attach_lora.js <training_id>
 *   node avatar/imagery/force_attach_lora.js                  # diagnose only
 */

const axios = require('axios');
const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');
const { BASE, authHeaders } = require('./replicate_client');

const log = createLogger('force_attach');

async function main() {
  const trainingId = process.argv[2];
  const persona = await personaService.getActivePersona('avi');
  const db = dbModule.getClient();

  // 1. Diagnose: list all rows
  const { data: allRows } = await db.from('persona_loras')
    .select('id, training_id, training_status, is_active, created_at, weights_url')
    .eq('persona_id', persona.id)
    .order('created_at', { ascending: false });

  log.info(`──── persona_loras rows for ${persona.slug} ────`);
  for (const r of (allRows || [])) {
    log.info(`  id=${r.id.slice(0,8)} training_id=${r.training_id || '(none)'} status=${r.training_status} active=${r.is_active} weights=${r.weights_url ? 'yes' : 'no'}`);
  }
  log.info(`────`);

  if (!trainingId) {
    log.info(`Pass a training_id as argv[2] to force-attach. e.g.:`);
    log.info(`  node avatar/imagery/force_attach_lora.js z7dj1j4wxsrnw0cy0hytr52aa0`);
    return;
  }

  // 2. Fetch the training from Replicate
  log.info(`Fetching training ${trainingId} from Replicate...`);
  const r = await axios.get(`${BASE}/trainings/${trainingId}`, { headers: authHeaders(), timeout: 30_000 });
  const t = r.data;
  log.info(`  status: ${t.status}`);
  if (t.status !== 'succeeded') {
    log.error(`Training is not succeeded yet. Status: ${t.status}. Wait and retry.`);
    process.exit(1);
  }

  const output = t.output || {};
  const weightsUrl = output.weights;
  const versionRef = output.version;
  log.info(`  weights URL: ${weightsUrl}`);
  log.info(`  version ref: ${versionRef}`);

  if (!weightsUrl) {
    log.error('Training succeeded but no weights URL in output. Cannot proceed.');
    process.exit(1);
  }

  // 3. Find or create the persona_loras row
  let row = (allRows || []).find(x => x.training_id === trainingId);

  if (!row) {
    log.info('Creating new persona_loras row...');
    const ins = await db.from('persona_loras').insert({
      persona_id: persona.id,
      trigger_word: 'AVI_TOK',
      training_id: trainingId,
      training_status: 'succeeded',
      training_steps: 1000,
      lora_rank: 16,
      learning_rate: 0.0004,
      cost_usd: 3.0,
      weights_url: weightsUrl,
      storage_path: versionRef || 'kssharda0717-dev/avi-lora',
      is_active: false,
      training_image_count: 20,
      training_zip_url: t.input?.input_images || '',
    }).select('*').single();
    if (ins.error) throw ins.error;
    row = ins.data;
    log.info(`✓ Created row ${row.id}`);
  } else {
    log.info(`Updating existing row ${row.id}...`);
    const upd = await db.from('persona_loras').update({
      training_status: 'succeeded',
      weights_url: weightsUrl,
      storage_path: versionRef || 'kssharda0717-dev/avi-lora',
      cost_usd: 3.0,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', row.id).select('*').single();
    if (upd.error) throw upd.error;
    row = upd.data;
    log.info(`✓ Updated row ${row.id}`);
  }

  // 4. Deactivate other actives + activate this row
  await db.from('persona_loras')
    .update({ is_active: false })
    .eq('persona_id', persona.id)
    .eq('is_active', true)
    .neq('id', row.id);

  await db.from('persona_loras').update({
    is_active: true,
    activated_at: new Date().toISOString(),
  }).eq('id', row.id);

  // 5. Update persona quick-lookup
  await db.from('personas').update({
    active_lora_url: weightsUrl,
    active_lora_trigger: row.trigger_word || 'AVI_TOK',
    updated_at: new Date().toISOString(),
  }).eq('id', persona.id);
  personaService.clearCache();

  log.info(`══════════════════════════════════════════════`);
  log.info(`✓ LoRA force-attached and activated for ${persona.display_name}.`);
  log.info(`   weights URL: ${weightsUrl}`);
  log.info(`   trigger    : ${row.trigger_word || 'AVI_TOK'}`);
  log.info(`══════════════════════════════════════════════`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
