#!/usr/bin/env node
/**
 * URL Validator Cron
 * 
 * Pings every active tool URL once per month. If 4xx/5xx/timeout, marks
 * the tool inactive so dead links don't show up on the website.
 * 
 * Strategy: process tools that haven't been checked in 30 days, batch of 200/run.
 */

const dbModule = require('../core/database');
const { createLogger } = require('../utils/logger');
const axios = require('axios');

const log = createLogger('url_validator');

const BATCH_SIZE = 200;
const RECHECK_AFTER_DAYS = 30;
const TIMEOUT_MS = 10_000;

async function checkUrl(url) {
  try {
    const resp = await axios.head(url, {
      timeout: TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    return { status: resp.status, error: null };
  } catch (err) {
    // Some servers don't allow HEAD. Try GET.
    if (err.code === 'ECONNABORTED' || err.response?.status === 405) {
      try {
        const resp = await axios.get(url, { timeout: TIMEOUT_MS, maxRedirects: 5, validateStatus: () => true });
        return { status: resp.status, error: null };
      } catch (e2) {
        return { status: 0, error: e2.code || e2.message?.slice(0, 100) };
      }
    }
    return { status: 0, error: err.code || err.message?.slice(0, 100) };
  }
}

async function main() {
  const db = dbModule.getClient();
  const cutoff = new Date(Date.now() - RECHECK_AFTER_DAYS * 24 * 3600_000).toISOString();

  log.info(`Fetching up to ${BATCH_SIZE} tools to validate (last_url_check_at NULL or <${cutoff})...`);
  const { data: tools, error } = await db.from('tools')
    .select('id, name, url, last_url_check_at')
    .eq('is_active', true)
    .or(`last_url_check_at.is.null,last_url_check_at.lt.${cutoff}`)
    .limit(BATCH_SIZE);

  if (error) { log.error(`Query failed: ${error.message}`); process.exit(1); }
  if (!tools || tools.length === 0) { log.info('Nothing to validate.'); return; }

  log.info(`Validating ${tools.length} URLs...`);
  let okCount = 0, deadCount = 0;

  for (const t of tools) {
    if (!t.url) continue;
    const { status, error: chkErr } = await checkUrl(t.url);
    const isAlive = status >= 200 && status < 400;

    const update = {
      last_url_check_at: new Date().toISOString(),
      url_status_code: status,
      url_check_error: chkErr,
    };
    // Mark inactive if confirmed dead (4xx/5xx)
    if (!isAlive && (status >= 400 || chkErr)) {
      update.is_active = false;
      deadCount++;
      log.warn(`DEAD: ${t.name} (${status} ${chkErr || ''}) - ${t.url}`);
    } else {
      okCount++;
    }

    await db.from('tools').update(update).eq('id', t.id);
  }

  log.info(`Done. Alive: ${okCount}, Marked dead: ${deadCount}`);
}

main().catch(err => { log.error(`Fatal: ${err.message}`); process.exit(1); });
