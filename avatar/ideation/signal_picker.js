/**
 * EverythinInAI — Daily Signal Picker
 *
 * Scans the last 48h of signals, applies fresh time-decay scoring, dedupes by
 * entity (so we don't pick 3 OpenAI signals in one day), and returns the
 * top winner + 2 backups for ideation.
 *
 * Scoring (0-100):
 *   base               = signal.virality_score * 10        (0-100)
 *   freshness_boost    = +20 if published in last 6h
 *   freshness_boost    = +10 if published in last 24h
 *   freshness_boost    =  -5 if older than 36h
 *   engagement_boost   = +min(20, log2(upvotes+1))         (Reddit/HN)
 *   type_boost:
 *     release/drama    = +10  (very Reel-able)
 *     funding          = +5
 *     research         = +0   (already weighted by classifier)
 *     news             = +5
 *     opinion          = -5   (less Reel-able)
 *     meme             = +15  (instant viral)
 *   recency_penalty    = -25 if same entity has been used in last 7 days
 *   already-used penalty = -100 if signal_id already has a winner concept
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('signal_picker');

// Type weights tuned for an AI-tools-news brand:
//   tools and products are what we cover → huge boost
//   releases (model launches, big startup launches) are great → modest boost
//   research papers and tutorials are dry for short-form video → penalty
//   memes and funding/drama still have place but rarely happen
const TYPE_BOOSTS = {
  tool:     25,   // 🔥 our brand is AI tools — surface them aggressively
  product:  25,   // alias for tool
  release:  12,   // model/startup launches
  drama:    10,
  meme:     15,
  funding:   5,
  news:      5,
  research: -8,   // papers are dry for our format
  tutorial: -10,  // walkthroughs are great long-form, weak short-form
  opinion:  -5,
};

// Source weights: avoid github-only monoculture, lift product-discovery sources
const SOURCE_BASE_BOOSTS = {
  product_hunt:  15,
  producthunt:   15,
  replicate:     12,
  huggingface:   10,
  hackernews:     5,
  reddit:         3,
  twitter:        3,
  github:         0,    // already over-represented
  github_trending: 0,
  arxiv:        -10,    // papers, not tools
};

function freshnessBoost(publishedAt) {
  if (!publishedAt) return -10;
  const ageHours = (Date.now() - Date.parse(publishedAt)) / 3_600_000;
  if (ageHours <= 6) return 20;
  if (ageHours <= 24) return 10;
  if (ageHours <= 36) return 0;
  return -5;
}

function engagementBoost(upvotes, comments) {
  const total = (upvotes || 0) + (comments || 0) * 2;
  if (total <= 0) return 0;
  return Math.min(20, Math.log2(total + 1));
}

function scoreSignal(sig, recentEntityCounts = {}, sourceFatiguePenalty = {}) {
  const base = (sig.virality_score || 0) * 10;
  const fresh = freshnessBoost(sig.published_at || sig.added_at);
  const eng = engagementBoost(sig.upvotes, sig.comments);
  const typeB = TYPE_BOOSTS[sig.type] || 0;

  // Source bias: base boost (favor product/tool sources, penalize github monoculture)
  // PLUS dynamic fatigue: if this source dominated recent winners, penalize further.
  const src = (sig.source || '').toLowerCase();
  const sourceB = (SOURCE_BASE_BOOSTS[src] || 0) + (sourceFatiguePenalty[src] || 0);

  // Recency penalty: was the same entity used in last 7 days?
  let recencyPenalty = 0;
  for (const ent of (sig.entities || [])) {
    if (recentEntityCounts[ent.toLowerCase()]) {
      recencyPenalty -= 25;
      break;
    }
  }

  return Math.round(base + fresh + eng + typeB + sourceB + recencyPenalty);
}

/**
 * Compute a per-source fatigue penalty based on the last 5 winners.
 * If a source dominates recent picks, candidates from that source get penalised
 * and other sources get a positive bonus to force variety.
 */
async function getSourceFatiguePenalty(personaId, lookbackDays = 7) {
  const db = dbModule.getClient();
  const since = new Date(Date.now() - lookbackDays * 86400_000).toISOString().slice(0, 10);
  const { data: winners } = await db
    .from('reel_concepts')
    .select('signal_id')
    .eq('persona_id', personaId)
    .eq('is_winner', true)
    .gte('target_date', since)
    .not('signal_id', 'is', null)
    .order('target_date', { ascending: false })
    .limit(5);

  const sigIds = (winners || []).map(w => w.signal_id);
  if (sigIds.length === 0) return {};

  const { data: sigs } = await db
    .from('ai_signals')
    .select('source')
    .in('id', sigIds);

  const counts = {};
  for (const s of (sigs || [])) {
    const src = (s.source || '').toLowerCase();
    counts[src] = (counts[src] || 0) + 1;
  }

  const penalty = {};
  const total = sigs?.length || 0;
  if (total === 0) return {};

  for (const [src, count] of Object.entries(counts)) {
    const ratio = count / total;
    if (ratio >= 0.6) penalty[src] = -25;       // 3+ of 5 → strong penalty
    else if (ratio >= 0.4) penalty[src] = -10;
  }

  // Inverse boost for under-represented sources (forces variety)
  for (const src of Object.keys(SOURCE_BASE_BOOSTS)) {
    if (!counts[src]) penalty[src] = (penalty[src] || 0) + 10;
  }

  return penalty;
}

async function getRecentEntityCounts(personaId, days = 7) {
  const db = dbModule.getClient();
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await db
    .from('reel_concepts')
    .select('signal_id, target_date')
    .eq('persona_id', personaId)
    .eq('is_winner', true)
    .gte('target_date', since.slice(0, 10));

  if (error) {
    log.warn(`Could not fetch recent winners: ${error.message}`);
    return {};
  }

  if (!data || data.length === 0) return {};

  const sigIds = data.map(r => r.signal_id).filter(Boolean);
  if (sigIds.length === 0) return {};

  const { data: sigs } = await db
    .from('ai_signals')
    .select('entities')
    .in('id', sigIds);

  const counts = {};
  for (const s of (sigs || [])) {
    for (const e of (s.entities || [])) {
      const k = e.toLowerCase();
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  return counts;
}

async function getUsedSignalIds(personaId, days = 30) {
  const db = dbModule.getClient();
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const { data } = await db
    .from('reel_concepts')
    .select('signal_id')
    .eq('persona_id', personaId)
    .gte('target_date', since)
    .not('signal_id', 'is', null);
  return new Set((data || []).map(r => r.signal_id));
}

/**
 * Build a canonical topic key from a signal so we can dedupe across multiple
 * ai_signals rows that point to the same underlying paper/tool.
 *
 * Strategy: lowercase the title, strip punctuation, strip common filler words,
 * collapse whitespace. Two signals about "LightRAG: Simple and Fast Retrieval-
 * Augmented Generation" should produce the same key whether they come from
 * GitHub, ArXiv, or HN.
 */
function canonicalTopicKey(sig) {
  const t = (sig.title || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')      // strip punctuation
    .replace(/\b(the|a|an|of|for|with|and|or|to|on|in|by)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Use just the first 50 chars to be lenient on slight variations
  return t.slice(0, 50);
}

/**
 * Pull persistent topic history. Returns a Set of canonical topic keys that
 * have been used in any reel in the last N days.
 */
async function getUsedTopicKeys(personaId, days = 30) {
  const db = dbModule.getClient();
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  try {
    const { data, error } = await db
      .from('topic_history')
      .select('topic_key')
      .eq('persona_id', personaId)
      .gte('last_used_at', since);
    if (error) {
      log.warn(`topic_history query failed (table missing?): ${error.message}`);
      return new Set();
    }
    return new Set((data || []).map(r => r.topic_key));
  } catch (err) {
    log.warn(`topic_history not available, skipping topic-based dedup: ${err.message}`);
    return new Set();
  }
}

/**
 * Pick the top N candidate signals for today's ideation.
 * @returns {Promise<Array>} array of {signal, score, reasoning}
 */
async function pickTopSignals(personaId, options = {}) {
  const limit = options.limit ?? 3;
  const lookbackHours = options.lookbackHours ?? 48;

  const db = dbModule.getClient();

  log.info(`Scanning last ${lookbackHours}h of signals for persona ${personaId}...`);

  const since = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();

  const { data: signals, error } = await db
    .from('ai_signals')
    .select('id, slug, title, summary, narrative, url, type, subtype, entities, topics, virality_score, avatar_angles, source, upvotes, comments, published_at, added_at')
    .eq('is_active', true)
    .gte('added_at', since)
    .gte('virality_score', 4)        // skip junk early
    .order('virality_score', { ascending: false })
    .limit(80);

  if (error) throw new Error(`Failed to fetch signals: ${error.message}`);

  if (!signals || signals.length === 0) {
    log.warn('No fresh signals found in lookback window. Falling back to last 7 days.');
    const { data: fallback } = await db
      .from('ai_signals')
      .select('id, slug, title, summary, narrative, url, type, subtype, entities, topics, virality_score, avatar_angles, source, upvotes, comments, published_at, added_at')
      .eq('is_active', true)
      .gte('added_at', new Date(Date.now() - 7 * 86400_000).toISOString())
      .gte('virality_score', 5)
      .order('virality_score', { ascending: false })
      .limit(40);
    if (!fallback || fallback.length === 0) {
      throw new Error('No usable signals in the last 7 days. Check the discovery engine.');
    }
    signals.push(...fallback);
  }

  log.info(`Found ${signals.length} candidate signals. Scoring...`);

  const recentEntityCounts = await getRecentEntityCounts(personaId);
  const usedIds = await getUsedSignalIds(personaId);
  const usedTopicKeys = await getUsedTopicKeys(personaId);
  const sourceFatiguePenalty = await getSourceFatiguePenalty(personaId);
  if (Object.keys(sourceFatiguePenalty).length > 0) {
    log.info(`Source fatigue penalties this run: ${JSON.stringify(sourceFatiguePenalty)}`);
  }

  // Also dedupe by canonical topic within today's candidate batch (so we don't
  // suggest two duplicate-but-different-id signals about the same paper).
  const seenTopicKeys = new Set();

  const scored = signals
    .filter(s => {
      if (usedIds.has(s.id)) return false;
      const key = canonicalTopicKey(s);
      if (usedTopicKeys.has(key)) {
        log.info(`  ✖ skip [topic-history] "${s.title.slice(0, 60)}" — topic already used`);
        return false;
      }
      if (seenTopicKeys.has(key)) {
        log.info(`  ✖ skip [duplicate-batch] "${s.title.slice(0, 60)}" — dupe of earlier candidate this run`);
        return false;
      }
      seenTopicKeys.add(key);
      return true;
    })
    .map(s => ({
      signal: s,
      score: scoreSignal(s, recentEntityCounts, sourceFatiguePenalty),
    }))
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, limit);

  log.info(`Top ${top.length} candidates:`);
  top.forEach((c, i) => {
    log.info(`  #${i + 1} [score=${c.score}] [${c.signal.type}] ${c.signal.title.substring(0, 80)}`);
  });

  return top;
}

module.exports = { pickTopSignals, scoreSignal, canonicalTopicKey };
