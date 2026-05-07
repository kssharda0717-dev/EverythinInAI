/**
 * EverythinInAI Discovery Engine — Main Entry Point
 *
 * Usage:
 *   node src/index.js                    # Run in mode specified by ENGINE_MODE env var
 *   node src/index.js incremental        # Run incremental discovery (last 6 hours)
 *   node src/index.js backfill           # Process next backfill month
 *   node src/index.js backfill-init      # Initialize backfill progress table
 *   node src/index.js backfill-status    # Show backfill progress
 *   node src/index.js backfill-commit    # Final GitHub commit after backfill
 *   node src/index.js status             # Show engine status
 *
 * This file is designed to be called by n8n's Execute Command node,
 * by a cron job, or directly from the command line.
 */

const { config, validateConfig } = require('./core/config');
const { DiscoveryStateMachine } = require('./core/state-machine');
const { BackfillManager } = require('./core/backfill');
const db = require('./core/database');
const { createAllCollectors } = require('./collectors');
const { HeuristicPreFilter } = require('./intelligence/pre-filter');
const { GeminiClassifier } = require('./intelligence/classifier');
const { GitHubCommitter } = require('./intelligence/github-committer');
const { createLogger } = require('./utils/logger');

const log = createLogger('main');

// ═══════════════════════════════════════════════════════════════════════════════
// INCREMENTAL MODE
// ═══════════════════════════════════════════════════════════════════════════════

async function runIncremental() {
  log.info('═══════════════════════════════════════════════════');
  log.info('  EverythinInAI Discovery Engine — INCREMENTAL');
  log.info('═══════════════════════════════════════════════════');

  // Check for incomplete runs (crash recovery)
  const incompleteRun = await db.getIncompleteRun();
  if (incompleteRun) {
    log.info(`Found incomplete run: ${incompleteRun.id} (state: ${incompleteRun.state})`);

    const sm = new DiscoveryStateMachine({
      collectors: createAllCollectors(),
      preFilter: new HeuristicPreFilter(),
      classifier: new GeminiClassifier(),
      committer: new GitHubCommitter(),
    });

    await sm.resume(incompleteRun);
    return await sm.execute();
  }

  // Fresh incremental run
  const hours = config.engine.incrementalHours;
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - (hours * 60 * 60);

  const runId = `inc_${Date.now()}`;
  const sm = new DiscoveryStateMachine({
    runId,
    mode: 'incremental',
    sinceTimestamp: sinceSec,
    untilTimestamp: nowSec,
    collectors: createAllCollectors(),
    preFilter: new HeuristicPreFilter(),
    classifier: new GeminiClassifier(),
    committer: new GitHubCommitter(),
  });

  return await sm.execute();
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKFILL MODE
// ═══════════════════════════════════════════════════════════════════════════════

async function runBackfill() {
  log.info('═══════════════════════════════════════════════════');
  log.info('  EverythinInAI Discovery Engine — BACKFILL');
  log.info('═══════════════════════════════════════════════════');

  const manager = new BackfillManager();

  // Initialize if needed
  await manager.initialize();

  // Show progress
  const progress = await manager.getProgress();
  log.info(`Backfill progress: ${progress.completed}/${progress.total} months (${progress.percent}%)`);

  if (progress.pending === 0 && progress.failed === 0 && progress.inProgress === 0) {
    log.info('Backfill is complete! Running final commit...');
    await manager.finalCommit();

    // Auto-disable the backfill systemd timer so we stop firing pointless invocations.
    // Safe no-op if systemd is not available (e.g. running on a Mac).
    try {
      const { execSync } = require('child_process');
      execSync('sudo systemctl disable --now everythinginai-backfill.timer 2>/dev/null', { stdio: 'ignore' });
      log.info('Auto-disabled backfill systemd timer (backfill complete).');
    } catch (e) {
      log.debug('Could not auto-disable backfill timer (no systemd or no sudo). Manual disable recommended.');
    }

    return { status: 'complete', progress };
  }

  // Process next month
  const result = await manager.processNextMonth();
  const updatedProgress = await manager.getProgress();

  return {
    status: 'in_progress',
    processed: result,
    progress: updatedProgress,
  };
}

async function initBackfill() {
  const manager = new BackfillManager();
  const count = await manager.initialize();
  log.info(`Initialized ${count} monthly backfill slots`);
  return { monthsInitialized: count };
}

async function backfillStatus() {
  const manager = new BackfillManager();
  const progress = await manager.getProgress();
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  BACKFILL STATUS');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Total months:  ${progress.total}`);
  console.log(`  Completed:     ${progress.completed}`);
  console.log(`  Pending:       ${progress.pending}`);
  console.log(`  In Progress:   ${progress.inProgress}`);
  console.log(`  Failed:        ${progress.failed}`);
  console.log(`  Progress:      ${progress.percent}%`);
  console.log('═══════════════════════════════════════════════════\n');
  return progress;
}

async function backfillCommit() {
  const manager = new BackfillManager();
  await manager.finalCommit();
  log.info('Final backfill commit completed');
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════════════════════════

async function showStatus() {
  const toolCount = await db.getToolCount();
  const latestIncremental = await db.getLatestRun('incremental');
  const latestBackfill = await db.getLatestRun('backfill');

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  EVERYTHININAI ENGINE STATUS');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Total tools in database: ${toolCount}`);
  console.log(`  Latest incremental run:  ${latestIncremental?.id || 'none'} (${latestIncremental?.state || 'n/a'})`);
  console.log(`  Latest backfill run:     ${latestBackfill?.id || 'none'} (${latestBackfill?.state || 'n/a'})`);
  console.log('═══════════════════════════════════════════════════\n');

  return { toolCount, latestIncremental, latestBackfill };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  // Validate configuration
  const errors = validateConfig();
  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }

  const command = process.argv[2] || config.engine.mode;

  try {
    let result;

    switch (command) {
      case 'incremental':
        result = await runIncremental();
        break;
      case 'backfill':
        result = await runBackfill();
        break;
      case 'backfill-init':
        result = await initBackfill();
        break;
      case 'backfill-status':
        result = await backfillStatus();
        break;
      case 'backfill-commit':
        result = await backfillCommit();
        break;
      case 'status':
        result = await showStatus();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Usage: node src/index.js [incremental|backfill|backfill-init|backfill-status|backfill-commit|status]');
        process.exit(1);
    }

    // Output result as JSON for n8n to parse
    if (result) {
      console.log('\n__ENGINE_RESULT__');
      console.log(JSON.stringify(result, null, 2));
    }

    process.exit(0);

  } catch (error) {
    log.error(`Fatal: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
