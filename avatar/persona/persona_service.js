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
 * Get the active persona (currently always Avi).
 * Optionally pass a slug to fetch a specific persona.
 */
async function getActivePersona(slug = 'avi') {
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
  return `${forbidden}, child, minor, deformed, extra limbs, extra fingers, blurry face, watermark, text, logo, artificial-looking skin, plastic skin, cartoon, anime, illustration, painting, low quality, jpeg artifacts, oversaturated, harsh shadows, phone flash, mirror selfie cliche`;
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
 */
async function chooseLureLevel(recentLureCount = 0) {
  const persona = await getActivePersona();
  const quota = persona.weekly_lure_quota || 2;

  if (recentLureCount >= quota) {
    // Quota maxed → educational only
    return Math.floor(Math.random() * 2) + 1;  // 1 or 2
  }

  // 30% chance of lure-coded, 70% educational
  if (Math.random() < 0.3) {
    return Math.min(persona.max_lure_level, 3 + Math.floor(Math.random() * 2));  // 3 or 4
  }
  return 2;
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
