/**
 * EverythinInAI — Tool Enricher v2 (autonomous, robust)
 *
 * Returns: { display_name, description, use_cases[], key_features[], pros[], cons[],
 *            best_for, search_aliases[] }.
 *
 * Robustness improvements over v1:
 *   - Two attempts with progressively stronger prompts when the first attempt
 *     returns a too-short or empty description.
 *   - Acceptance criteria relaxed: if any 4 of 6 structured fields are populated
 *     we keep what we got rather than throwing the whole thing away.
 *   - Stronger system instruction: never echo the existing tagline; produce a
 *     fresh 200-word overview every time.
 *   - Telemetry-friendly: logs WHY each attempt succeeded or failed.
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
 *
 * @param {Object} tool
 * @param {Number} attempt 1 = first try; 2 = retry with stronger directive
 */
function buildPrompt(tool, attempt = 1) {
  const stricter = attempt > 1 ? `

CRITICAL: The first attempt produced a stub or near-empty response. This time, you MUST:
- Write a FRESH 200-word product overview. NEVER echo the tagline.
- Populate ALL fields (use_cases, key_features, pros, cons, best_for, search_aliases).
- If unsure about a tool's specifics, infer from category + tags + URL pattern.
- Do not skip any field. Do not return empty arrays.` : '';

  return `You are the senior editor of a high-end AI tools directory. For the tool below, return a JSON object that helps both technical and non-technical users decide if it fits their needs.${stricter}

TOOL:
- name: ${tool.name}
- category: ${tool.category}
- tags: ${(tool.tags || []).join(', ') || '(none)'}
- url: ${tool.homepage || tool.url || '(unknown)'}
${tool.tagline ? `- one-line description (for context only, do NOT copy verbatim): ${tool.tagline}` : ''}

Return JSON ONLY (no markdown fences, no comments) matching this exact shape:
{
  "display_name": "Friendly name with optional parenthetical clarification, e.g. 'Ollama (run AI locally)' or 'LiteLLM (one API for 100+ LLMs)'. Use the original name if already clear.",
  "description": "FRESH info-dense 180-220 word product overview written in your own words. Sounds like a senior tech reviewer. NO marketing fluff. Single paragraph. Never just repeat the tagline.",
  "use_cases": ["3-5 short concrete use cases, each max 12 words"],
  "key_features": ["3-5 standout features in plain language, each max 10 words"],
  "pros": ["3-4 honest strengths, each one short clause"],
  "cons": ["2-3 honest real weaknesses, each one short clause"],
  "best_for": "One short sentence describing the ideal user.",
  "search_aliases": ["3-6 lay-friendly search terms, all lowercase, no duplicates of the tool name"]
}`;
}

/**
 * Call Gemini and parse the response. Throws on transport failure.
 */
async function callGemini(tool, attempt = 1) {
  const apiKey = config.gemini.apiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');
  const model = config.gemini.model || 'gemini-2.5-flash';

  const r = await axios.post(GEMINI_URL(model), {
    contents: [{ parts: [{ text: buildPrompt(tool, attempt) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      // Slightly higher temperature on retry to break out of stub-output ruts
      temperature: attempt === 1 ? 0.4 : 0.7,
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
 * Decide whether the Gemini JSON is "good enough" to persist.
 * Relaxed v2 rule: at least description ≥ 80 chars OR ≥ 3 of {use_cases, key_features, pros}
 * have something in them.
 */
function isAcceptable(json) {
  if (!json) return false;
  const descOk = typeof json.description === 'string' && json.description.length >= 80;
  const hasUseCases = Array.isArray(json.use_cases) && json.use_cases.filter(Boolean).length >= 2;
  const hasFeatures = Array.isArray(json.key_features) && json.key_features.filter(Boolean).length >= 2;
  const hasPros = Array.isArray(json.pros) && json.pros.filter(Boolean).length >= 2;
  return descOk || (hasUseCases && hasFeatures) || (hasUseCases && hasPros);
}

/**
 * Enrich a tool record with structured fields.
 * Returns an object that can be merged directly into the DB row.
 *
 * @param {Object} tool — must have at least { name, tagline, category, tags, url }
 * @returns {Promise<Object|null>} structured enrichment, or null on failure
 */
async function enrichTool(tool) {
  if (!tool || !tool.name) return null;

  // Up to 2 attempts. Second attempt uses a strengthened prompt + higher temp.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const json = await callGemini(tool, attempt);
      if (isAcceptable(json)) {
        return {
          display_name: (json.display_name || tool.name).substring(0, 120),
          description: (json.description || tool.tagline || '').substring(0, 2000),
          use_cases: clamp(json.use_cases, 5, 200),
          key_features: clamp(json.key_features, 5, 200),
          pros: clamp(json.pros, 4, 200),
          cons: clamp(json.cons, 3, 200),
          best_for: (json.best_for || '').substring(0, 240),
          search_aliases: clamp(json.search_aliases, 6, 60).map(s => s.toLowerCase()),
        };
      }
      const reason = !json ? 'null parse' :
        (json.description?.length || 0) < 80 ? `desc=${json.description?.length || 0}<80` :
        'too few structured fields';
      log.warn(`Enrich attempt ${attempt} for "${tool.name}" rejected (${reason})`);
    } catch (err) {
      log.warn(`Enrich attempt ${attempt} threw for "${tool.name}": ${err.message}`);
    }
  }
  log.warn(`Enrich gave up after 2 attempts for "${tool.name}"`);
  return null;
}

/**
 * Returns true if a tool row already has structured enrichment.
 */
function isEnriched(tool) {
  return Array.isArray(tool.use_cases) && tool.use_cases.length > 0
      && Array.isArray(tool.key_features) && tool.key_features.length > 0;
}

module.exports = { enrichTool, isEnriched };
