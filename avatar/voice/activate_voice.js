#!/usr/bin/env node
/**
 * EverythinInAI — Activate a Voice Reference
 *
 * Marks a persona_voice_refs row as the active voice for the persona.
 * Updates personas.active_voice_ref_url for fast lookup by voice_worker.
 *
 * Usage:
 *   node avatar/voice/activate_voice.js <voice_ref_id_or_prefix>
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');

const log = createLogger('activate_voice');

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node activate_voice.js <voice_ref_id_or_prefix>');
    process.exit(1);
  }

  const persona = await personaService.getActivePersona();
  const db = dbModule.getClient();

  let target;
  if (arg.length >= 36) {
    const { data } = await db.from('persona_voice_refs').select('*').eq('id', arg).maybeSingle();
    target = data;
  } else {
    const { data } = await db.from('persona_voice_refs')
      .select('*')
      .eq('persona_id', persona.id)
      .order('created_at', { ascending: false })
      .limit(50);
    const matches = (data || []).filter(r => r.id.startsWith(arg.toLowerCase()));
    if (matches.length === 0) target = null;
    else if (matches.length > 1) {
      log.error(`Ambiguous prefix "${arg}" matches ${matches.length} rows.`);
      process.exit(1);
    } else target = matches[0];
  }

  if (!target) {
    log.error(`No persona_voice_refs row found matching "${arg}"`);
    process.exit(1);
  }

  log.info(`Activating voice ref ${target.id}`);
  log.info(`  source: ${target.source_label}`);
  log.info(`  audio : ${target.audio_url}`);

  // Deactivate existing
  await db.from('persona_voice_refs')
    .update({ is_active: false, activated_at: null })
    .eq('persona_id', target.persona_id)
    .eq('is_active', true);

  // Activate this one
  await db.from('persona_voice_refs').update({
    is_active: true,
    activated_at: new Date().toISOString(),
  }).eq('id', target.id);

  // Update persona quick-lookup
  await db.from('personas').update({
    active_voice_ref_url: target.audio_url,
    active_voice_settings: target.settings || {},
    voice_id: target.id,
    updated_at: new Date().toISOString(),
  }).eq('id', target.persona_id);
  personaService.clearCache();

  log.info(`✓ Voice activated for ${persona.display_name}.`);
  log.info(`  Avi will now speak in this voice.`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
