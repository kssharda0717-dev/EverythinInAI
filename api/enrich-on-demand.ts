/**
 * EverythinInAI — Lazy Enrichment API v2 (Vercel Serverless)
 *
 * POST /api/enrich-on-demand    body: { slug: string }
 *
 * Robustness improvements over v1:
 *   - 2 attempts with progressively stronger prompt + higher temp on retry
 *   - Relaxed acceptance: any 3 of 6 structured fields populated counts as success
 *   - Tagline never injected as "description" hint (Gemini was echoing it)
 *   - Always overwrites the legacy "description" field if it's just the tagline
 *
 * Idempotent. Already-enriched rows return cached result without spending tokens.
 *
 * Env vars required (Vercel project settings):
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_KEY
 *   - GEMINI_API_KEY
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function clamp(arr: any, max: number, maxLen = 200): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.filter(x => typeof x === 'string').map(x => x.trim().substring(0, maxLen)).filter(Boolean).slice(0, max);
}

function buildPrompt(tool: any, attempt: number = 1): string {
  const stricter = attempt > 1 ? `

CRITICAL: Your previous attempt produced a stub or mostly empty response. This time, you MUST:
- Write a FRESH 200-word product overview. NEVER echo the tagline.
- Populate ALL fields (use_cases, key_features, pros, cons, best_for, search_aliases).
- If unsure about specifics, infer from category, tags, and URL.
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

async function callGemini(tool: any, attempt: number = 1): Promise<any | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');

  const r = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(tool, attempt) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        // Slightly higher temperature on retry to break out of stub output
        temperature: attempt === 1 ? 0.4 : 0.7,
        maxOutputTokens: 1500,
      },
    }),
  });

  const data: any = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  try { return JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  }
}

function isAcceptable(json: any): boolean {
  if (!json) return false;
  const descOk = typeof json.description === 'string' && json.description.length >= 80;
  const hasUseCases = Array.isArray(json.use_cases) && json.use_cases.filter(Boolean).length >= 2;
  const hasFeatures = Array.isArray(json.key_features) && json.key_features.filter(Boolean).length >= 2;
  const hasPros = Array.isArray(json.pros) && json.pros.filter(Boolean).length >= 2;
  return descOk || (hasUseCases && hasFeatures) || (hasUseCases && hasPros);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  try {
    const { slug } = req.body || {};
    if (!slug || typeof slug !== 'string') {
      return res.status(400).json({ error: 'Missing slug' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'Supabase env vars missing' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

    const { data: tool, error } = await supabase
      .from('tools')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();
    if (error || !tool) {
      return res.status(404).json({ error: 'Tool not found' });
    }

    // Already enriched? Return as-is, idempotent.
    const alreadyEnriched = Array.isArray(tool.use_cases) && tool.use_cases.length > 0
      && Array.isArray(tool.key_features) && tool.key_features.length > 0;
    if (alreadyEnriched) {
      return res.status(200).json({ tool, cached: true });
    }

    // Up to 2 attempts. Second uses a stronger prompt + higher temperature.
    let json: any = null;
    let lastReason = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const candidate = await callGemini(tool, attempt);
        if (isAcceptable(candidate)) {
          json = candidate;
          break;
        }
        lastReason = !candidate ? 'null parse' :
          (candidate.description?.length || 0) < 80 ? `desc=${candidate.description?.length || 0}<80` :
          'too few structured fields';
        console.warn(`[enrich-on-demand] attempt ${attempt} for ${slug} rejected (${lastReason})`);
      } catch (e: any) {
        lastReason = e.message;
        console.warn(`[enrich-on-demand] attempt ${attempt} threw for ${slug}: ${e.message}`);
      }
    }

    if (!json) {
      return res.status(200).json({ tool, cached: false, enriched: false, reason: lastReason });
    }

    // Build the update payload. We OVERWRITE description if the existing one is
    // short (likely just the tagline) so seeded tools get a real overview.
    const newDescription = (json.description || tool.tagline || '').substring(0, 2000);
    const keepExisting = (tool.description || '').length >= 200;
    const update = {
      display_name: (json.display_name || tool.name).substring(0, 120),
      description: keepExisting ? tool.description : newDescription,
      use_cases: clamp(json.use_cases, 5, 200),
      key_features: clamp(json.key_features, 5, 200),
      pros: clamp(json.pros, 4, 200),
      cons: clamp(json.cons, 3, 200),
      best_for: (json.best_for || '').substring(0, 240),
      search_aliases: clamp(json.search_aliases, 6, 60).map((s: string) => s.toLowerCase()),
      updated_at: new Date().toISOString(),
    };

    const { data: updated } = await supabase
      .from('tools')
      .update(update)
      .eq('slug', slug)
      .select()
      .maybeSingle();

    return res.status(200).json({ tool: updated || { ...tool, ...update }, cached: false, enriched: true });
  } catch (err: any) {
    console.error('[enrich-on-demand] error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
