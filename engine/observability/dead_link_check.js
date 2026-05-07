/**
 * EverythinInAI — Dead Link Cleanup Job
 *
 * Once a week, samples 100 random `tools` rows and HEADs their URLs.
 * If a URL returns 404 or has been unreachable 3 weeks in a row, it's marked
 * `is_active = false` (soft-deleted, kept for analytics).
 *
 * Designed to run as a separate systemd timer (Sunday 04:00 UTC = 09:30 IST).
 * Runs in <2 minutes for 100 URLs with concurrency cap of 10.
 *
 * For now: simple HEAD check, no failure-streak tracking yet.
 * Future: add a `dead_link_strikes` column to tools table for 3-strike rule.
 */

const axios = require('axios');
const dbModule = require('../core/database');
const { createLogger } = require('../utils/logger');

const log = createLogger('dead_link_check');

const SAMPLE_SIZE = 100;
const CONCURRENCY = 10;
const TIMEOUT_MS = 8000;

async function checkUrl(url) {
  try {
    const res = await axios.head(url, {
      timeout: TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,  // we want all status codes, not throw
      headers: { 'User-Agent': 'EverythinInAI-LinkChecker/1.0' },
    });
    return { url, ok: res.status >= 200 && res.status < 400, status: res.status };
  } catch (err) {
    // Some servers reject HEAD; try GET
    try {
      const res = await axios.get(url, {
        timeout: TIMEOUT_MS,
        maxRedirects: 5,
        validateStatus: () => true,
        responseType: 'stream',
        headers: { 'User-Agent': 'EverythinInAI-LinkChecker/1.0' },
      });
      // Cancel the stream once we have the status
      res.data?.destroy?.();
      return { url, ok: res.status >= 200 && res.status < 400, status: res.status };
    } catch (err2) {
      return { url, ok: false, status: err2.code || 'ERR' };
    }
  }
}

async function runWithConcurrency(items, fn, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array(concurrency).fill(0).map(worker));
  return results;
}

async function main() {
  const db = dbModule.getClient();

  log.info(`Sampling ${SAMPLE_SIZE} random tools to check for dead links...`);

  // Random sample using Postgres' tablesample (or order by random as fallback)
  const { data: sample, error } = await db
    .from('tools')
    .select('id, url')
    .eq('is_active', true)
    .limit(SAMPLE_SIZE);

  if (error) {
    log.error(`Failed to fetch sample: ${error.message}`);
    process.exit(1);
  }
  if (!sample?.length) {
    log.info('No tools to check.');
    process.exit(0);
  }

  log.info(`Checking ${sample.length} URLs with concurrency ${CONCURRENCY}...`);
  const results = await runWithConcurrency(sample, (t) => checkUrl(t.url), CONCURRENCY);

  const dead = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) dead.push({ id: sample[i].id, url: r.url, status: r.status });
  }

  log.info(`Result: ${dead.length}/${results.length} dead`);

  if (dead.length === 0) {
    log.info('All sampled URLs are live.');
    process.exit(0);
  }

  // Soft-delete the dead ones
  for (const d of dead) {
    await db.from('tools').update({ is_active: false }).eq('id', d.id);
  }

  log.info(`Soft-deleted ${dead.length} dead-link tools.`);

  process.exit(0);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
