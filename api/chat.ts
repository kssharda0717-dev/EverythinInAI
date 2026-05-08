/**
 * EverythinInAI — Chat API (Vercel Serverless Function)
 *
 * POST /api/chat
 *   body: { query: string, history?: Array<{role, text}> }
 *
 * Pipeline:
 *   1. Use Gemini to extract structured intent from the user query (category, capabilities, pricing)
 *   2. Query Supabase for matching tools (server-side via SUPABASE_SERVICE_KEY env var, NOT exposed)
 *   3. Use Gemini again to write a friendly response that introduces 3 best matches
 *   4. Return: { reply: string, tools: [{slug, name, tagline, url, ...}] }
 *
 * Env vars needed in Vercel project settings:
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_KEY
 *   - GEMINI_API_KEY
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const ALLOWED_CATEGORIES = [
  'LLM & Chat', 'Image Generation', 'Video Generation', 'Audio & Music',
  'Code Assistant', 'Writing & Content', 'Search & Research',
  'Productivity', 'Data Analysis', 'Agent & Automation',
  'Developer Tools', 'Voice & Speech', '3D & Design', 'Other',
];

interface Intent {
  category?: string;
  capabilities: string[];
  pricing_preference?: 'free' | 'open_source' | 'any';
  user_type?: string;
  search_terms: string[];
}

async function extractIntent(query: string): Promise<Intent> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');

  const prompt = `You're a router for an AI tools directory. Convert the user query into structured search intent.

USER QUERY: "${query}"

Return ONLY JSON, no prose, in this shape:
{
  "category": "<one of: ${ALLOWED_CATEGORIES.join(' | ')}, or null if unclear>",
  "capabilities": ["<3-5 short capability tags the tool should have>"],
  "pricing_preference": "<one of: 'free', 'open_source', 'any'>",
  "user_type": "<who the user is, e.g. 'developer', 'designer', 'student', 'founder'>",
  "search_terms": ["<2-4 terms to ILIKE-search across name/tagline/description>"]
}`;

  const r = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 500 },
    }),
  });

  const data: any = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  try {
    const parsed = JSON.parse(text);
    return {
      category: ALLOWED_CATEGORIES.includes(parsed.category) ? parsed.category : undefined,
      capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities.slice(0, 5) : [],
      pricing_preference: ['free', 'open_source', 'any'].includes(parsed.pricing_preference) ? parsed.pricing_preference : 'any',
      user_type: parsed.user_type || 'user',
      search_terms: Array.isArray(parsed.search_terms) ? parsed.search_terms.slice(0, 4) : [query],
    };
  } catch {
    return { capabilities: [], search_terms: [query], pricing_preference: 'any' };
  }
}

async function searchTools(supabase: any, intent: Intent): Promise<any[]> {
  // Build a smart query
  let q = supabase
    .from('tools')
    .select('slug, name, tagline, description, url, homepage, category, tags, pricing, upvotes')
    .eq('is_active', true);

  if (intent.category) {
    q = q.eq('category', intent.category);
  }

  if (intent.pricing_preference === 'free') {
    q = q.in('pricing', ['free', 'freemium', 'open_source']);
  } else if (intent.pricing_preference === 'open_source') {
    q = q.eq('pricing', 'open_source');
  }

  // ILIKE OR match on each search term — at least one term must hit
  const terms = (intent.search_terms || []).filter(t => t && t.length >= 2).slice(0, 4);
  if (terms.length > 0) {
    const orParts = terms.flatMap(t => {
      const safe = `%${t.replace(/[%_]/g, '\\$&')}%`;
      return [
        `name.ilike.${safe}`,
        `tagline.ilike.${safe}`,
        `description.ilike.${safe}`,
      ];
    });
    q = q.or(orParts.join(','));
  }

  const { data } = await q.order('upvotes', { ascending: false }).limit(10);
  return data || [];
}

async function generateReply(query: string, intent: Intent, tools: any[]): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');

  const toolsContext = tools.slice(0, 3).map((t, i) =>
    `${i + 1}. **${t.name}** (${t.category}, ${t.pricing}) — ${t.tagline}`
  ).join('\n');

  const prompt = `You are EverythinInAI's friendly tool-matching assistant. The user asked:

"${query}"

I found these top 3 matches in the directory:
${toolsContext || '(no matches found)'}

Write a SHORT 2-3 sentence reply that:
- Acknowledges what they want
- Introduces the top match in 1 sentence (why it fits)
- Mentions there are alternatives below
- Friendly, NOT corporate, conversational

If no tools were found, suggest broadening the search or list the closest categories.

Return ONLY the reply text, no markdown headers, no code blocks.`;

  const r = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 300 },
    }),
  });

  const data: any = await r.json();
  return (data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Here are some tools that might help.').trim();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS — allow same origin + dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  try {
    const { query } = req.body || {};
    if (!query || typeof query !== 'string' || query.length < 2) {
      return res.status(400).json({ error: 'Missing query' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'Supabase env vars missing' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    });

    const intent = await extractIntent(query);
    const tools = await searchTools(supabase, intent);
    const reply = await generateReply(query, intent, tools);

    return res.status(200).json({
      reply,
      tools: tools.slice(0, 3).map(t => ({
        slug: t.slug,
        name: t.name,
        tagline: t.tagline,
        category: t.category,
        pricing: t.pricing,
        url: t.homepage || t.url,
        sourceUrl: t.homepage && t.homepage !== t.url ? t.url : null,
      })),
      intent,
    });
  } catch (err: any) {
    console.error('[chat] error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
