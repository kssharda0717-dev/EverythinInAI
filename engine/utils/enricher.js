/**
 * EverythinInAI — Tool Enricher (autonomous)
 *
 * Reusable function that takes a tool record and returns a structured enrichment
 * object: { display_name, description, use_cases[], key_features[], pros[], cons[],
 * best_for, search_aliases[] }.
 *
 * Used in three places:
 *   1. Inline during insert (engine/core/database.js → insertTool)
 *   2. Lazy-fill on demand (api/enrich-on-demand.ts → user clicks a thin tool)
 *   3. Backfill script (scripts/enrich_tools.js → one-shot for existing rows)
 */

const axios = require('axios');
const { config } = require('../core/config');
const { createLogger } = require('./logger');

const log = createLogger('enricher');

const GEMINI_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

function clamp(arr, max, maxLen = 200) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(x => typeof x === 'string').map(x => x.trim().substring(0, maxLen)).filter(Boolean).slice(0, max);
}

/**
 * Build the structured-enrichment prompt.
 */
function buildPrompt(tool) {
  return `You are the editor of a high-end AI tools directory. For the tool below, return a JSON object that helps both technical and non-technical users decide if it fits them.

TOOL:
- name: ${tool.name}
- tagline: ${tool.tagline || '(none)'}
- category: ${tool.category}
- tags: ${(tool.tags || []).join(', ') || '(none)'}
- url: ${tool.homepage || tool.url || '(unknown)'}

Return JSON ONLY, no markdown fences, in this exact shape:
{
  "display_name": "Friendly name with optional parenthetical clarification, e.g. 'Ollama (run AI locally)' or 'LiteLLM (one API for 100+ LLMs)'. Use the original name if it's already clear.",
  "description": "Sharp, info-dense 180-220 word product overview. Sounds like a senior tech reviewer. NO marketing fluff. Single paragraph.",
  "use_cases": ["3-5 short concrete use cases, each max 12 words"],
  "key_features": ["3-5 standout features in plain language, each max 10 words"],
  "pros": ["3-4 honest strengths, each one short clause"],
  "cons": ["2-3 honest real weaknesses, each one short clause"],
  "best_for": "One short sentence on the ideal user.",
  "search_aliases": ["3-6 lay-friendly search terms, all lowercase, no duplicates of the tool name"]
}`;
}

/**
 * Call Gemini and parse the response.
 */
async function callGemini(tool) {
  const apiKey = config.gemini.apiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');
  const model = config.gemini.model || 'gemini-2.5-flash';

  const r = await axios.post(GEMINI_URL(model), {
    contents: [{ parts: [{ text: buildPrompt(tool) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.4,
      maxOutputTokens: 1500,
    },
  }, {
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    timeout: 60_000,
  });

  const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  }
}

/**
 * Enrich a tool record with structured fields.
 * Returns an object that can be merged directly into the DB row.
 *
 * @param {Object} tool — must have at least { name, tagline, category, tags, url }
 * @returns {Promise<Object|null>} { display_name, description, use_cases, key_features, pros, cons, best_for, search_aliases } — or null on failure
 */
async function enrichTool(tool) {
  if (!tool || !tool.name) return null;
  try {
    const json = await callGemini(tool);
    if (!json || !json.description || json.description.length < 80) {
      log.warn(`Enrich rejected ${tool.name}: description too short or null`);
      return null;
    }
    return {
      display_name: (json.display_name || tool.name).substring(0, 120),
      description: json.description.substring(0, 2000),
      use_cases: clamp(json.use_cases, 5, 200),
      key_features: clamp(json.key_features, 5, 200),
      pros: clamp(json.pros, 4, 200),
      cons: clamp(json.cons, 3, 200),
      best_for: (json.best_for || '').substring(0, 240),
      search_aliases: clamp(json.search_aliases, 6, 60).map(s => s.toLowerCase()),
    };
  } catch (err) {
    log.warn(`Enrich failed for ${tool.name}: ${err.message}`);
    return null;
  }
}

/**
 * Returns true if a tool row already has structured enrichment.
 */
function isEnriched(tool) {
  return Array.isArray(tool.use_cases) && tool.use_cases.length > 0
      && Array.isArray(tool.key_features) && tool.key_features.length > 0;
}

module.exports = { enrichTool, isEnriched };
