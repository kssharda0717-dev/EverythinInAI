/**
 * EverythinInAI Discovery Engine — Database Layer
 * Wraps Supabase client with domain-specific operations.
 * All writes are atomic. All reads are indexed.
 */
const { createClient } = require('@supabase/supabase-js');
const { config } = require('./config');
const { createLogger } = require('../utils/logger');

const log = createLogger('database');

let supabase = null;

// UUID v4 validator — guards against malformed IDs from Gemini
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(s) {
  return typeof s === 'string' && UUID_REGEX.test(s);
}

function getClient() {
  if (!supabase) {
    supabase = createClient(config.supabase.url, config.supabase.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: -1 } },
      global: { headers: { 'X-Client-Info': 'everythinginai-engine' } },
    });
    log.info('Supabase client initialized');
  }
  return supabase;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUNS
// ═══════════════════════════════════════════════════════════════════════════════

async function createRun(runId, mode, sinceTs, untilTs) {
  const db = getClient();
  const { data, error } = await db.from('runs').insert({
    id: runId,
    mode,
    state: 'init',
    since_timestamp: sinceTs,
    until_timestamp: untilTs,
  }).select().single();
  if (error) throw new Error(`Failed to create run: ${error.message}`);
  log.info(`Run created: ${runId} (${mode})`);
  return data;
}

async function updateRunState(runId, state, extras = {}) {
  const db = getClient();
  const update = { state, ...extras };
  if (state === 'done' || state === 'failed') {
    update.completed_at = new Date().toISOString();
  }
  const { error } = await db.from('runs').update(update).eq('id', runId);
  if (error) throw new Error(`Failed to update run state: ${error.message}`);
  log.info(`Run ${runId} → ${state}`);
}

async function getLatestRun(mode) {
  const db = getClient();
  const { data, error } = await db.from('runs')
    .select('*')
    .eq('mode', mode)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to get latest run: ${error.message}`);
  return data;
}

async function getIncompleteRun() {
  const db = getClient();
  const { data, error } = await db.from('runs')
    .select('*')
    .not('state', 'in', '("done","failed")')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to get incomplete run: ${error.message}`);
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISCOVERY QUEUE
// ═══════════════════════════════════════════════════════════════════════════════

async function enqueueItems(items, runId) {
  if (!items.length) return 0;
  const db = getClient();

  // Insert in chunks of 500 to avoid payload limits
  const CHUNK = 500;
  let inserted = 0;

  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK).map(item => ({
      raw_title: (item.raw_title || '').substring(0, 1000),
      raw_description: (item.raw_description || '').substring(0, 5000),
      url: item.url,
      source: item.source,
      source_url: item.source_url || '',
      upvotes: item.upvotes || 0,
      comments: item.comments || 0,
      author: item.author || '',
      homepage: item.homepage || '',
      language: item.language || '',
      topics: item.topics ? (Array.isArray(item.topics) ? item.topics : item.topics.split(',').map(t => t.trim())) : [],
      published_at: item.published_at || new Date().toISOString(),
      heuristic_score: item.heuristic_score || 0,
      score_reasons: item.score_reasons || [],
      status: 'pending',
      run_id: runId,
    }));

    const { data, error } = await db.from('discovery_queue').insert(chunk).select('id');
    if (error) {
      log.error(`Failed to enqueue chunk ${i}-${i + CHUNK}: ${error.message}`);
      continue;
    }
    inserted += (data?.length || 0);
  }

  log.info(`Enqueued ${inserted}/${items.length} items for run ${runId}`);
  return inserted;
}

async function dequeueItemsForClassification(batchSize, runId) {
  const db = getClient();

  // Grab the top N pending items by heuristic score
  const { data: items, error: fetchErr } = await db.from('discovery_queue')
    .select('*')
    .eq('status', 'pending')
    .eq('run_id', runId)
    .order('heuristic_score', { ascending: false })
    .limit(batchSize);

  if (fetchErr) throw new Error(`Failed to dequeue: ${fetchErr.message}`);
  if (!items || items.length === 0) return [];

  // Mark them as processing
  const ids = items.map(i => i.id);
  const { error: updateErr } = await db.from('discovery_queue')
    .update({ status: 'processing' })
    .in('id', ids);

  if (updateErr) {
    log.warn(`Failed to mark items as processing: ${updateErr.message}`);
  }

  return items;
}

async function markItemClassified(itemId, geminiResponse) {
  if (!isValidUuid(itemId)) {
    log.error(`Skipping markItemClassified — malformed UUID: ${itemId}`);
    return;
  }
  const db = getClient();
  const { error } = await db.from('discovery_queue').update({
    status: 'classified',
    gemini_response: geminiResponse,
    processed_at: new Date().toISOString(),
  }).eq('id', itemId);
  if (error) log.error(`Failed to mark item ${itemId} classified: ${error.message}`);
}

async function markItemRejected(itemId, reason) {
  if (!isValidUuid(itemId)) {
    log.error(`Skipping markItemRejected — malformed UUID: ${itemId}`);
    return;
  }
  const db = getClient();
  const { error } = await db.from('discovery_queue').update({
    status: 'rejected',
    error_message: reason,
    processed_at: new Date().toISOString(),
  }).eq('id', itemId);
  if (error) log.error(`Failed to mark item ${itemId} rejected: ${error.message}`);
}

async function markItemError(itemId, errorMsg) {
  if (!isValidUuid(itemId)) {
    log.error(`Skipping markItemError — malformed UUID: ${itemId}`);
    return;
  }
  const db = getClient();
  const { error } = await db.from('discovery_queue').update({
    status: 'error',
    error_message: errorMsg,
    processed_at: new Date().toISOString(),
  }).eq('id', itemId);
  if (error) log.error(`Failed to mark item ${itemId} error: ${error.message}`);
}

async function getPendingCount(runId) {
  const db = getClient();
  const { count, error } = await db.from('discovery_queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending')
    .eq('run_id', runId);
  if (error) return 0;
  return count || 0;
}

async function getClassifiedItems(runId) {
  const db = getClient();
  const { data, error } = await db.from('discovery_queue')
    .select('*')
    .eq('status', 'classified')
    .eq('run_id', runId);
  if (error) throw new Error(`Failed to get classified items: ${error.message}`);
  return data || [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOLS (Core Directory)
// ═══════════════════════════════════════════════════════════════════════════════

async function checkDuplicate(name, urlNormalized) {
  const db = getClient();

  // 1. Exact URL match
  const { data: urlMatch } = await db.from('tools')
    .select('id, name, url_normalized')
    .eq('url_normalized', urlNormalized)
    .limit(1)
    .maybeSingle();

  if (urlMatch) {
    return { isDuplicate: true, matchedId: urlMatch.id, matchedName: urlMatch.name, similarity: 1.0, matchType: 'url' };
  }

  // 2. Exact name match (case-insensitive)
  const nameLower = name.toLowerCase().trim();
  const { data: nameMatch } = await db.from('tools')
    .select('id, name')
    .eq('name_lower', nameLower)
    .limit(1)
    .maybeSingle();

  if (nameMatch) {
    return { isDuplicate: true, matchedId: nameMatch.id, matchedName: nameMatch.name, similarity: 1.0, matchType: 'name_exact' };
  }

  // 3. Fuzzy name match using pg_trgm (via RPC if available, else client-side)
  // We use a direct query with similarity function
  const { data: fuzzyMatches } = await db.rpc('check_fuzzy_duplicate', {
    p_name: name,
    p_url_normalized: urlNormalized,
    p_threshold: 0.7,
  });

  if (fuzzyMatches && fuzzyMatches.length > 0 && fuzzyMatches[0].is_duplicate) {
    return {
      isDuplicate: true,
      matchedId: fuzzyMatches[0].matched_id,
      matchedName: fuzzyMatches[0].matched_name,
      similarity: fuzzyMatches[0].similarity,
      matchType: 'fuzzy',
    };
  }

  return { isDuplicate: false };
}

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80);
}

async function insertTool(tool) {
  const db = getClient();
  let slug = generateSlug(tool.name);

  // Ensure slug uniqueness
  const { data: existing } = await db.from('tools')
    .select('slug')
    .like('slug', `${slug}%`);

  if (existing && existing.length > 0) {
    const existingSlugs = new Set(existing.map(e => e.slug));
    if (existingSlugs.has(slug)) {
      let counter = 2;
      while (existingSlugs.has(`${slug}-${counter}`)) counter++;
      slug = `${slug}-${counter}`;
    }
  }

  const record = {
    slug,
    name: tool.name,
    tagline: tool.tagline || '',
    description: tool.description || '',
    url: tool.url,
    category: tool.category || 'Other',
    tags: Array.isArray(tool.tags) ? tool.tags.slice(0, 5) : [],
    pricing: tool.pricing || 'unknown',
    source: tool.source || 'auto_discovery',
    source_url: tool.source_url || '',
    confidence: tool.confidence || 0,
    upvotes: tool.upvotes || 0,
    author: tool.author || '',
    homepage: tool.homepage || '',
    language: tool.language || '',
    topics: Array.isArray(tool.topics) ? tool.topics : [],
    published_at: tool.published_at || new Date().toISOString(),
    run_id: tool.run_id || '',
  };

  const { data, error } = await db.from('tools').insert(record).select().single();
  if (error) {
    // Handle unique constraint violation gracefully
    if (error.code === '23505') {
      log.debug(`Duplicate tool skipped (constraint): ${tool.name}`);
      return null;
    }
    throw new Error(`Failed to insert tool ${tool.name}: ${error.message}`);
  }

  log.info(`Tool inserted: ${tool.name} (${slug})`);
  return data;
}

async function getToolCount() {
  const db = getClient();
  const { count, error } = await db.from('tools')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);
  if (error) return 0;
  return count || 0;
}

async function exportToolsAsJson() {
  const db = getClient();
  const { data, error } = await db.from('tools')
    .select('slug, name, tagline, description, url, category, tags, pricing, source, added_at, updated_at')
    .eq('is_active', true)
    .order('added_at', { ascending: false });

  if (error) throw new Error(`Failed to export tools: ${error.message}`);

  return {
    metadata: {
      lastUpdated: new Date().toISOString(),
      totalTools: data.length,
      version: '2.0.0',
    },
    tools: data.map(t => ({
      id: t.slug,
      name: t.name,
      tagline: t.tagline,
      description: t.description,
      url: t.url,
      category: t.category,
      tags: t.tags,
      pricing: t.pricing,
      source: t.source,
      addedAt: t.added_at,
      updatedAt: t.updated_at,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKFILL PROGRESS
// ═══════════════════════════════════════════════════════════════════════════════

async function initBackfillProgress(startYear, startMonth, endYear, endMonth) {
  const db = getClient();
  const months = [];
  let y = startYear, m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    months.push({ year_month: ym, source: 'all', status: 'pending' });
    m++;
    if (m > 12) { m = 1; y++; }
  }

  // Upsert: only insert months that don't exist yet
  for (const month of months) {
    const { data: existing } = await db.from('backfill_progress')
      .select('id')
      .eq('year_month', month.year_month)
      .maybeSingle();
    if (!existing) {
      await db.from('backfill_progress').insert(month);
    }
  }

  log.info(`Backfill progress initialized: ${months.length} months`);
  return months.length;
}

async function getNextBackfillMonth() {
  const db = getClient();
  const { data, error } = await db.from('backfill_progress')
    .select('*')
    .eq('status', 'pending')
    .order('year_month', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to get next backfill month: ${error.message}`);
  return data;
}

async function updateBackfillMonth(yearMonth, updates) {
  const db = getClient();
  const { error } = await db.from('backfill_progress')
    .update(updates)
    .eq('year_month', yearMonth);
  if (error) throw new Error(`Failed to update backfill ${yearMonth}: ${error.message}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEDUP CHECK FOR QUEUE (pre-enqueue)
// ═══════════════════════════════════════════════════════════════════════════════

async function isUrlAlreadyKnown(urlNormalized) {
  const db = getClient();

  // Check tools table
  const { data: toolMatch } = await db.from('tools')
    .select('id')
    .eq('url_normalized', urlNormalized)
    .limit(1)
    .maybeSingle();
  if (toolMatch) return true;

  // Check queue (already pending/processing)
  const { data: queueMatch } = await db.from('discovery_queue')
    .select('id')
    .eq('url_normalized', urlNormalized)
    .in('status', ['pending', 'processing', 'classified'])
    .limit(1)
    .maybeSingle();
  if (queueMatch) return true;

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI SIGNALS (v2 — non-tool content: news, research, drama, etc.)
// ═══════════════════════════════════════════════════════════════════════════════

async function insertSignal(signal) {
  const db = getClient();

  // Slug from name + small entropy for uniqueness
  const baseSlug = generateSlug(signal.name || signal.title || 'signal');
  const slug = `${baseSlug}-${Date.now().toString(36).slice(-4)}`;

  const record = {
    slug,
    title: signal.name || signal.title || 'Untitled',
    summary: signal.summary || '',
    narrative: signal.narrative || '',
    url: signal.url,
    type: signal.type,
    subtype: signal.subtype || '',
    entities: Array.isArray(signal.entities) ? signal.entities : [],
    topics: Array.isArray(signal.topics) ? signal.topics : [],
    virality_score: typeof signal.virality_score === 'number' ? signal.virality_score : 0,
    avatar_angles: Array.isArray(signal.avatar_angles) ? signal.avatar_angles : [],
    is_evergreen: signal.is_evergreen === true,
    newsworthy_until: signal.newsworthy_until || null,
    source: signal.source || 'auto_discovery',
    source_url: signal.source_url || '',
    author: signal.author || '',
    upvotes: signal.upvotes || 0,
    comments: signal.comments || 0,
    classifier_version: 'v2.0',
    confidence: signal.confidence || 0,
    published_at: signal.published_at || new Date().toISOString(),
    run_id: signal.run_id || '',
  };

  const { data, error } = await db.from('ai_signals').insert(record).select().single();

  if (error) {
    if (error.code === '23505') {
      log.debug(`Duplicate signal skipped: ${signal.name}`);
      return null;
    }
    throw new Error(`Failed to insert signal ${signal.name}: ${error.message}`);
  }

  log.info(`Signal inserted [${signal.type}]: ${signal.name} (virality ${signal.virality_score})`);
  return data;
}

async function checkSignalDuplicate(urlNormalized) {
  const db = getClient();
  const { data } = await db.from('ai_signals')
    .select('id, title')
    .eq('url_normalized', urlNormalized)
    .limit(1)
    .maybeSingle();
  return data ? { isDuplicate: true, matchedTitle: data.title, matchedId: data.id } : { isDuplicate: false };
}

async function getSignalCount() {
  const db = getClient();
  const { count } = await db.from('ai_signals')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);
  return count || 0;
}

module.exports = {
  getClient,
  isValidUuid,
  createRun,
  updateRunState,
  getLatestRun,
  getIncompleteRun,
  enqueueItems,
  dequeueItemsForClassification,
  markItemClassified,
  markItemRejected,
  markItemError,
  getPendingCount,
  getClassifiedItems,
  checkDuplicate,
  insertTool,
  getToolCount,
  exportToolsAsJson,
  initBackfillProgress,
  getNextBackfillMonth,
  updateBackfillMonth,
  isUrlAlreadyKnown,
  generateSlug,
  // v2 additions
  insertSignal,
  checkSignalDuplicate,
  getSignalCount,
};
