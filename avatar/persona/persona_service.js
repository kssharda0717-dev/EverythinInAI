/**
 * EverythinInAI — Persona Service
 *
 * Thin library that every avatar component imports to fetch the active persona DNA.
 * Caches the persona row for 5 min so we're not hammering Supabase on every Reel build.
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('persona');

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { row: null, fetchedAt: 0 };

/**
 * Get the active persona. If no slug is passed, reads current_persona_slug from
 * system_settings (default: 'avi').
 */
async function getActivePersona(slug) {
  // Resolve slug from settings if not provided
  if (!slug) {
    try {
      const db0 = dbModule.getClient();
      const { data: setting } = await db0.from('system_settings').select('value').eq('key', 'current_persona_slug').maybeSingle();
      slug = (setting && setting.value) ? String(setting.value).replace(/"/g, '') : 'avi';
    } catch {
      slug = 'avi';
    }
  }

  if (cache.row && cache.row.slug === slug && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.row;
  }

  const db = dbModule.getClient();
  const { data, error } = await db
    .from('personas')
    .select('*')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    log.error(`Failed to fetch persona ${slug}: ${error.message}`);
    throw error;
  }

  if (!data) {
    throw new Error(`No active persona found with slug "${slug}". Run avi_seed.js first.`);
  }

  cache = { row: data, fetchedAt: Date.now() };
  return data;
}

/**
 * Build the system prompt for any Gemini call.
 * Optionally append a task-specific suffix (e.g. "Now write a caption for this Reel:").
 */
async function buildSystemPrompt(taskSuffix = '') {
  const persona = await getActivePersona();
  return persona.system_prompt + (taskSuffix ? '\n\n' + taskSuffix : '');
}

/**
 * Build a visual prompt header (the first part of every SDXL prompt).
 * Image worker prepends this to scene-specific prompts so identity is locked.
 */
async function buildVisualPromptHeader() {
  const persona = await getActivePersona();
  return persona.visual_descriptor;
}

/**
 * Get the negative prompt — things we never want to see in any image.
 */
async function buildNegativePrompt() {
  const persona = await getActivePersona();
  const forbidden = (persona.forbidden_visuals || []).join(', ');
  // Heavy anti-stylization + anti-lure tokens. Order matters — most-critical first.
  return [
    // Anti-cartoon (CRITICAL — PuLID-Flux drifts here without explicit suppression)
    'cartoon, anime, illustration, painting, drawing, sketch, digital art, 3d render, cgi, pixar, disney, stylized, manga, comic, vector art, cel shading, smooth skin render',
    // Anti-lure / wardrobe drift (Avi at lure 2 must be modest)
    'cleavage, plunging neckline, low-cut top, deep v-neck, bare chest, exposed chest, lingerie, bikini, bra, swimwear, off-shoulder, strapless, bare back, nudity, sexual',
    // Anatomy fixes
    'deformed, distorted, mutated, extra limbs, extra fingers, missing fingers, fused fingers, long neck, bobblehead, tiny head, oversized head, wrong proportions, asymmetric eyes, lazy eye, crossed eyes',
    // Face quality
    'blurry face, plastic skin, doll-like, porcelain skin, airbrushed, overprocessed, beauty filter, instagram filter, makeup mask, fake eyelashes, heavy makeup',
    // Image quality
    'watermark, text, logo, signature, jpeg artifacts, low quality, low resolution, oversaturated, undersaturated, harsh shadows, phone flash, ring light reflection, mirror selfie, bathroom selfie',
    // Identity drift
    'multiple people, two faces, twin, clone',
    // Persona-specific forbidden visuals (from DB)
    forbidden,
  ].filter(Boolean).join(', ');
}

/**
 * Pick a signature gesture for the current Reel (varies output naturally).
 */
async function pickSignatureGesture() {
  const persona = await getActivePersona();
  const gestures = persona.signature_gestures || [];
  if (gestures.length === 0) return '';
  return gestures[Math.floor(Math.random() * gestures.length)];
}

/**
 * Pick an aesthetic anchor (color/setting palette) for variety.
 */
async function pickAestheticContext() {
  const persona = await getActivePersona();
  const anchors = persona.aesthetic_anchors || [];
  if (anchors.length === 0) return '';
  // Pick 3-4 anchors at random for the scene
  const shuffled = [...anchors].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 4).join(', ');
}

/**
 * Decide the lure level for the next Reel based on weekly quota.
 * Returns 1-4 (Avi's max is 4).
 *
 * @param {number} recentLureCount - high-lure (>=3) reels posted in the last 7 days
 * @param {string} streamType - 'tech' | 'lure' | 'lifestyle'.
 *   Tech reels ENFORCE a minimum of 2 (lure-1 hooks read as boring on a news reel).
 *   Lure / lifestyle streams can dip to 1 when weekly quota is hit.
 */
async function chooseLureLevel(recentLureCount = 0, streamType = 'tech') {
  const persona = await getActivePersona();
  const quota = persona.weekly_lure_quota || 2;
  const floor = streamType === 'tech' ? 2 : 1;

  if (recentLureCount >= quota) {
    // Quota maxed → educational only, but respect the per-stream floor
    return Math.max(floor, Math.floor(Math.random() * 2) + 1);
  }

  // 30% chance of lure-coded (3-4), 70% educational (floor..2)
  if (Math.random() < 0.3) {
    return Math.min(persona.max_lure_level, 3 + Math.floor(Math.random() * 2));
  }
  return Math.max(floor, 2);
}

function clearCache() {
  cache = { row: null, fetchedAt: 0 };
}

module.exports = {
  getActivePersona,
  buildSystemPrompt,
  buildVisualPromptHeader,
  buildNegativePrompt,
  pickSignatureGesture,
  pickAestheticContext,
  chooseLureLevel,
  clearCache,
};
