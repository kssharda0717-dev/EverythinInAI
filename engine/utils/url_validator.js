/**
 * EverythinInAI — URL Validator
 *
 * HEAD-checks a URL to verify it's actually live (returns 2xx or 3xx).
 * Falls back to GET if HEAD is rejected (some servers return 405 on HEAD).
 *
 * Returns:
 *   { ok: boolean, status: number|string, finalUrl: string|null }
 *
 * Used by:
 *   - engine/utils/enricher.js  (validates suggested homepage from Gemini)
 *   - scripts/seed_top_tools.js (validates curated homepages before insert)
 *   - scripts/validate_homepages.js (retroactive cleanup of dead homepages)
 */

const axios = require('axios');

const TIMEOUT_MS = 6000;
const UA = 'EverythinInAI-Validator/1.0 (+https://everythin-in-ai-iug3.vercel.app)';

async function isLiveUrl(url, opts = {}) {
  if (!url || typeof url !== 'string') return { ok: false, status: 'NO_URL', finalUrl: null };

  // Sanity-check the URL shape
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, status: 'BAD_URL', finalUrl: null }; }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, status: 'BAD_PROTO', finalUrl: null };

  // Reject obviously dead patterns AND social/article-only hosts before the network call
  const badHosts = [
    /\.ondigitalocean\.app$/i,         // temporary DigitalOcean previews — almost always torn down
    /\.netlify\.app$/i,                // Netlify previews (often stale)
    /\.vercel\.app$/i,                 // Vercel previews — own custom domain expected for production
    /\.herokuapp\.com$/i,              // Heroku free tier dyno apps (long since gone)
    /^localhost$/i,
    /^127\./,
    // Phase 18: social profiles / articles aren't real homepages even when live
    /^(www\.)?linkedin\.com$/i,
    /^(www\.)?twitter\.com$/i,
    /^(www\.)?x\.com$/i,
    /^(www\.)?facebook\.com$/i,
    /^(www\.)?instagram\.com$/i,
    /^(www\.)?threads\.net$/i,
    /^(www\.)?tiktok\.com$/i,
    /^(www\.)?medium\.com$/i,
    /\.medium\.com$/i,
    /^(www\.)?reddit\.com$/i,
    /^(www\.)?news\.ycombinator\.com$/i,
    /^(www\.)?youtube\.com$/i,
    /^(www\.)?youtu\.be$/i,
    /^(www\.)?vimeo\.com$/i,
    /^(www\.)?stackoverflow\.com$/i,
    /^(www\.)?quora\.com$/i,
    /^apps\.apple\.com$/i,
    /^play\.google\.com$/i,
    /^chromewebstore\.google\.com$/i,
    /^chrome\.google\.com$/i,
    /^arxiv\.org$/i,
  ];
  if (opts.strict && badHosts.some(rx => rx.test(parsed.hostname))) {
    return { ok: false, status: 'BLACKLISTED_HOST', finalUrl: null };
  }

  // "Soft-fail" responses indicate anti-bot defenses, NOT a dead URL.
  // Cloudflare / Vercel bot fight mode commonly returns 403/429/503 for any
  // request from a data-center IP (which our VM is). Treating those as dead
  // would kill legitimate tools like Midjourney, DeepSeek, Mistral, Perplexity.
  const SOFT_FAIL_STATUSES = new Set([401, 402, 403, 405, 406, 408, 409, 425, 429, 430, 451, 500, 502, 503, 504, 520, 521, 522, 523, 525, 526]);
  const SOFT_FAIL_ERR_CODES = new Set(['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ECONNABORTED']);

  // Try HEAD
  try {
    const r = await axios.head(url, {
      timeout: TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: { 'User-Agent': UA },
    });
    if (r.status >= 200 && r.status < 400) {
      return { ok: true, status: r.status, finalUrl: r.request?.res?.responseUrl || url };
    }
    // Anti-bot — don't mark as dead, mark as 'unknown' (treated as ok by validator scripts)
    if (SOFT_FAIL_STATUSES.has(r.status)) {
      return { ok: true, status: r.status, finalUrl: url, softFail: true };
    }
    if (r.status === 405 || r.status === 501) {
      // Fall through to GET — some servers reject HEAD
    } else {
      return { ok: false, status: r.status, finalUrl: null };
    }
  } catch (err) {
    const code = err.code || '';
    // SSL / TLS / abort = soft fail (real users would still get through with a warning click)
    if (SOFT_FAIL_ERR_CODES.has(code)) {
      return { ok: true, status: code, finalUrl: url, softFail: true };
    }
    // Transient — fall through to GET
    if (!['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'].includes(code)) {
      return { ok: false, status: code || err.message, finalUrl: null };
    }
  }

  // Fallback GET
  try {
    const r = await axios.get(url, {
      timeout: TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: 'stream',
      headers: { 'User-Agent': UA },
    });
    r.data?.destroy?.();
    if (r.status >= 200 && r.status < 400) {
      return { ok: true, status: r.status, finalUrl: r.request?.res?.responseUrl || url };
    }
    if (SOFT_FAIL_STATUSES.has(r.status)) {
      return { ok: true, status: r.status, finalUrl: url, softFail: true };
    }
    return { ok: false, status: r.status, finalUrl: null };
  } catch (err) {
    const code = err.code || '';
    if (SOFT_FAIL_ERR_CODES.has(code)) {
      return { ok: true, status: code, finalUrl: url, softFail: true };
    }
    return { ok: false, status: code || err.message, finalUrl: null };
  }
}

module.exports = { isLiveUrl };
