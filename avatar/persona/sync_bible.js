#!/usr/bin/env node
/**
 * Nightly cron - syncs RHEA_BIBLE.md to personas.bible_md.
 * Lets the user edit the markdown file freely; DB is always fresh by next morning.
 */

const fs = require('fs');
const path = require('path');
const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('sync_bible');
const BIBLE_PATH = path.join(__dirname, 'RHEA_BIBLE.md');

(async () => {
  if (!fs.existsSync(BIBLE_PATH)) {
    log.error(`Bible not found: ${BIBLE_PATH}`);
    process.exit(1);
  }
  const bible = fs.readFileSync(BIBLE_PATH, 'utf8');
  const db = dbModule.getClient();
  
  // Sync to all active personas (in case user runs multiple)
  const { data: personas } = await db.from('personas').select('id, slug, bible_md').eq('is_active', true);
  let updated = 0;
  for (const p of (personas || [])) {
    if (p.bible_md !== bible) {
      await db.from('personas').update({ bible_md: bible }).eq('id', p.id);
      updated++;
      log.info(`Updated bible for persona ${p.slug}`);
    }
  }
  log.info(`Sync complete. ${updated} persona(s) updated.`);
})().catch(err => { console.error(err); process.exit(1); });
