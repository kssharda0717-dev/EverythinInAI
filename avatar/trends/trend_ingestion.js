#!/usr/bin/env node
/**
 * EverythinInAI — Trend Ingestion Engine (Format-only)
 *
 * Runs weekly. Asks Gemini Pro to identify the FORMATS (not topics) that are
 * currently going viral on Instagram for tech, fashion/lure, and travel/lifestyle.
 *
 * Stores distilled patterns in `trending_formats` so the concept_drafter can
 * apply trending hook structures, edit styles, aesthetics, and audio to OUR
 * own content topics (which always come from our scraper / persona / travel).
 *
 * Why we don't actually scrape Instagram: Meta blocks scraping aggressively.
 * Instead we ask Gemini Pro (which has near-realtime knowledge via search
 * grounding) to summarize the trending FORMATS in each niche based on its
 * up-to-date training and search context. This is good enough for the LLM
 * to incorporate trend-aware execution without infrastructure overhead.
 */

const axios = require('axios');
const dbModule = require('../../engine/core/database');
const { config } = require('../../engine/core/config');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('trend_ingestion');

const GEMINI_URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const TREND_TTL_DAYS = 14; // patterns auto-expire after 14 days

const STREAM_PROMPTS = {
  tech: `Analyze the current viral content patterns on Instagram for AI/tech/startup creators in the last 14 days.
DO NOT report on what topics they cover. ONLY report on FORMATS:
- Hook patterns (e.g., "Stop using X", "POV: you just discovered Y", "I tested 5 tools")
- Edit/visual styles (e.g., "1.5s jump cuts", "captions in lowercase Inter font", "screen recordings with arrow overlays")
- Caption patterns (e.g., "no emojis, just em-dashes", "single-line captions with one CTA")
- CTA patterns (e.g., "comment SAVE", "double tap if you agree")
- Audio styles (e.g., "lo-fi piano", "trending instrumental beats")`,
  
  lure: `Analyze the current viral content patterns on Instagram for fashion/lifestyle/lure female creators in the last 14 days.
DO NOT report on what topics they cover. ONLY report on FORMATS:
- Photo angles (e.g., "low-angle mirror selfies", "over-the-shoulder candids", "POV from above")
- Aesthetic/color palette (e.g., "warm beige + cream", "moody emerald + brass", "soft pastel")
- Outfit categories trending (e.g., "clean girl minimalist", "old money", "coastal grandma")
- Caption styles (e.g., "single witty line", "lowercase only", "song lyric reference")
- Locations/settings trending (e.g., "elevator mirrors", "cafe windows", "balcony at golden hour")`,
  
  lifestyle: `Analyze the current viral content patterns on Instagram for travel/lifestyle/female adventure creators in the last 14 days.
DO NOT report on specific destinations. ONLY report on FORMATS:
- Video styles (e.g., "slow-mo drone reveals", "POV walking shots", "transition cuts to outfit changes")
- Activities trending (e.g., "ice baths", "sunrise pilates", "surf lessons")
- Music/audio (e.g., "indie folk acoustic", "Bollywood remix", "ambient cinematic")
- Caption patterns (e.g., "one-word captions", "carousel-style storytelling")
- Visual aesthetics (e.g., "warm grain filter", "high contrast cinematic", "cool blue tones")`,
};

async function distillTrends(stream) {
  const apiKey = config.gemini.apiKey;
  const model = 'gemini-2.5-flash';

  const prompt = `${STREAM_PROMPTS[stream]}

Return EXACTLY 8-12 distinct format patterns as JSON.
Each pattern object has:
  - pattern_type: one of 'hook_format', 'edit_style', 'aesthetic', 'audio', 'caption_style', 'location_setting', 'activity'
  - pattern: a clear, specific description (max 25 words)
  - example: a concrete example (max 25 words)

Output schema:
{
  "patterns": [
    { "pattern_type": "...", "pattern": "...", "example": "..." }
  ]
}
`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
  };

  log.info(`Asking Gemini for trending ${stream} formats...`);
  const resp = await axios.post(GEMINI_URL(model), body, {
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    timeout: 90_000,
  });

  const rawText = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  let parsed;
  try {
    parsed = JSON.parse(rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
  } catch (err) {
    throw new Error(`Failed to parse Gemini JSON for ${stream}: ${err.message}`);
  }

  return parsed.patterns || [];
}

async function main() {
  const db = dbModule.getClient();
  log.info('Starting Trend Ingestion...');

  // First, prune expired patterns
  const cutoff = new Date(Date.now() - TREND_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { count: pruned } = await db.from('trending_formats')
    .delete({ count: 'exact' })
    .lt('ingested_at', cutoff);
  log.info(`Pruned ${pruned || 0} expired patterns (>${TREND_TTL_DAYS}d old).`);

  for (const stream of ['tech', 'lure', 'lifestyle']) {
    try {
      const patterns = await distillTrends(stream);
      log.info(`Got ${patterns.length} ${stream} patterns.`);

      const expiresAt = new Date(Date.now() + TREND_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const records = patterns.map(p => ({
        stream,
        pattern_type: p.pattern_type || 'unknown',
        pattern: p.pattern,
        example: p.example,
        expires_at: expiresAt,
      }));

      const { error } = await db.from('trending_formats').insert(records);
      if (error) {
        log.error(`Failed to insert ${stream} patterns: ${error.message}`);
      } else {
        log.info(`✓ Inserted ${records.length} ${stream} patterns.`);
      }
    } catch (err) {
      log.error(`Failed to ingest ${stream} trends: ${err.message}`);
    }
  }

  log.info('Trend ingestion complete.');
}

if (require.main === module) {
  main().catch(err => {
    log.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
