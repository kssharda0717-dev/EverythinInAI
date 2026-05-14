/**
 * EverythinInAI — Inspire Analyzer
 *
 * Watches a reference video (Instagram reel forwarded by the user) and returns
 * structured render instructions so the lifestyle pipeline can render a
 * Rhea-version of the same vibe.
 *
 * Output schema:
 *   {
 *     keyframe_prompt:   string  // Flux+LoRA prompt for the static hero frame
 *     motion_prompt:     string  // Kling motion description
 *     music_mood:        'upbeat' | 'calm' | 'energetic' | 'dramatic' | 'romantic'
 *     scene_summary:     string  // 2-3 sentences describing what we saw
 *     duration_sec:      number  // duration of the source video
 *     suggested_outfit:  string  // outfit Rhea should wear (color, style)
 *     suggested_location: string // where Rhea should be (gym, balcony, cafe, ...)
 *     caption:           string  // suggested IG caption
 *     hashtags:          string[]
 *   }
 *
 * Strategy: we let Gemini-2.5-pro handle the video natively (Gemini accepts
 * MP4 inputs up to ~50MB or via file API for larger). We DO NOT clone the
 * exact choreography — instead we describe the MOOD/SCENE/ACTION TYPE so
 * Kling can render Rhea's own version.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { config } = require('../../engine/core/config');
const { createLogger } = require('../../engine/utils/logger');
const {
  CANONICAL_LOOK,
  COMPLEXION_NEGATIONS,
  LIFESTYLE_DIGNITY_ANCHOR,
} = require('../persona/canonical_look');

const log = createLogger('inspire_analyzer');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Upload a local video file to Gemini's file API. Returns the file resource
 * URI which can then be referenced in a generateContent call. Required for
 * any video over ~20MB inline.
 */
async function uploadVideoToGemini(localPath, apiKey) {
  const stat = fs.statSync(localPath);
  const sizeBytes = stat.size;
  log.info(`Uploading ${(sizeBytes / 1024 / 1024).toFixed(1)} MB video to Gemini File API...`);

  // Step 1: start resumable upload session
  const startResp = await axios.post(
    `${GEMINI_BASE}/files?key=${apiKey}`,
    { file: { display_name: path.basename(localPath) } },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': sizeBytes,
        'X-Goog-Upload-Header-Content-Type': 'video/mp4',
      },
      timeout: 30_000,
    }
  );
  const uploadUrl = startResp.headers['x-goog-upload-url'];
  if (!uploadUrl) throw new Error('Gemini did not return an upload URL');

  // Step 2: upload the bytes
  const buf = fs.readFileSync(localPath);
  const uploadResp = await axios.post(uploadUrl, buf, {
    headers: {
      'Content-Length': sizeBytes,
      'X-Goog-Upload-Offset': 0,
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 300_000,
  });

  const file = uploadResp.data?.file;
  if (!file?.uri) throw new Error('Gemini upload did not return a file URI');

  // Step 3: wait for the file to become ACTIVE (async processing)
  let state = file.state;
  let pollUri = `${GEMINI_BASE}/${file.name}?key=${apiKey}`;
  let attempts = 0;
  while (state !== 'ACTIVE' && attempts < 30) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await axios.get(pollUri, { timeout: 10_000 });
    state = poll.data.state;
    attempts++;
  }
  if (state !== 'ACTIVE') {
    throw new Error(`Gemini file did not become ACTIVE after ${attempts} polls (state=${state})`);
  }

  log.info(`✓ Uploaded. URI: ${file.uri}`);
  return { uri: file.uri, mimeType: 'video/mp4', name: file.name };
}

/**
 * Delete the uploaded file (best-effort cleanup).
 */
async function deleteGeminiFile(name, apiKey) {
  try {
    await axios.delete(`${GEMINI_BASE}/${name}?key=${apiKey}`, { timeout: 10_000 });
  } catch (e) {
    log.warn(`Could not delete Gemini file ${name}: ${e.message}`);
  }
}

/**
 * Build the analysis prompt for Gemini. This is the heart of the system —
 * we ask Gemini to translate the source reel into render instructions for
 * Rhea, NOT to clone it.
 */
function buildAnalysisPrompt() {
  return `You are a senior content strategist for an Indian Instagram avatar called Rhea Kapoor (25, IIT-Mumbai grad, Goldman Sachs analyst, Bandra Mumbai). Watch the attached reference reel carefully.

Your job: produce structured render instructions so we can create RHEA'S OWN VERSION of this reel — same MOOD, same VIBE, same TYPE OF SCENE, but with RHEA performing it. Do NOT clone the exact choreography frame-by-frame. Capture the FEEL, not the FRAMES.

Rhea's locked identity (this is fixed — your prompts must respect it):
${CANONICAL_LOOK}

Rhea's lifestyle dignity register (also fixed):
${LIFESTYLE_DIGNITY_ANCHOR}

Watch the reel and return a JSON object with EXACTLY these fields:

{
  "scene_summary": "2-3 sentences describing what happens in the source reel (the mood, the setting, the action arc).",
  "duration_sec": "estimated duration of the source video in seconds (number).",
  "music_mood": "one of: upbeat | calm | energetic | dramatic | romantic | sensual | melancholy",
  "suggested_location": "Where should Rhea be filmed. Pick a SPECIFIC realistic location that captures the same vibe as the source. Examples: 'in her own home gym at night with neon purple LED lights', 'on her Bandra apartment balcony at golden hour', 'in a Mumbai art-gallery cafe', 'getting ready at her vanity'. NOT a vague 'in a gym'.",
  "suggested_outfit": "What Rhea should wear. MUST respect lifestyle dignity (no bralette alone, no lingerie alone, hint of decolletage/shoulder/midriff in saree allowed in scene context). Use a SPECIFIC color and style (e.g., 'fitted black athletic crop tank with high-waisted leggings, hair in slick high ponytail').",
  "keyframe_prompt": "A complete Flux+LoRA image prompt for the static hero frame. MUST start with: 'Real DSLR photograph of AVI_TOK woman, a 25-year-old Indian content creator. Identity: ${CANONICAL_LOOK}.' Then describe Rhea in the suggested_location wearing the suggested_outfit, in the action moment that captures the source reel's hook. End with cinematic photographic style anchor.",
  "motion_prompt": "A Kling video motion description (1-3 sentences). Describe the CAMERA movement, the action Rhea performs, and any background motion. Examples: 'slow camera dolly in toward Rhea while she walks confidently, hair flowing with the motion, neon lights pulsing softly behind' or 'static medium-shot of Rhea reading a book on her balcony, gentle breeze moving her hair, golden sunset light shifting'. Do NOT describe specific dance moves frame by frame; describe the OVERALL motion arc.",
  "caption": "Instagram caption (max 150 chars). Magnetic, slightly mysterious, matches the source reel's energy. NOT generic AI-tool talk. Match Rhea's brand: smart, magnetic, intellectual, desirable.",
  "hashtags": ["array", "of", "5-8", "lifestyle", "or", "topic", "hashtags"]
}

CRITICAL RULES:
- Rhea must look like Rhea (canonical look anchored). DO NOT describe a different face/skin/hair.
- Use the source reel's MOOD as ground truth, not its content. If the source is a dance, Rhea should be in a similar movement but doing HER own thing. If the source is a getting-ready vlog, Rhea should be doing her own getting-ready.
- The motion_prompt should produce something Kling can render reliably (smooth motion, single subject, no fast cuts).
- The keyframe_prompt should produce a single hero frame that captures the most magnetic moment of what Rhea will do.
- If the source reel has cleavage / heavy thirst-trap framing, Rhea's version MUST be tasteful (use the dignity anchor).

Return ONLY the JSON object, nothing else.`;
}

/**
 * Main entry point.
 *
 * @param {Object} params
 * @param {string} params.localVideoPath - path to a local mp4 file to analyze
 * @returns {Promise<Object>} the structured analysis
 */
async function analyzeVideo({ localVideoPath }) {
  const apiKey = config.gemini.apiKey;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');

  // Upload the video to Gemini
  const uploaded = await uploadVideoToGemini(localVideoPath, apiKey);

  try {
    // Call generateContent with the file ref
    const model = 'gemini-2.5-pro';  // pro for video understanding quality
    const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      contents: [{
        parts: [
          { fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType } },
          { text: buildAnalysisPrompt() },
        ],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.4,  // slightly creative but mostly deterministic
        topP: 0.9,
        maxOutputTokens: 4096,
      },
    };

    log.info(`Calling Gemini ${model} for video analysis...`);
    const resp = await axios.post(url, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 180_000,
    });

    const raw = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (!m) throw new Error(`Could not parse Gemini JSON. First 300 chars: ${raw.substring(0, 300)}`);
      parsed = JSON.parse(m[0]);
    }

    // Validate required fields
    const required = ['scene_summary', 'music_mood', 'suggested_location', 'suggested_outfit', 'keyframe_prompt', 'motion_prompt'];
    for (const f of required) {
      if (!parsed[f]) throw new Error(`Gemini response missing required field: ${f}`);
    }

    // Reinforce: append complexion negations to keyframe prompt as a safety net.
    if (!parsed.keyframe_prompt.includes('#A17B63')) {
      parsed.keyframe_prompt = `${parsed.keyframe_prompt} ${COMPLEXION_NEGATIONS}`;
    }

    log.info(`✓ Analysis complete. Mood=${parsed.music_mood}, Location=${parsed.suggested_location.slice(0, 60)}`);
    return parsed;
  } finally {
    // Best-effort cleanup of the uploaded file
    await deleteGeminiFile(uploaded.name, apiKey);
  }
}

module.exports = { analyzeVideo };
