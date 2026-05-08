#!/usr/bin/env node
/**
 * EverythinInAI — Tool Enricher
 *
 * Backfills:
 *   - Long-form description (200 words) using Gemini
 *   - homepage URL (extracted from GitHub README or inferred)
 *
 * Picks the top N tools by upvotes that are missing either field.
 *
 * Usage:
 *   node scripts/enrich_tools.js                 # process 100 by default
 *   node scripts/enrich_tools.js --limit=500     # process more
 *   node scripts/enrich_tools.js --only-homepage # skip description (faster)
 *
 * Cost: ~$0.001 per Gemini call × 100 = ~$0.10 per 100 tools.
 */

const axios = require('axios');
const dbModule = require('../engine/core/database');
const { config } = require('../engine/core/config');
const { createLogger } = require('../engine/utils/logger');

const log = createLogger('enrich');

const GEMINI_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

function parseArgs(argv) {
  const args = { limit: 100, onlyHomepage: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--limit=')) args.limit = parseInt(a.split('=')[1], 10);
    else if (a === '--only-homepage') args.onlyHomepage = true;
  }
  return args;
}

/**
 * Try to extract a homepage URL from a GitHub repo URL by reading the README.
 * Looks for common patterns: badge links, `## Website`, `homepage` package.json field, etc.
 */
async function extractHomepageFromGithub(githubUrl) {
  try {
    const m = githubUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
    if (!m) return null;
    const owner = m[1];
    const repo = m[2].replace(/\.git$/, '');

    // 1) GitHub repo metadata (the "Website" field most repos set)
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
  } catch (err) {
    return null;
  }
}

async function generateDescription(name, tagline, category, tags) {
  const apiKey = config.gemini.apiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');
  const model = config.gemini.model || 'gemini-2.5-flash';

  const prompt = `Write a sharp, info-dense 200-word product description for an AI tool directory. The description must:
- Open with what the tool DOES (not "is a tool that…")
- Cover: core capability, who it's for, what makes it different, pricing tier (without saying numbers)
- Sound like a senior tech reviewer wrote it (no marketing fluff, no buzzwords like "leverage", "revolutionary")
- 200 words, single paragraph, no bullet points

TOOL DETAILS:
- Name: ${name}
- Tagline: ${tagline}
- Category: ${category}
- Tags: ${tags.join(', ') || '(none)'}

Return ONLY the description. No headers, no bullet points, no quotes around it.`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.5, maxOutputTokens: 600 },
  };

  const r = await axios.post(GEMINI_URL(model), body, {
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    timeout: 60_000,
  });

  return (r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
}

async function main() {
  const args = parseArgs(process.argv);
  const db = dbModule.getClient();

  log.info(`Enriching up to ${args.limit} tools...`);

  // Pick rows that need work: missing description OR missing homepage
  const { data, error } = await db
    .from('tools')
    .select('id, slug, name, tagline, description, url, homepage, category, tags')
    .eq('is_active', true)
    .order('upvotes', { ascending: false })
    .limit(args.limit);
  if (error) throw error;

  let descUpdated = 0;
  let homeUpdated = 0;
  let failed = 0;

  for (let i = 0; i < data.length; i++) {
    const t = data[i];
    const update = {};

    // 1) Homepage extraction (only if URL is GitHub and homepage is empty)
    if (!t.homepage && t.url && t.url.includes('github.com')) {
      try {
        const homepage = await extractHomepageFromGithub(t.url);
        if (homepage) {
          update.homepage = homepage;
          homeUpdated++;
        }
      } catch (err) { /* skip */ }
    }

    // 2) Description (skip if --only-homepage OR if description is already long)
    if (!args.onlyHomepage) {
      const currentDesc = (t.description || '').trim();
      if (currentDesc.length < 150) {
        try {
          const desc = await generateDescription(t.name, t.tagline || '', t.category || 'Other', t.tags || []);
          if (desc && desc.length >= 100) {
            update.description = desc.substring(0, 2000);
            descUpdated++;
          }
        } catch (err) {
          log.warn(`Gemini failed for ${t.slug}: ${err.message}`);
        }
      }
    }

    if (Object.keys(update).length > 0) {
      update.updated_at = new Date().toISOString();
      const { error: upErr } = await db.from('tools').update(update).eq('id', t.id);
      if (upErr) {
        failed++;
        log.warn(`DB update failed for ${t.slug}: ${upErr.message}`);
      }
    }

    if ((i + 1) % 10 === 0) {
      log.info(`Progress: ${i + 1}/${data.length}  desc:${descUpdated} home:${homeUpdated} fail:${failed}`);
    }

    // Rate-limit Gemini gently
    await new Promise(r => setTimeout(r, 500));
  }

  log.info(`══════════════════════════════════════════════`);
  log.info(`✓ Enrichment complete.`);
  log.info(`   Descriptions updated: ${descUpdated}`);
  log.info(`   Homepages extracted:  ${homeUpdated}`);
  log.info(`   Failed:               ${failed}`);
  log.info(`══════════════════════════════════════════════`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
