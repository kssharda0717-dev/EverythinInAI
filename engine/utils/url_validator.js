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

  // Reject obviously dead patterns (Heroku review apps, DigitalOcean app preview etc.) before network call
  const badHosts = [
    /\.ondigitalocean\.app$/i,         // temporary DigitalOcean previews — almost always torn down
    /\.netlify\.app$/i,                // Netlify previews (often stale)
    /\.vercel\.app$/i,                 // Vercel previews — own custom domain expected for production
    /\.herokuapp\.com$/i,              // Heroku free tier dyno apps (long since gone)
    /^localhost$/i,
    /^127\./,
  ];
  if (opts.strict && badHosts.some(rx => rx.test(parsed.hostname))) {
    return { ok: false, status: 'BLACKLISTED_HOST', finalUrl: null };
  }

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
    if (r.status === 405 || r.status === 501) {
      // Fall through to GET — some servers reject HEAD
    } else {
      return { ok: false, status: r.status, finalUrl: null };
    }
  } catch (err) {
    // DNS failure / connection refused / timeout — fall through to GET only on transient errors
    const code = err.code || '';
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
    return r.status >= 200 && r.status < 400
      ? { ok: true, status: r.status, finalUrl: r.request?.res?.responseUrl || url }
      : { ok: false, status: r.status, finalUrl: null };
  } catch (err) {
    return { ok: false, status: err.code || err.message, finalUrl: null };
  }
}

module.exports = { isLiveUrl };
