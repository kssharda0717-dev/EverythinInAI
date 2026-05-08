/**
 * EverythinInAI — Lazy Enrichment API (Vercel Serverless)
 *
 * POST /api/enrich-on-demand
 *   body: { slug: string }
 *
 * If the tool with `slug` is missing structured fields (use_cases, key_features),
 * call Gemini to enrich it, save to Supabase, and return the enriched record.
 *
 * Idempotent — if already enriched, returns the existing record without spending tokens.
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

function buildPrompt(tool: any): string {
  return `You are the editor of a high-end AI tools directory. For the tool below, return a JSON object that helps both technical and non-technical users decide if it fits them.

TOOL:
- name: ${tool.name}
- tagline: ${tool.tagline || '(none)'}
- category: ${tool.category}
- tags: ${(tool.tags || []).join(', ') || '(none)'}
- url: ${tool.homepage || tool.url || '(unknown)'}

Return JSON ONLY, no markdown fences, in this exact shape:
{
  "display_name": "Friendly name with optional parenthetical clarification.",
  "description": "Sharp, info-dense 180-220 word product overview. NO marketing fluff. Single paragraph.",
  "use_cases": ["3-5 short concrete use cases, each max 12 words"],
  "key_features": ["3-5 standout features in plain language, each max 10 words"],
  "pros": ["3-4 honest strengths"],
  "cons": ["2-3 honest real weaknesses"],
  "best_for": "One short sentence on the ideal user.",
  "search_aliases": ["3-6 lay-friendly search terms, all lowercase"]
}`;
}

async function callGemini(tool: any): Promise<any | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');

  const r = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(tool) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.4,
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

    const json = await callGemini(tool);
    if (!json || !json.description || json.description.length < 80) {
      return res.status(200).json({ tool, cached: false, enriched: false });
    }

    const update = {
      display_name: (json.display_name || tool.name).substring(0, 120),
      description: (tool.description && tool.description.length > 200) ? tool.description : json.description.substring(0, 2000),
      use_cases: clamp(json.use_cases, 5, 200),
      key_features: clamp(json.key_features, 5, 200),
      pros: clamp(json.pros, 4, 200),
      cons: clamp(json.cons, 3, 200),
      best_for: (json.best_for || '').substring(0, 240),
      search_aliases: clamp(json.search_aliases, 6, 60).map(s => s.toLowerCase()),
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
