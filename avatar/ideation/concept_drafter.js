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

function buildPrompt(persona, signal, lureLevel, perfStats, activeFrameworks, streamType, trends, travel, recentAngles) {
  let perfBlock = '';
  if (perfStats && perfStats.length > 0) {
    perfBlock = `
═══════════════════════════════════════════════════════════════
ANALYTICS FEEDBACK (LAST 14 DAYS - CONFIDENCE WEIGHTED):
The following frameworks have been tested on Instagram. 
Ranked by Average Retention Rate (higher is better):
${perfStats.map(s => `- ${s.framework}: ${s.avgRetention}% retention (Sample size: ${s.sampleSize} reels)`).join('\n')}

STRATEGIST INSTRUCTIONS:
1. If a framework has high retention (>30%) AND a good sample size (>=2), use it.
2. If a framework has low retention (<15%) AND a good sample size (>=2), DO NOT use it.
3. EXPLORE MODE: If a framework is NOT listed above, or has a sample size of 1, you MUST try it today to gather more data.
═══════════════════════════════════════════════════════════════
`;
  }

  let trendsBlock = '';
  if (trends && trends.length > 0) {
    trendsBlock = `
═══════════════════════════════════════════════════════════════
TRENDING FORMATS THIS WEEK ON INSTAGRAM (FOR YOUR STREAM):
Incorporate these stylistic choices into your concepts to boost algorithmic reach:
${trends.map(t => `- [${t.pattern_type.toUpperCase()}] ${t.pattern} (e.g., "${t.example}")`).join('\n')}
═══════════════════════════════════════════════════════════════
`;
  }

  let travelBlock = '';
  if (streamType === 'lifestyle' && travel) {
    travelBlock = `
═══════════════════════════════════════════════════════════════
RHEA'S CURRENT TRAVEL STATUS:
Rhea is currently traveling! Set all lifestyle concepts in this location.
Location: ${travel.location}
Vibe: ${travel.vibe || 'adventure'}
Planned Activities: ${(travel.planned_activities || []).join(', ')}
Notes: ${travel.notes || 'none'}
═══════════════════════════════════════════════════════════════
`;
  }

  // ========================================================================
  // FRAMEWORK RECENCY ROTATION
  // recentAngles = the last 5 winning angles for this stream (newest first).
  // We split the active framework registry into FRESH (not used recently)
  // vs RECENT (used in last 5 winners). The LLM is told to pick from FRESH
  // first and only fall back to RECENT if there are not enough FRESH ones.
  // This guarantees rotation across the full registry instead of getting
  // locked onto the same 3 frameworks Gemini naturally gravitates toward.
  // ========================================================================
  const recentSet = new Set((recentAngles || []).filter(Boolean));
  const fresh = activeFrameworks.filter(f => !recentSet.has(f.slug));
  const recent = activeFrameworks.filter(f => recentSet.has(f.slug));

  const fmt = (f) => `- ${f.slug} (${f.display_name}): ${f.prompt_template} (Example: "${f.example_hook}")`;

  const freshList = fresh.length ? fresh.map(fmt).join('\n') : '(none — all frameworks have been used recently, fall back to RECENT pool)';
  const recentList = recent.length ? recent.map(fmt).join('\n') : '(none yet)';

  const recentAnglesLine = recentAngles && recentAngles.length
    ? `LAST ${recentAngles.length} WINNING ANGLES (NEWEST FIRST): ${recentAngles.join(' → ')}`
    : 'LAST WINNING ANGLES: (none yet)';

  const frameworksList = `${recentAnglesLine}\n\n=== FRESH FRAMEWORKS (PREFER THESE — they have NOT been used in the last 5 winners) ===\n${freshList}\n\n=== RECENT FRAMEWORKS (avoid unless FRESH pool is empty) ===\n${recentList}\n\nROTATION RULE (HARD): Each of your 3 concepts MUST use a DIFFERENT framework slug from the FRESH pool above. Only fall back to a RECENT framework if FRESH has fewer than 3 entries. NEVER use the same framework as the most recent winner (${recentAngles && recentAngles[0] ? recentAngles[0] : 'n/a'}).`;

  let taskBlock = '';
  let outputSchema = '';

  if (streamType === 'tech') {
    taskBlock = `
TASK: Draft 3 distinct Tech Reel concepts for the following signal.
═══════════════════════════════════════════════════════════════

SIGNAL:
- type: ${signal.type}${signal.subtype ? ' / ' + signal.subtype : ''}
- title: ${signal.title}
- summary: ${signal.summary || '(none)'}
- url: ${signal.url}

REQUIREMENTS:
1. Choose 3 DIFFERENT frameworks from this active registry:
${frameworksList}

2. For each concept, return:
   - title: working title (max 60 chars)
   - hook: 1-2 short punchy sentences. MUST stop scroll. BANNED: "Hey guys", "Did you know", "Just saw".
   - body_script: EXACTLY 1-2 short sentences delivering pure value. NO FLUFF.
   - punchline: Open loop ending. MUST NOT restate body.
   - cta: A natural, conversational CTA. MUST NOT always be "Comment X and I'll DM you". Use variety like: "Drop the word X below and I'll send it over", "Want the link? Comment X", "Type X in the comments for the full breakdown".
   - full_script: hook + body_script + punchline + cta. MUST BE UNDER 50 WORDS.
   - estimated_seconds: 8-15.
   - b_roll_plan: array of {start_sec, end_sec, description}. First B-roll MUST start before second 3.
   - caption: Instagram caption. Max 150 chars.
   - hashtags: array of 5-8 hashtags.
   - angle: the slug of the framework used.
   - lure_level: ${lureLevel}.

3. CRITICAL CTA RULES: The script AND caption MUST end with a DM-funnel CTA (asking them to comment a keyword). NEVER use "Link in bio". Vary the phrasing so it sounds natural, not robotic.

4. PAIN HOOK GUIDANCE: If using the 'pain_hook' framework, identify the specific frustration AI builders have about this topic (e.g., slow RAG, expensive API bills) and weaponise it in the first 10 words.
`;
    outputSchema = `{
  "concepts": [
    { "title": "...", "hook": "...", "body_script": "...", "punchline": "...", "full_script": "...", "estimated_seconds": 12, "b_roll_plan": [...], "caption": "...", "hashtags": [...], "cta": "...", "lure_level": ${lureLevel}, "angle": "secret_weapon" }
  ]
}`;
  } else if (streamType === 'lure') {
    taskBlock = `
TASK: Draft 3 distinct Lure Photo concepts for Friday.
═══════════════════════════════════════════════════════════════

REQUIREMENTS:
1. Choose 3 DIFFERENT frameworks from this active registry:
${frameworksList}

2. For each concept, return:
   - title: working title
   - image_prompt: A highly detailed image generation prompt describing the scene, lighting, outfit, and vibe based on the framework. Must include "Real DSLR photograph of AVI_TOK woman, a 25-year-old Indian content creator."
   - caption: Instagram caption matching the vibe.
   - hashtags: array of 5-8 lifestyle/aesthetic hashtags.
   - angle: the slug of the framework used.
   - lure_level: ${lureLevel}.
`;
    outputSchema = `{
  "concepts": [
    { "title": "...", "image_prompt": "...", "caption": "...", "hashtags": [...], "lure_level": ${lureLevel}, "angle": "mirror_selfie_classy" }
  ]
}`;
  } else if (streamType === 'lifestyle') {
    taskBlock = `
TASK: Draft 3 distinct Lifestyle Action Video concepts for the weekend.
═══════════════════════════════════════════════════════════════

REQUIREMENTS:
1. Choose 3 DIFFERENT frameworks from this active registry:
${frameworksList}

2. For each concept, return:
   - title: working title
   - keyframe_prompt: A highly detailed image prompt for the static starting frame. Must include "Real DSLR photograph of AVI_TOK woman, a 25-year-old Indian content creator."
   - motion_prompt: Instructions for the AI video generator on how to animate the keyframe (e.g., "smooth camera pan, hair blowing in wind, lifting kettlebell").
   - music_mood: 'upbeat', 'calm', or 'energetic'.
   - caption: Instagram caption.
   - hashtags: array of 5-8 lifestyle hashtags.
   - angle: the slug of the framework used.
   - lure_level: ${lureLevel}.
`;
    outputSchema = `{
  "concepts": [
    { "title": "...", "keyframe_prompt": "...", "motion_prompt": "...", "music_mood": "upbeat", "caption": "...", "hashtags": [...], "lure_level": ${lureLevel}, "angle": "gym_workout" }
  ]
}`;
  }

  // Inject the rich Persona Bible if available, else fallback to system_prompt
  const personaContext = persona.bible_md 
    ? `You are writing content for the following persona:\n\n${persona.bible_md}\n\nBUSINESS GOAL: We are below 10k followers. Every reel must drive saves and follows aggressively. Every Friday lure post must tease the future subscription tier.`
    : persona.system_prompt;

  // ========================================================================
  // BRAND VOICE GUARDRAILS — Non-negotiable rules every concept MUST follow
  // These are the difference between "random AI bikini page" and a magnetic
  // multi-dimensional brand like Kiara Advani / Tara Sutaria.
  // ========================================================================
  const brandGuardrails = `
BRAND VOICE GUARDRAILS (NON-NEGOTIABLE — every concept MUST obey ALL of these):

1. CONTEXT IS KING. Every visual prompt MUST include a SPECIFIC place + activity + prop.
   GOOD: "sitting at a chic Bandra cafe holding a matcha latte, MacBook open with code on screen"
   BAD:  "smiling at the camera in a white dress" (no context, no activity)

2. NEVER A BODY SHOT — ALWAYS A LIFESTYLE MOMENT.
   The body must be incidental to the moment. Even bold/bikini scenes must have a justifying CONTEXT
   (a beach, a luxury pool, a spa, a yacht) and at least ONE element of taste
   (a coffee cup, a hardcover book, oversized sunglasses, a glass of champagne).
   BANNED: bedroom-only thirst traps, random face close-ups, "come hither" bedroom poses.

3. EDITORIAL-GRADE LANGUAGE in every visual prompt:
   USE: "Vogue India editorial", "Bollywood-actress-tier", "magazine cover quality",
        "paparazzi flash candid", "high-fashion editorial", "shot on Sony A7R IV"
   AVOID: "selfie" (unless mirror selfie at vanity), "cute", "sexy", "hot".

4. INTELLECTUAL MAGNETISM. Rhea is the IIT-Goldman engineer who turns heads at rooftops.
   Her desirability comes from being EXTREMELY SMART + EXTREMELY HOT.
   Concepts should reflect this duality: she reads AI papers in a bikini at an infinity pool.

5. CULTURALLY ROOTED. Lean into traditional Indian (saree, lehenga, festivals) at least once per week.
   This sets her apart from western AI influencers and unlocks brand deals from Indian fashion/beauty.

6. ASPIRATIONAL WEALTH SIGNALS. Every shot should subtly signal lifestyle wealth:
   luxury car, business class, Porsche steering wheel, Celine sunglasses, omakase counter,
   art gallery, infinity pool, vintage Ambassador car.

7. "TALK OF THE TOWN" ENERGY. Each concept must answer: would this be the post EVERY person
   in her circle texts a friend about the next morning? If not, rewrite it.

BANNED FRAMINGS: "just a face close-up", "bedroom only", "random dance", "just a smile",
"just looking at camera", "posing", "thirst trap", "come hither".
`;

  return `${personaContext}
${brandGuardrails}
${perfBlock}
${trendsBlock}
${travelBlock}
${taskBlock}

Return ONLY valid JSON matching this schema:
${outputSchema}
`;
}

async function getPerformanceStats() {
  try {
    const db = require('../../engine/core/database').getClient();
    // Decay: Only look at the last 14 days so old trends don't dominate
    const fourteenDaysAgo = new Date(Date.now() - 14*24*60*60*1000).toISOString();
    const { data: rows } = await db.from('reel_performance')
      .select('framework, views, avg_watch_sec, retention_pct')
      .gte('recorded_at', fourteenDaysAgo);
    
    if (!rows || rows.length === 0) return null;

    const agg = {};
    for (const r of rows) {
      const f = r.framework || 'unknown';
      if (!agg[f]) agg[f] = { count: 0, views: 0, watch: 0, retention: 0 };
      agg[f].count++;
      agg[f].views += r.views || 0;
      agg[f].watch += parseFloat(r.avg_watch_sec) || 0;
      agg[f].retention += parseFloat(r.retention_pct) || 0;
    }

    return Object.entries(agg)
      .map(([f, a]) => ({
        framework: f,
        sampleSize: a.count,
        avgViews: Math.round(a.views / a.count),
        avgWatch: (a.watch / a.count).toFixed(1),
        avgRetention: (a.retention / a.count).toFixed(1),
      }))
      .sort((a, b) => parseFloat(b.avgRetention) - parseFloat(a.avgRetention));
  } catch (err) {
    log.warn(`Failed to fetch performance stats: ${err.message}`);
    return null;
  }
}

async function draftConcepts(signal, lureLevel = 2, streamType = 'tech', retries = 2) {
  const persona = await personaService.getActivePersona();
  const perfStats = await getPerformanceStats();
  
  const db = require('../../engine/core/database').getClient();
  const { data: activeFrameworks } = await db.from('content_frameworks')
    .select('*')
    .eq('stream', streamType)
    .eq('is_active', true);
    
  if (!activeFrameworks || activeFrameworks.length === 0) {
    throw new Error(`No active frameworks found for stream: ${streamType}`);
  }

  // Pull trending formats for this stream
  const { data: trends } = await db.from('trending_formats')
    .select('pattern_type, pattern, example')
    .eq('stream', streamType)
    .order('ingested_at', { ascending: false })
    .limit(5);

  // Pull travel calendar if applicable
  let travel = null;
  if (streamType === 'lifestyle') {
    const today = new Date().toISOString().slice(0, 10);
    const { data: t } = await db.from('travel_calendar')
      .select('*')
      .lte('start_date', today)
      .gte('end_date', today)
      .maybeSingle();
    travel = t;
  }

  // ========================================================================
  // Pull the last 5 WINNING angles for this stream so we can rotate frameworks.
  // We look at is_winner=true rows because that's what actually shipped to IG.
  // If the user hasn't picked winners recently, fall back to the most recent
  // 5 concepts of any state (still drafted by us, still in our history).
  // ========================================================================
  // content_type uses suffixed values: 'tech_reel' / 'lure_photo' / 'lifestyle_reel'
  // streamType uses bare values:        'tech'      / 'lure'       / 'lifestyle'
  // Map between them for the recency query.
  const STREAM_TO_CONTENT_TYPE = {
    tech: 'tech_reel',
    lure: 'lure_photo',
    lifestyle: 'lifestyle_reel',
  };
  const contentTypeForQuery = STREAM_TO_CONTENT_TYPE[streamType] || streamType;

  let recentAngles = [];
  try {
    const { data: winners } = await db.from('reel_concepts')
      .select('angle, created_at')
      .eq('content_type', contentTypeForQuery)
      .eq('is_winner', true)
      .order('created_at', { ascending: false })
      .limit(5);
    recentAngles = (winners || []).map(w => w.angle).filter(Boolean);

    // Fallback: if we don't have 5 winners yet, fill from any recent concepts.
    if (recentAngles.length < 5) {
      const { data: anyRecent } = await db.from('reel_concepts')
        .select('angle')
        .eq('content_type', contentTypeForQuery)
        .order('created_at', { ascending: false })
        .limit(10);
      const extras = (anyRecent || []).map(r => r.angle).filter(Boolean);
      for (const a of extras) {
        if (recentAngles.length >= 5) break;
        if (!recentAngles.includes(a)) recentAngles.push(a);
      }
    }
    log.info(`Recent angles for ${streamType}: [${recentAngles.join(', ')}] — ${activeFrameworks.length - recentAngles.length} fresh frameworks available`);
  } catch (err) {
    log.warn(`Could not fetch recent angles for rotation: ${err.message}`);
  }

  const prompt = buildPrompt(persona, signal, lureLevel, perfStats, activeFrameworks, streamType, trends, travel, recentAngles);

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

      // ===== HARD-FIX: deterministic full_script assembly =====
      // The LLM sometimes drops the CTA from full_script even when cta field exists.
      // We rebuild full_script in code so TTS ALWAYS speaks the CTA.
      for (const c of parsed.concepts) {
        if (streamType === 'tech' && c.hook && c.body_script && c.punchline) {
          const parts = [c.hook, c.body_script, c.punchline];
          if (c.cta && typeof c.cta === 'string' && c.cta.trim()) {
            parts.push(c.cta);
          }
          c.full_script = parts.join(' ').replace(/\s+/g, ' ').trim();
        }
      }

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
