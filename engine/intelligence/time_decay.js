/**
 * EverythinInAI — Virality Time-Decay
 *
 * Time-sensitive signals (news, release, drama, funding) lose virality fast.
 * The avatar should NEVER make a Reel about "OpenAI just released GPT-4" in 2026.
 *
 * Evergreen signals (tools, research, tutorials, opinion, meme) keep their virality
 * because they remain useful/interesting for years.
 *
 * Decay rules (applied AT INSERT time and re-applied periodically by maintenance):
 *
 *   news / release / drama / funding:
 *     ≤ 7 days  : full virality
 *     8–30 days : virality × 0.5  (still relevant but not "breaking")
 *     31–90 days : virality × 0.2
 *     > 90 days : virality = 0    (effectively excluded from avatar)
 *
 *   tool / research / tutorial / opinion / meme:
 *     no decay — evergreen
 *
 * Usage:
 *   const { decayedVirality, isEvergreen } = applyTimeDecay(type, originalScore, publishedAt);
 */

const TIME_SENSITIVE_TYPES = new Set(['news', 'release', 'drama', 'funding']);
const EVERGREEN_TYPES = new Set(['tool', 'research', 'tutorial', 'opinion', 'meme']);

function applyTimeDecay(type, originalScore, publishedAt) {
  const score = typeof originalScore === 'number' ? originalScore : 0;

  if (EVERGREEN_TYPES.has(type)) {
    return { decayedVirality: score, isEvergreen: true, ageBucket: 'evergreen' };
  }

  if (!TIME_SENSITIVE_TYPES.has(type)) {
    // Unknown type — keep original score, mark not evergreen
    return { decayedVirality: score, isEvergreen: false, ageBucket: 'unknown' };
  }

  const publishedMs = publishedAt ? Date.parse(publishedAt) : 0;
  if (!publishedMs) {
    // No date → assume fresh-ish, keep score
    return { decayedVirality: score, isEvergreen: false, ageBucket: 'undated' };
  }

  const ageDays = (Date.now() - publishedMs) / 86400000;

  if (ageDays <= 7) {
    return { decayedVirality: score, isEvergreen: false, ageBucket: 'fresh' };
  }
  if (ageDays <= 30) {
    return { decayedVirality: Math.round(score * 0.5), isEvergreen: false, ageBucket: 'recent' };
  }
  if (ageDays <= 90) {
    return { decayedVirality: Math.round(score * 0.2), isEvergreen: false, ageBucket: 'fading' };
  }
  // Older than 90 days for time-sensitive content → effectively excluded
  return { decayedVirality: 0, isEvergreen: false, ageBucket: 'stale' };
}

module.exports = {
  applyTimeDecay,
  TIME_SENSITIVE_TYPES: Array.from(TIME_SENSITIVE_TYPES),
  EVERGREEN_TYPES: Array.from(EVERGREEN_TYPES),
};
