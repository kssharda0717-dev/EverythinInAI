/**
 * EverythinInAI — Replicate Client
 *
 * Thin wrapper around Replicate's prediction API. Handles:
 *   - Submit prediction
 *   - Poll until succeeded/failed
 *   - Return output URLs + cost estimate
 *
 * Why not the official replicate-node SDK? Same reason we use raw axios for Gemini:
 * fewer deps, deterministic behavior, easier to debug.
 */

const axios = require('axios');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('replicate');

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '';
const BASE = 'https://api.replicate.com/v1';

// Pinned model versions (locked at build time so behavior never drifts).
// Update these explicitly when we choose to upgrade.
const MODELS = {
  flux_pro:    { id: 'black-forest-labs/flux-1.1-pro',  version: '609793a667ed94b210242837d3c3c9fc9a64ae93685f15d75002ba0ed9a97f2b', cost_per_image: 0.04 },
  flux_schnell:{ id: 'black-forest-labs/flux-schnell',  version: 'c846a69991daf4c0e5d016514849d14ee5b2e6846ce6b9d6f21369e564cfe51e', cost_per_image: 0.003 },
  flux_pulid:  { id: 'zsxkib/flux-pulid',               version: '8baa7ef2255075b46f4d91cd238c21d31181b3e6a864463f967960bb0112525b', cost_per_image: 0.05 },
};

function authHeaders() {
  if (!REPLICATE_API_TOKEN) throw new Error('REPLICATE_API_TOKEN missing');
  return {
    'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Submit a prediction and poll until done.
 * @param {string} modelKey - one of MODELS keys
 * @param {object} input - model-specific input object
 * @param {object} opts - { pollMs, timeoutMs }
 * @returns {Promise<{output, prediction, cost_usd, generation_ms}>}
 */
async function runModel(modelKey, input, opts = {}) {
  const model = MODELS[modelKey];
  if (!model) throw new Error(`Unknown model key: ${modelKey}`);

  const pollMs = opts.pollMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 180_000;

  const startMs = Date.now();
  log.info(`→ ${modelKey}  (${JSON.stringify(input).substring(0, 120)}...)`);

  // 1. Create prediction
  // Use the universal /v1/predictions endpoint with `version` field. This works
  // for both official models (black-forest-labs/*) and community models
  // (zsxkib/*, etc.) consistently. The /v1/models/{owner}/{name}/predictions
  // endpoint only works for some official models.
  const createUrl = `${BASE}/predictions`;
  const createBody = { version: model.version, input };

  // Retry loop for 429 throttling (free-tier limits or burst caps)
  let create;
  const maxRetries = opts.maxRetries ?? 4;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      create = await axios.post(createUrl, createBody, {
        headers: authHeaders(),
        timeout: 30_000,
      });
      break;
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      const retryAfter = body?.retry_after || (status === 429 ? 5 : 0);
      if (status === 429 && attempt < maxRetries) {
        const waitMs = (retryAfter + 1) * 1000;
        log.warn(`Rate-limited (429). Waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw new Error(`Replicate create failed (${status}): ${JSON.stringify(body || err.message)}`);
    }
  }

  const id = create.data.id;
  let prediction = create.data;

  // 2. Poll
  const pollUrl = `${BASE}/predictions/${id}`;
  while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.status !== 'canceled') {
    if (Date.now() - startMs > timeoutMs) {
      throw new Error(`Replicate prediction timed out after ${timeoutMs}ms (id=${id}, last=${prediction.status})`);
    }
    await new Promise(r => setTimeout(r, pollMs));
    const poll = await axios.get(pollUrl, { headers: authHeaders(), timeout: 15_000 });
    prediction = poll.data;
  }

  const generation_ms = Date.now() - startMs;

  if (prediction.status !== 'succeeded') {
    throw new Error(`Replicate prediction ${prediction.status}: ${prediction.error || JSON.stringify(prediction.logs || '').slice(-300)}`);
  }

  // Output is sometimes a string URL, sometimes an array. Normalize to array.
  let outputs = prediction.output;
  if (typeof outputs === 'string') outputs = [outputs];
  if (!Array.isArray(outputs)) outputs = [outputs].filter(Boolean);

  const numOutputs = outputs.length || 1;
  const cost_usd = +(model.cost_per_image * numOutputs).toFixed(4);

  log.info(`✓ ${modelKey} done in ${generation_ms}ms (${numOutputs} image${numOutputs > 1 ? 's' : ''}, ~$${cost_usd})`);

  return { output: outputs, prediction, cost_usd, generation_ms };
}

module.exports = { runModel, MODELS };
