#!/usr/bin/env node
/**
 * EverythinInAI — Retroactive Homepage Validator
 *
 * One-shot cleanup. Goes through every tool with a non-empty `homepage`,
 * HEAD-checks the URL, and clears (sets to NULL) any dead ones.
 *
 * The frontend already has the right fallback: when `homepage` is empty,
 * the "Visit" button uses `url` (the GitHub or source URL) instead. So
 * clearing dead homepages just makes the frontend gracefully fall back.
 *
 * Usage:
 *   node scripts/validate_homepages.js                      # check all
 *   node scripts/validate_homepages.js --limit=500          # only top 500
 *   node scripts/validate_homepages.js --concurrency=20     # default 10
 *   node scripts/validate_homepages.js --dry-run            # don't write
 *
 * Speed: ~10 URLs/sec at concurrency=10. 10,000 tools = ~17 min.
 * Cost: $0 (network only).
 */

const dbModule = require('../engine/core/database');
const { createLogger } = require('../engine/utils/logger');
const { isLiveUrl } = require('../engine/utils/url_validator');

const log = createLogger('validate_homepages');

function parseArgs(argv) {
  const args = { limit: null, concurrency: 10, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--limit=')) args.limit = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--concurrency=')) args.concurrency = parseInt(a.split('=')[1], 10);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const db = dbModule.getClient();

  log.info(`Fetching tools with non-empty homepage...`);
  let q = db.from('tools')
    .select('id, slug, homepage')
    .eq('is_active', true)
    .not('homepage', 'is', null)
    .neq('homepage', '');
  if (args.limit) q = q.order('upvotes', { ascending: false }).limit(args.limit);
  const { data, error } = await q;
  if (error) throw error;

  log.info(`${data.length} tools to check  concurrency=${args.concurrency}  dry-run=${args.dryRun}`);

  let alive = 0, dead = 0, redirected = 0, errors = 0;
  let idx = 0;

  async function worker() {
    while (idx < data.length) {
      const i = idx++;
      const t = data[i];
      try {
        const check = await isLiveUrl(t.homepage, { strict: true });
        if (check.ok) {
          alive++;
          if (check.finalUrl && check.finalUrl !== t.homepage) {
            redirected++;
            if (!args.dryRun) {
              await db.from('tools').update({ homepage: check.finalUrl, updated_at: new Date().toISOString() }).eq('id', t.id);
            }
          }
        } else {
          dead++;
          log.warn(`  ✗ ${t.slug.padEnd(28)} ${t.homepage}  (${check.status})`);
          if (!args.dryRun) {
            await db.from('tools').update({ homepage: null, updated_at: new Date().toISOString() }).eq('id', t.id);
          }
        }
      } catch (err) {
        errors++;
      }

      if ((i + 1) % 50 === 0) {
        log.info(`Progress: ${i + 1}/${data.length}  alive=${alive} dead=${dead} redirected=${redirected} errors=${errors}`);
      }
    }
  }

  await Promise.all(Array(args.concurrency).fill(0).map(worker));

  log.info(`══════════════════════════════════════════════`);
  log.info(`✓ Validation complete.`);
  log.info(`   Alive:      ${alive}`);
  log.info(`   Dead:       ${dead} ${args.dryRun ? '(would clear)' : '(cleared)'}`);
  log.info(`   Redirected: ${redirected} ${args.dryRun ? '(would update)' : '(updated)'}`);
  log.info(`   Errors:     ${errors}`);
  log.info(`══════════════════════════════════════════════`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
