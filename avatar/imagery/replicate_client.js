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
const { guard } = require('../../engine/core/cost_guard');
const { record: recordLatency } = require('../../engine/core/latency_tracker');

const log = createLogger('replicate');

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '';
const BASE = 'https://api.replicate.com/v1';

// Pinned model versions (locked at build time so behavior never drifts).
// Update these explicitly when we choose to upgrade.
const MODELS = {
  flux_pro:    { id: 'black-forest-labs/flux-1.1-pro',  version: '609793a667ed94b210242837d3c3c9fc9a64ae93685f15d75002ba0ed9a97f2b', cost_per_image: 0.04 },
  flux_schnell:{ id: 'black-forest-labs/flux-schnell',  version: 'c846a69991daf4c0e5d016514849d14ee5b2e6846ce6b9d6f21369e564cfe51e', cost_per_image: 0.003 },
  flux_pulid:  { id: 'zsxkib/flux-pulid',               version: '8baa7ef2255075b46f4d91cd238c21d31181b3e6a864463f967960bb0112525b', cost_per_image: 0.05 },
  // InstantID-SDXL — photoreal-first identity lock. Industry standard for AI personas.
  instant_id:  { id: 'zsxkib/instant-id',               version: '2e4785a4d80dadf580077b2244c8d7c05d8e3faac04a04c02d8e099dd2876789', cost_per_image: 0.02 },
  // Flux Dev with LoRA support — used for inference once we have Avi's trained LoRA
  flux_dev_lora: { id: 'black-forest-labs/flux-dev-lora', version: 'ae0d7d645446924cf1871e3ca8796e8318f72465d2b5af9323a835df93bf0917', cost_per_image: 0.025 },
  // Voice cloning TTS for Avi (Chatterbox — high quality + cheap)
  chatterbox:    { id: 'resemble-ai/chatterbox',    version: '1b8422bc49635c20d0a84e387ed20879c0dd09254ecdb4e75dc4bec10ff94e97', cost_per_image: 0.03 },
  // Word-level transcription (for animated captions)
  whisper_fast:  { id: 'vaibhavs10/incredibly-fast-whisper', version: '3ab86df6c8f54c11309d4d1f930ac292bad43ace52d10c80d87eb258b3c9f79c', cost_per_image: 0.01 },
  // Lip-sync: turn one Avi portrait + voice WAV into a talking-head video
  // (legacy, looks robotic)
  sadtalker:    { id: 'lucataco/sadtalker',    version: '85c698db7c0a66d5011435d0191db323034e1da04b912a6d365833141b6a285b', cost_per_image: 0.10 },
  // ByteDance OmniHuman — STATE-OF-THE-ART quality. EXPENSIVE: ~$3.33/30s reel.
  omni_human:   { id: 'bytedance/omni-human',  version: '566f1b03016969ac39e242c1ae4a39034686ca8850fc3dba83dceaceb96f74b2', cost_per_image: 3.33 },
  // Wan 2.2 Speech-to-Video — motion-only, generic lip-sync. Kept as legacy fallback.
  // Takes a single portrait image + audio. NOT recommended for close-up dialogue.
  wan_2_2_s2v:  { id: 'wan-video/wan-2.2-s2v', version: '09607e6e761d2f015b0d740f938ec59199f54aa623384465a5054b230405acf4', cost_per_image: 0.60 },
  // Pruna p-video-avatar — OFFICIAL Replicate model, $0.025/sec at 720p (~₹25/12s reel).
  // Image + audio input, phoneme-aware lip-sync. "Fastest and cheapest avatar/lipsync".
  // Note: this is one of Replicate's versionless official models — use /v1/models/{owner}/{name}/predictions endpoint, NOT the /v1/predictions endpoint with version hash.
  pruna_avatar: { id: 'prunaai/p-video-avatar', version: null, useModelEndpoint: true, cost_per_image: 0.30 },
  // Kling v1.6 Standard — image-to-video with motion. $0.05/sec, 10 sec = $0.50.
  // Used for weekend action lifestyle reels (gym, pilates, driving, etc.)
  kling_v1_6_std: { id: 'kwaivgi/kling-v1.6-standard', version: 'e6f571e8d6990da3c96abf8d3082894024d652822f0ca3cd244acece84a1cc3e', cost_per_image: 0.50 },
};

// LoRA trainer — used once to create Avi's identity LoRA. Cost: ~$2-3 flat.
const TRAINER = {
  id: 'ostris/flux-dev-lora-trainer',
  version: '26dce37af90b9d997eeb970d92e47de3064d46c300504ae376c75bef6a9022d2',
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

  // Cost guard: refuse expensive calls if daily cap is hit
  const recordSpend = await guard('replicate', modelKey, model.cost_per_image, opts.context || {});

  const pollMs = opts.pollMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 180_000;

  const startMs = Date.now();
  log.info(`→ ${modelKey}  (${JSON.stringify(input).substring(0, 120)}...)`);

  // 1. Create prediction
  // Replicate has TWO prediction endpoints:
  //   a) /v1/predictions   { version, input }  — community + most official versioned models
  //   b) /v1/models/{owner}/{name}/predictions { input }  — versionless official models (Pruna, etc.)
  // We pick based on the model's `useModelEndpoint` flag.
  let createUrl, createBody;
  if (model.useModelEndpoint) {
    createUrl = `${BASE}/models/${model.id}/predictions`;
    createBody = { input };
  } else {
    createUrl = `${BASE}/predictions`;
    createBody = { version: model.version, input };
  }

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

  // Record actual cost + latency (non-blocking)
  recordSpend(cost_usd).catch(() => {});
  recordLatency('replicate', modelKey, generation_ms, true).catch(() => {});

  return { output: outputs, prediction, cost_usd, generation_ms };
}

module.exports = { runModel, MODELS, TRAINER, BASE, authHeaders };
