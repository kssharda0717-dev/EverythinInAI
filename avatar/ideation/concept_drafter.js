/**
 * EverythinInAI — Concept Drafter
 *
 * Takes a chosen signal + persona DNA → asks Gemini 2.5 Flash to draft 3 distinct
 * Reel concepts (different angles: hot_take / explainer / humor). Returns
 * structured JSON ready to insert into reel_concepts.
 *
 * Each concept has:
 *   - title             (working title for review)
 *   - hook              (first 2s, hard pattern interrupt)
 *   - body_script       (15-20s, 3-4 micro-points)
 *   - punchline         (closing 5-8s + soft CTA)
 *   - keyframes         (3-5 scene plan with image prompts)
 *   - caption + hashtags
 *   - lure_level (1-4) and angle
 */

const axios = require('axios');
const { config } = require('../../engine/core/config');
const { createLogger } = require('../../engine/utils/logger');
const personaService = require('../persona/persona_service');

const log = createLogger('concept_drafter');

const GEMINI_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

function parseJSON(rawText) {
  // Try direct
  try { return JSON.parse(rawText); } catch {}
  // Try fenced
  const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  // Try first { ... } block
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  throw new Error(`Could not parse Gemini JSON. First 500 chars: ${rawText.substring(0, 500)}`);
}

function buildPrompt(persona, signal, lureLevel) {
  return `${persona.system_prompt}

═══════════════════════════════════════════════════════════════
TASK: Draft 3 distinct Reel concepts for the following signal.
═══════════════════════════════════════════════════════════════

SIGNAL:
- type: ${signal.type}${signal.subtype ? ' / ' + signal.subtype : ''}
- title: ${signal.title}
- summary: ${signal.summary || '(none)'}
- narrative: ${signal.narrative || '(none)'}
- url: ${signal.url}
- entities: ${(signal.entities || []).join(', ') || '(none)'}
- topics: ${(signal.topics || []).join(', ') || '(none)'}
- avatar_angles (suggestions from classifier): ${(signal.avatar_angles || []).join(', ') || '(none)'}
- virality_score (classifier): ${signal.virality_score}/10

LURE LEVEL FOR TODAY: ${lureLevel}/4
${lureLevel >= 3
  ? '→ This is a "magnet" Reel. Avi looks her best (editorial styling). Visually striking but never crosses into thirst-trap. Cleavage subtle, body-fitting outfits, studio lighting.'
  : '→ This is a "substance" Reel. Avi in an oversized blazer, ribbed knit, or fitted simple top. Focus is the IDEA, not the outfit. Cozy minimal apartment / library / coffee-shop setting.'}

REQUIREMENTS:
1. Generate exactly 3 distinct concept variants. Each MUST follow a different VIRAL FRAMEWORK to maximize retention on a new account.
   Choose 3 from these 5 frameworks:
   - Framework 1: SECRET_WEAPON (High Saves) - "Stop paying for [X]. Use this instead."
   - Framework 2: INDUSTRY_KILLER (High Shares) - "If you are a [Profession], this new AI is coming for your job."
   - Framework 3: I_TESTED_IT (High Watch Time) - "Everyone is talking about [Tool], so I actually tested it."
   - Framework 4: CONTRARIAN_TRUTH (High Comments) - "Everyone is using [Popular Tool] wrong."
   - Framework 5: SEAMLESS_LOOP (High Rewatch) - The last sentence must grammatically flow directly into the first sentence.

2. For each concept, return:
   - title: a working title (max 60 chars) — internal use
   - hook: 1-2 short punchy sentences (max 10 words). MUST stop the scroll instantly. BANNED PHRASES: "Hey guys", "Did you know", "Just saw", "Today I'm", "Look at this", "Yaar".
   - body_script: EXACTLY 1 or 2 short sentences delivering the pure value. NO FLUFF. NO FILLER. ~5-7 seconds at natural pace (~15-25 words).
   - punchline: The "Open Loop" ending. MUST NOT restate the body. End on a cliffhanger or controversial take. ~3 seconds.
   - cta: a short call-to-action like "Comment LINK and I'll DM you the repo".
   - full_script: the concatenation of hook + body_script + punchline + cta. YOU MUST INCLUDE THE CTA IN THE FULL_SCRIPT SO SHE SAYS IT OUT LOUD. Total script MUST BE UNDER 50 WORDS.
   - estimated_seconds: integer, target 8-15 seconds MAX.
   - b_roll_plan: array of 2 objects, each = {start_sec, end_sec, description}. Describe exactly what B-roll (screenshot, UI clip, meme) should interrupt the talking head. The first B-roll MUST start before second 3.
   - caption: Instagram caption, 2-3 lines, hook-style opening, soft CTA at end. Max 150 chars. Use 0-1 emojis.
   - hashtags: array of 5-8 hashtags. Mix of high-volume (#AI) and niche.
   - lure_level: integer matching today's lure level (${lureLevel}).
   - angle: the name of the viral framework used (e.g., "secret_weapon").

3. Each concept must be extremely FAST-PACED. The goal is >70% retention. No wasted words.

4. STRICTLY follow Rhea's voice rules. No banned phrases.

5. CRITICAL CTA RULES — the punchline AND the caption MUST end with one of these DM-funnel CTAs (pick the most natural):
   - "Comment LINK and I'll DM you the repo"
   - "Comment GUIDE and I'll DM you the breakdown"
   - "Comment RHEA and I'll DM you my notes on this"
   - "Comment YES and I'll DM you the demo"
   The CTA MUST direct viewers to comment a specific keyword to get a DM. NEVER use: "Link in bio", "What do you think", "Follow for more".

6. Caption MUST END with: "— everythinginai.com" on its own line.

7. Return ONLY valid JSON. No markdown fences. No prose outside the JSON.

OUTPUT SCHEMA:
{
  "concepts": [
    { "title": "...", "hook": "...", "body_script": "...", "punchline": "...", "full_script": "...", "estimated_seconds": 12, "b_roll_plan": [...], "caption": "...", "hashtags": [...], "cta": "...", "lure_level": ${lureLevel}, "angle": "secret_weapon" },
    { ... },
    { ... }
  ]
}`;
}

async function draftConcepts(signal, lureLevel = 2, retries = 2) {
  const persona = await personaService.getActivePersona();
  const prompt = buildPrompt(persona, signal, lureLevel);

  const apiKey = config.gemini.apiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');
  const model = config.gemini.model || 'gemini-2.5-flash';

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.85,         // creative for ideation
      topP: 0.95,
      maxOutputTokens: 8192,
    },
  };

  const estInputTokens = Math.ceil(prompt.length / 4);
  log.info(`Drafting concepts for signal "${signal.title.substring(0, 60)}" (~${estInputTokens} input tokens, lure=${lureLevel})`);

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await axios.post(GEMINI_URL(model), body, {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        timeout: 120_000,
      });

      const rawText = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = parseJSON(rawText);

      if (!parsed.concepts || !Array.isArray(parsed.concepts) || parsed.concepts.length === 0) {
        throw new Error('Gemini response missing "concepts" array');
      }

      const estOutputTokens = Math.ceil(rawText.length / 4);
      log.info(`✓ Drafted ${parsed.concepts.length} concepts (~${estOutputTokens} output tokens)`);

      return {
        concepts: parsed.concepts,
        meta: {
          model,
          prompt_tokens: estInputTokens,
          output_tokens: estOutputTokens,
        },
      };
    } catch (err) {
      lastErr = err;
      const msg = err.response?.data?.error?.message || err.message;
      log.warn(`Attempt ${attempt + 1} failed: ${msg}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }

  throw new Error(`Concept drafting failed after ${retries + 1} attempts: ${lastErr?.message}`);
}

module.exports = { draftConcepts };
