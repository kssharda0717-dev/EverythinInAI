#!/usr/bin/env node
/**
 * EverythinInAI — Framework Evolution Engine
 *
 * Runs monthly. Acts as the "Head of Content" AI.
 * 1. Analyzes performance of all frameworks over the last 30 days.
 * 2. Kills losers (<15% retention over 3+ tests).
 * 3. Identifies winners (>30% retention).
 * 4. Feeds winners to Gemini Pro to deconstruct their psychological triggers
 *    and invent 3 NEW frameworks per stream that use the same triggers but
 *    feel completely fresh (preventing ad fatigue).
 */

const axios = require('axios');
const dbModule = require('../../engine/core/database');
const { config } = require('../../engine/core/config');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('framework_evolution');

const GEMINI_URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

async function getFrameworkPerformance(db) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: rows } = await db.from('reel_performance')
    .select('framework, views, avg_watch_sec, retention_pct')
    .gte('recorded_at', thirtyDaysAgo);

  if (!rows || rows.length === 0) return {};

  const agg = {};
  for (const r of rows) {
    const f = r.framework;
    if (!f) continue;
    if (!agg[f]) agg[f] = { count: 0, views: 0, watch: 0, retention: 0 };
    agg[f].count++;
    agg[f].views += r.views || 0;
    agg[f].watch += parseFloat(r.avg_watch_sec) || 0;
    agg[f].retention += parseFloat(r.retention_pct) || 0;
  }

  const result = {};
  for (const [f, a] of Object.entries(agg)) {
    result[f] = {
      sampleSize: a.count,
      avgViews: Math.round(a.views / a.count),
      avgWatch: (a.watch / a.count).toFixed(1),
      avgRetention: parseFloat((a.retention / a.count).toFixed(1)),
    };
  }
  return result;
}

async function evolveFrameworks(stream, winners, db) {
  const apiKey = config.gemini.apiKey;
  const model = 'gemini-2.5-pro'; // Use Pro for deep strategic reasoning

  const prompt = `
You are a God-level Social Media Strategist and Head of Content for a top AI influencer named Rhea.
Your job is to invent highly viral, fresh content frameworks to prevent audience fatigue.

We are evolving the "${stream}" content stream.
Here are the frameworks that currently perform best for us (high retention):
${winners.map(w => `- ${w.name}: ${w.desc} (Retention: ${w.perf.avgRetention}%)`).join('\n')}

TASK:
1. Deconstruct the underlying human psychology of WHY these frameworks work (e.g., FOMO, status signaling, controversy).
2. Invent exactly 3 COMPLETELY NEW frameworks for the "${stream}" stream that use these same psychological triggers but look and feel totally fresh.

REQUIREMENTS:
- Must be radically different from the existing ones to avoid ad fatigue.
- For 'tech' stream: focus on 8-15s fast-paced scripts, scroll-stopping hooks, high value.
- For 'lure' stream: focus on slice-of-life photos, parasocial connection, high status, desire.
- For 'lifestyle' stream: focus on high-action video concepts, jealousy, aspiration (gym, driving, travel).

OUTPUT JSON SCHEMA:
{
  "new_frameworks": [
    {
      "slug": "unique_snake_case_id",
      "display_name": "Catchy Name",
      "description": "One line summary of what this is",
      "prompt_template": "The exact instructions the drafting LLM should follow when using this framework. Be highly specific about hook structure, visual rhythm, and vibe.",
      "example_hook": "An example of the first line or visual",
      "reasoning": "Why you believe this will go viral based on the winning psychology"
    }
  ]
}
Return ONLY valid JSON.
`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.9 },
  };

  log.info(`Asking Gemini Pro to evolve ${stream} frameworks...`);
  const resp = await axios.post(GEMINI_URL(model), body, {
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    timeout: 120_000,
  });

  const rawText = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  let parsed;
  try {
    parsed = JSON.parse(rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
  } catch (err) {
    throw new Error(`Failed to parse Gemini JSON: ${err.message}`);
  }

  if (!parsed.new_frameworks) throw new Error('Missing new_frameworks in response');

  const parentSlug = winners[0]?.name || 'genesis';

  for (const f of parsed.new_frameworks) {
    log.info(`[NEW] ${f.display_name} (${f.slug})`);
    await db.from('content_frameworks').insert({
      slug: f.slug,
      stream: stream,
      display_name: f.display_name,
      description: f.description,
      prompt_template: f.prompt_template,
      example_hook: f.example_hook,
      generation: 2, // incremented
      parent_slug: parentSlug,
      reasoning: f.reasoning,
    });
  }
}

async function main() {
  const db = dbModule.getClient();
  log.info('Starting Framework Evolution Engine...');

  const perf = await getFrameworkPerformance(db);
  const { data: frameworks } = await db.from('content_frameworks').select('*').eq('is_active', true);

  // 1. Evaluate existing
  const winnersByStream = { tech: [], lure: [], lifestyle: [] };
  
  for (const f of frameworks) {
    const p = perf[f.slug];
    if (!p) continue;

    if (p.sampleSize >= 3 && p.avgRetention < 15.0) {
      log.warn(`[KILL] ${f.slug} (Retention: ${p.avgRetention}%, N=${p.sampleSize}). Disabling.`);
      await db.from('content_frameworks').update({ is_active: false, retired_at: new Date().toISOString(), retired_reason: 'Low retention' }).eq('slug', f.slug);
    } else if (p.sampleSize >= 2 && p.avgRetention >= 30.0) {
      log.info(`[WINNER] ${f.slug} (Retention: ${p.avgRetention}%, N=${p.sampleSize})`);
      winnersByStream[f.stream].push({ name: f.slug, desc: f.description, perf: p });
    }
  }

  // 2. Evolve streams that have clear winners
  for (const stream of ['tech', 'lure', 'lifestyle']) {
    if (winnersByStream[stream].length > 0) {
      try {
        await evolveFrameworks(stream, winnersByStream[stream], db);
      } catch (err) {
        log.error(`Failed to evolve ${stream}: ${err.message}`);
      }
    } else {
      log.info(`Skipping evolution for ${stream} - no clear winners yet.`);
    }
  }

  log.info('Evolution complete.');
}

if (require.main === module) {
  main().catch(err => {
    log.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
