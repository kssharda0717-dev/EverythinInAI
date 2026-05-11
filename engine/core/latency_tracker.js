/**
 * EverythinInAI - Latency Tracker
 *
 * Records duration of every external service call into latency_log.
 * Powers the weekly health report and surfaces slowness trends.
 */

const { createLogger } = require('../utils/logger');
const log = createLogger('latency_tracker');

async function record(service, operation, durationMs, ok = true, errorMsg = null) {
  try {
    const dbModule = require('./database');
    const db = dbModule.getClient();
    await db.from('latency_log').insert({
      service, operation, duration_ms: durationMs, ok, error_msg: errorMsg,
    });
  } catch (err) {
    // Latency tracking is fire-and-forget; never block real work
    log.warn(`Latency log failed (non-fatal): ${err.message}`);
  }
}

/**
 * Wrap an async fn to auto-record its duration.
 *   const result = await track('replicate', 'lipsync', () => runModel(...))
 */
async function track(service, operation, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    await record(service, operation, Date.now() - start, true);
    return result;
  } catch (err) {
    await record(service, operation, Date.now() - start, false, (err.message || String(err)).slice(0, 500));
    throw err;
  }
}

module.exports = { record, track };
