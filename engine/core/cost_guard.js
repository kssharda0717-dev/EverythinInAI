/**
 * EverythinInAI - Cost Guard (Circuit Breaker)
 *
 * Prevents runaway spending. Every Replicate/Gemini call goes through here.
 * Records spend and refuses expensive calls if daily cap is exceeded.
 */

const { createLogger } = require('../utils/logger');
const log = createLogger('cost_guard');

let cachedSettings = null;
let settingsExpireAt = 0;

async function getSettings() {
  if (cachedSettings && Date.now() < settingsExpireAt) return cachedSettings;
  
  const dbModule = require('./database');
  const db = dbModule.getClient();
  const { data, error } = await db.from('system_settings')
    .select('key, value')
    .in('key', ['daily_spend_cap_usd', 'expensive_call_threshold_usd']);
  
  if (error) {
    log.warn(`Could not load settings, using defaults: ${error.message}`);
    cachedSettings = { dailyCap: 5.0, expensiveThreshold: 0.5 };
  } else {
    const m = Object.fromEntries(data.map(r => [r.key, r.value]));
    cachedSettings = {
      dailyCap: parseFloat(m.daily_spend_cap_usd) || 5.0,
      expensiveThreshold: parseFloat(m.expensive_call_threshold_usd) || 0.5,
    };
  }
  settingsExpireAt = Date.now() + 60_000; // cache for 60s
  return cachedSettings;
}

async function getTodaysSpend() {
  const dbModule = require('./database');
  const db = dbModule.getClient();
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await db.from('daily_spend_log')
    .select('cost_usd')
    .eq('date', today);
  if (error) {
    log.warn(`Could not query spend log: ${error.message}`);
    return 0;
  }
  return (data || []).reduce((sum, r) => sum + parseFloat(r.cost_usd || 0), 0);
}

/**
 * Check if a call of the given estimated cost is allowed.
 * Returns { allowed: boolean, reason?: string, todaysSpend, cap }.
 */
async function checkCanSpend(estimatedCostUsd, opts = {}) {
  const { dailyCap, expensiveThreshold } = await getSettings();
  
  if (estimatedCostUsd < expensiveThreshold) {
    return { allowed: true, todaysSpend: null, cap: dailyCap };
  }
  
  const todaysSpend = await getTodaysSpend();
  
  if (todaysSpend + estimatedCostUsd > dailyCap) {
    return {
      allowed: false,
      reason: `Daily spend cap exceeded: today's spend $${todaysSpend.toFixed(2)} + $${estimatedCostUsd.toFixed(2)} > cap $${dailyCap.toFixed(2)}`,
      todaysSpend,
      cap: dailyCap,
    };
  }
  
  return { allowed: true, todaysSpend, cap: dailyCap };
}

/**
 * Log an actual spend after a successful call.
 */
async function recordSpend(service, model, costUsd, context = {}) {
  if (!costUsd || costUsd === 0) return;
  
  const dbModule = require('./database');
  const db = dbModule.getClient();
  const today = new Date().toISOString().slice(0, 10);
  
  const { error } = await db.from('daily_spend_log').insert({
    date: today,
    service,
    model,
    cost_usd: costUsd,
    context,
  });
  
  if (error) {
    log.warn(`Failed to log spend (non-fatal): ${error.message}`);
  }
}

/**
 * Convenience wrapper: check, throw if not allowed, then return a recorder fn
 * to call after the operation completes.
 *
 * Usage:
 *   const record = await guard('replicate', 'omni_human', 3.33, { concept_id });
 *   const result = await runModel(...)
 *   await record(result.cost_usd);   // logs the actual cost
 */
async function guard(service, model, estimatedCostUsd, context = {}) {
  const check = await checkCanSpend(estimatedCostUsd, { service, model });
  if (!check.allowed) {
    log.error(`COST GUARD BLOCKED: ${service}/${model} ($${estimatedCostUsd}) - ${check.reason}`);
    const err = new Error(`CostGuard: ${check.reason}`);
    err.code = 'COST_CAP_EXCEEDED';
    throw err;
  }
  
  return async (actualCost) => {
    await recordSpend(service, model, actualCost ?? estimatedCostUsd, context);
  };
}

module.exports = { guard, checkCanSpend, recordSpend, getTodaysSpend, getSettings };
