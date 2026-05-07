#!/usr/bin/env node
/**
 * EverythinInAI — Choose Face Anchor
 *
 * Marks one face_anchor as the chosen identity for a persona.
 * Also updates personas.canonical_face_url so downstream services
 * (image worker, video assembly) read it from one place.
 *
 * Usage:
 *   node avatar/imagery/choose_face_anchor.js <face_anchor_id>
 *   node avatar/imagery/choose_face_anchor.js <id_prefix>      (first 8 chars also work)
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');

const log = createLogger('choose_anchor');

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node choose_face_anchor.js <face_anchor_id>');
    process.exit(1);
  }

  const db = dbModule.getClient();

  // Resolve the row (full UUID or 8-char prefix)
  let target;
  if (arg.length >= 36) {
    const { data } = await db.from('face_anchors').select('*').eq('id', arg).maybeSingle();
    target = data;
  } else {
    // Postgres can't LIKE-match a UUID column directly — fetch recent rows and match in JS.
    const { data } = await db.from('face_anchors').select('*').order('created_at', { ascending: false }).limit(50);
    const matches = (data || []).filter(r => r.id.startsWith(arg.toLowerCase()));
    if (matches.length === 0) target = null;
    else if (matches.length > 1) {
      log.error(`Ambiguous prefix "${arg}" matches ${matches.length} rows. Use full UUID.`);
      process.exit(1);
    } else target = matches[0];
  }

  if (!target) {
    log.error(`No face_anchor found matching "${arg}"`);
    process.exit(1);
  }

  log.info(`Choosing face anchor ${target.id}`);
  log.info(`  URL: ${target.image_url}`);

  // Unset existing chosen for this persona
  await db.from('face_anchors')
    .update({ is_chosen: false, chosen_at: null, chosen_by: null })
    .eq('persona_id', target.persona_id)
    .eq('is_chosen', true);

  // Mark chosen
  const { error: chooseErr } = await db.from('face_anchors')
    .update({
      is_chosen: true,
      chosen_at: new Date().toISOString(),
      chosen_by: process.env.USER || 'kartik',
    })
    .eq('id', target.id);
  if (chooseErr) throw new Error(`Mark chosen failed: ${chooseErr.message}`);

  // Update persona row
  const { error: pErr } = await db.from('personas')
    .update({
      canonical_face_url: target.image_url,
      face_seed_id: target.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', target.persona_id);
  if (pErr) throw new Error(`Persona update failed: ${pErr.message}`);

  // Bust persona service cache
  personaService.clearCache();

  log.info(`✓ Anchor chosen and persona.canonical_face_url updated.`);
  log.info(`  Avi's face is now LOCKED to: ${target.image_url}`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
