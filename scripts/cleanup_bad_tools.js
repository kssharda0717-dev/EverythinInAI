#!/usr/bin/env node
/**
 * EverythinInAI \u2014 Retroactive Bad-Tool Cleanup (Phase 17)
 *
 * Goes through every active tool and soft-deletes (sets is_active=false) any
 * whose URL matches the blacklist patterns from pre-filter.js (LinkedIn
 * profiles, Medium articles, YouTube videos, Reddit threads, etc.).
 *
 * These rows aren't truly deleted \u2014 just hidden from the directory. They
 * stay in the DB for analytics / debugging / re-classification later.
 *
 * Usage:
 *   node scripts/cleanup_bad_tools.js                # full scan
 *   node scripts/cleanup_bad_tools.js --dry-run      # report only, no writes
 *   node scripts/cleanup_bad_tools.js --limit=500    # only top 500 by upvotes
 *
 * Cost: $0 (no LLM, no network beyond Supabase reads/writes).
 * Time: ~30 sec per 1000 rows.
 */

const dbModule = require('../engine/core/database');
const { createLogger } = require('../engine/utils/logger');

const log = createLogger('cleanup_bad_tools');

// Same blacklist as engine/intelligence/pre-filter.js (Phase 17)
const HARD_BLACKLIST_PATTERNS = [
  /linkedin\.com\/(in|posts|pulse|company|jobs)\//i,
  /twitter\.com\/[^/]+\/status\//i,
  /x\.com\/[^/]+\/status\//i,
  /facebook\.com\//i,
  /instagram\.com\/(p|reel|tv)\//i,
  /threads\.net\//i,
  /tiktok\.com\/@/i,
  /medium\.com\/(@|.*\/.*-)/i,
  /\.medium\.com\//i,
  /substack\.com\/p\//i,
  /dev\.to\/[^/]+\/[^/]+/i,
  /hashnode\.com\//i,
  /hashnode\.dev\//i,
  /freecodecamp\.org\/news\//i,
  /geeksforgeeks\.org\//i,
  /towardsdatascience\.com\//i,
  /analyticsvidhya\.com\//i,
  /kdnuggets\.com\//i,
  /machinelearningmastery\.com\//i,
  /reddit\.com\/r\/[^/]+\/comments\//i,
  /news\.ycombinator\.com\/item/i,
  /youtube\.com\/watch/i,
  /youtu\.be\//i,
  /vimeo\.com\/\d+/i,
  /spotify\.com\/(episode|show)\//i,
  /stackoverflow\.com\/questions\//i,
  /quora\.com\//i,
  /\/issues?\/\d+/i,
  /\/newsletter\/[^/]+\/[^/]+/i,
  /apps\.apple\.com\//i,
  /play\.google\.com\/store\//i,
  /chrome\.google\.com\/webstore\//i,
  /chromewebstore\.google\.com\//i,
  // Academic / paper sites \u2014 also not tools
  /arxiv\.org\/(abs|pdf)\//i,
  /paperswithcode\.com\//i,
  /openreview\.net\//i,
];

function isBlacklisted(url) {
  if (!url) return false;
  return HARD_BLACKLIST_PATTERNS.find(rx => rx.test(url));
}

function parseArgs(argv) {
  const args = { limit: null, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--limit=')) args.limit = parseInt(a.split('=')[1], 10);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const db = dbModule.getClient();

  log.info(`Scanning active tools for blacklisted URLs  dry-run=${args.dryRun}`);

  // Page through everything in 1000-row batches (Supabase caps default returns).
  let allBad = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = db.from('tools')
      .select('id, slug, name, url, source, upvotes')
      .eq('is_active', true)
      .order('upvotes', { ascending: false })
      .range(from, from + pageSize - 1);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const t of data) {
      const match = isBlacklisted(t.url);
      if (match) {
        allBad.push({ ...t, reason: match.toString().slice(0, 60) });
      }
    }
    log.info(`  scanned ${from + data.length} rows  bad-so-far=${allBad.length}`);
    from += pageSize;
    if (args.limit && from >= args.limit) break;
    if (data.length < pageSize) break;
  }

  log.info(`Found ${allBad.length} blacklisted tools.`);

  if (allBad.length === 0) {
    log.info('Nothing to clean up. Done.');
    return;
  }

  // Show a sample
  log.info(`Sample (first 10):`);
  for (const t of allBad.slice(0, 10)) {
    log.info(`  ${(t.slug || '').padEnd(40)} ${(t.url || '').slice(0, 60).padEnd(60)} reason=${t.reason}`);
  }

  if (args.dryRun) {
    log.info(`DRY RUN \u2014 would soft-delete ${allBad.length} rows.`);
    return;
  }

  // Soft-delete in batches of 200
  let cleaned = 0;
  const ids = allBad.map(t => t.id);
  const chunkSize = 200;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { error } = await db.from('tools')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .in('id', chunk);
    if (error) {
      log.warn(`  chunk ${i / chunkSize + 1} failed: ${error.message}`);
    } else {
      cleaned += chunk.length;
      log.info(`  cleaned ${cleaned}/${ids.length}`);
    }
  }

  log.info(`\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
  log.info(`\u2713 Cleanup complete. Soft-deleted ${cleaned} bad tools.`);
  log.info(`\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
