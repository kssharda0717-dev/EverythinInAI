#!/usr/bin/env node
/**
 * EverythinInAI — Tool Enricher v2 (structured)
 *
 * For each tool, asks Gemini to return STRUCTURED JSON:
 *   - display_name      : friendly name with parenthetical context (e.g. "Ollama (run LLMs locally)")
 *   - description       : 200-word overview
 *   - use_cases         : 3-5 short concrete use cases
 *   - key_features      : 3-5 standout features
 *   - pros              : 3-4 strengths
 *   - cons              : 2-3 honest weaknesses
 *   - best_for          : one short sentence on the ideal user
 *   - search_aliases    : 3-6 lay-friendly search terms
 *
 * Also extracts homepage URL from GitHub repos when missing.
 *
 * Cost: ~$0.001-0.002 per tool with structured output. ~$0.30 for 200 tools.
 *
 * Usage:
 *   node scripts/enrich_tools.js                     # 100 by default
 *   node scripts/enrich_tools.js --limit=300
 *   node scripts/enrich_tools.js --force             # re-process even rich rows
 *   node scripts/enrich_tools.js --only-homepage     # skip Gemini entirely
 */

const axios = require('axios');
const dbModule = require('../engine/core/database');
const { config } = require('../engine/core/config');
const { createLogger } = require('../engine/utils/logger');

const log = createLogger('enrich');

const GEMINI_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

function parseArgs(argv) {
  const args = { limit: 100, onlyHomepage: false, force: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--limit=')) args.limit = parseInt(a.split('=')[1], 10);
    else if (a === '--only-homepage') args.onlyHomepage = true;
    else if (a === '--force') args.force = true;
  }
  return args;
}

async function extractHomepageFromGithub(githubUrl) {
  try {
    const m = githubUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
    if (!m) return null;
    const owner = m[1];
    const repo = m[2].replace(/\.git$/, '');
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;
    const headers = config.github?.token
      ? { 'Authorization': `Bearer ${config.github.token}`, 'User-Agent': 'EverythinInAI' }
      : { 'User-Agent': 'EverythinInAI' };
    const r = await axios.get(apiUrl, { headers, timeout: 15_000 });
    const homepage = r.data?.homepage;
    if (homepage && homepage.trim() && /^https?:\/\//.test(homepage)) {
      return homepage.trim().replace(/\/$/, '');
    }
    return null;
  } catch { return null; }
}

async function generateStructuredEnrichment(name, tagline, category, tags, url) {
  const apiKey = config.gemini.apiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');
  const model = config.gemini.model || 'gemini-2.5-flash';

  const prompt = `You are the editor of a high-end AI tools directory. For the tool below, return a JSON object that helps both technical and non-technical users decide if it fits them.

TOOL:
- name: ${name}
- tagline: ${tagline || '(none)'}
- category: ${category}
- tags: ${(tags || []).join(', ') || '(none)'}
- url: ${url || '(unknown)'}

Return JSON ONLY, no markdown fences, in this exact shape:
{
  "display_name": "Friendly name with optional parenthetical clarification, e.g. 'Ollama (run AI locally)' or 'LiteLLM (one API for 100+ LLMs)'. Use the original name if it's already clear.",
  "description": "Sharp, info-dense 180-220 word product overview. Sounds like a senior tech reviewer. NO marketing fluff. Single paragraph.",
  "use_cases": [
    "Each entry is one short sentence (max 12 words) describing a concrete real use case",
    "3 to 5 entries total"
  ],
  "key_features": [
    "3 to 5 standout features in plain language, not buzzwords",
    "Each entry is one short clause (max 10 words)"
  ],
  "pros": [
    "3 to 4 honest strengths, written for someone evaluating the tool",
    "Each entry is one short clause"
  ],
  "cons": [
    "2 to 3 honest, real weaknesses or caveats — NOT 'requires internet' fluff",
    "Each entry is one short clause"
  ],
  "best_for": "One short sentence describing the ideal user and what they want to do.",
  "search_aliases": [
    "Lay-friendly terms a non-technical user might type to find this tool",
    "e.g. for Pinecone: ['vector database', 'ai memory', 'embeddings storage', 'rag database']",
    "3 to 6 entries, all lowercase, no duplicates of the tool name"
  ]
}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.4,
      maxOutputTokens: 1500,
    },
  };

  const r = await axios.post(GEMINI_URL(model), body, {
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    timeout: 90_000,
  });

  const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  }
}

function clamp(arr, max, maxLen = 200) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(x => typeof x === 'string').map(x => x.trim().substring(0, maxLen)).filter(Boolean).slice(0, max);
}

async function main() {
  const args = parseArgs(process.argv);
  const db = dbModule.getClient();

  log.info(`Enriching up to ${args.limit} tools  force=${args.force}  onlyHomepage=${args.onlyHomepage}`);

  const { data, error } = await db
    .from('tools')
    .select('id, slug, name, tagline, description, url, homepage, category, tags, key_features, use_cases')
    .eq('is_active', true)
    .order('upvotes', { ascending: false })
    .limit(args.limit);
  if (error) throw error;

  let enriched = 0;
  let homeUpdated = 0;
  let failed = 0;

  for (let i = 0; i < data.length; i++) {
    const t = data[i];
    const update = {};

    // 1. Homepage from GitHub
    if (!t.homepage && t.url && t.url.includes('github.com')) {
      try {
        const hp = await extractHomepageFromGithub(t.url);
        if (hp) {
          update.homepage = hp;
          homeUpdated++;
        }
      } catch {}
    }

    // 2. Structured enrichment
    if (!args.onlyHomepage) {
      const hasStructured = (t.use_cases || []).length > 0 && (t.key_features || []).length > 0;
      const skipDueToExisting = !args.force && hasStructured;

      if (!skipDueToExisting) {
        try {
          const json = await generateStructuredEnrichment(t.name, t.tagline || '', t.category || 'Other', t.tags || [], t.homepage || t.url);
          if (json && json.description && json.description.length >= 80) {
            update.display_name = (json.display_name || t.name).substring(0, 120);
            update.description = json.description.substring(0, 2000);
            update.use_cases = clamp(json.use_cases, 5, 200);
            update.key_features = clamp(json.key_features, 5, 200);
            update.pros = clamp(json.pros, 4, 200);
            update.cons = clamp(json.cons, 3, 200);
            update.best_for = (json.best_for || '').substring(0, 240);
            update.search_aliases = clamp(json.search_aliases, 6, 60).map(s => s.toLowerCase());
            enriched++;
            log.info(`  \u2713 ${t.slug.padEnd(28)}  desc=${json.description.length}  uc=${update.use_cases.length}  feat=${update.key_features.length}`);
          } else {
            log.warn(`  \u26a0 ${t.slug} \u2014 invalid JSON or empty desc`);
            failed++;
          }
        } catch (err) {
          log.warn(`  \u2717 ${t.slug}: ${err.message}`);
          failed++;
        }
      }
    }

    if (Object.keys(update).length > 0) {
      update.updated_at = new Date().toISOString();
      const { error: upErr } = await db.from('tools').update(update).eq('id', t.id);
      if (upErr) {
        failed++;
        log.warn(`  DB update failed for ${t.slug}: ${upErr.message}`);
      }
    }

    if ((i + 1) % 10 === 0) {
      log.info(`Progress: ${i + 1}/${data.length}  enriched=${enriched}  home=${homeUpdated}  fail=${failed}`);
    }

    await new Promise(r => setTimeout(r, 400));   // gentle Gemini rate-limit
  }

  log.info(`══════════════════════════════════════════════`);
  log.info(`✓ Enrichment complete.`);
  log.info(`   Tools enriched:    ${enriched}`);
  log.info(`   Homepages updated: ${homeUpdated}`);
  log.info(`   Failures:          ${failed}`);
  log.info(`══════════════════════════════════════════════`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
