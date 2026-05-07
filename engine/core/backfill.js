/**
 * EverythinInAI Discovery Engine — Cold Start Backfill System
 *
 * THE PROBLEM:
 * The old workflow tried to fetch 3 years of data in a single run.
 * This would: (a) blow Gemini's daily API limit, (b) exhaust n8n memory,
 * (c) hit GitHub Search API's 1000-result cap, (d) have zero recovery on crash.
 *
 * THE SOLUTION:
 * Break the 3-year backfill into monthly chunks. Each month is an independent
 * unit of work tracked in the `backfill_progress` table.
 *
 * Execution model:
 *   1. On first run, initialize 36 monthly slots (2023-01 through 2025-12).
 *   2. Each invocation processes ONE month (the oldest pending month).
 *   3. If the process crashes mid-month, that month is marked "failed" and
 *      retried on the next invocation.
 *   4. When all months are "completed", the backfill is done.
 *   5. n8n (or cron) triggers this every 10-15 minutes during backfill.
 *
 * This means:
 *   - A 3-year backfill takes ~36 invocations (6-9 hours at 10-15 min intervals)
 *   - Each invocation stays well within Gemini's free tier limits
 *   - Any crash only loses one month of progress
 *   - The system is fully autonomous — no manual intervention needed
 */

const db = require('./database');
const { DiscoveryStateMachine } = require('./state-machine');
const { createAllCollectors } = require('../collectors');
const { HeuristicPreFilter } = require('../intelligence/pre-filter');
const { GeminiClassifier } = require('../intelligence/classifier');
const { GitHubCommitter } = require('../intelligence/github-committer');
const { createLogger } = require('../utils/logger');

const log = createLogger('backfill');

class BackfillManager {
  constructor() {
    this.startYear = 2023;
    this.startMonth = 1;
  }

  /**
   * Initialize the backfill progress table if not already done.
   */
  async initialize() {
    const now = new Date();
    const endYear = now.getFullYear();
    const endMonth = now.getMonth() + 1;

    const count = await db.initBackfillProgress(
      this.startYear, this.startMonth, endYear, endMonth
    );
    log.info(`Backfill initialized: ${count} monthly slots`);
    return count;
  }

  /**
   * Process the next pending month.
   * Returns null if all months are completed.
   */
  async processNextMonth() {
    // Check for any failed months first (retry them)
    const failedMonth = await this._getFailedMonth();
    const nextMonth = failedMonth || await db.getNextBackfillMonth();

    if (!nextMonth) {
      log.info('All backfill months completed!');
      return null;
    }

    const yearMonth = nextMonth.year_month;
    log.info(`Processing backfill month: ${yearMonth}`);

    // Calculate time range for this month
    const [year, month] = yearMonth.split('-').map(Number);
    const sinceDate = new Date(year, month - 1, 1);
    const untilDate = new Date(year, month, 0, 23, 59, 59); // Last day of month
    const sinceTimestamp = Math.floor(sinceDate.getTime() / 1000);
    const untilTimestamp = Math.floor(untilDate.getTime() / 1000);

    // Mark as in_progress
    await db.updateBackfillMonth(yearMonth, {
      status: 'in_progress',
      started_at: new Date().toISOString(),
      run_id: '',
    });

    try {
      // Create and execute a state machine for this month
      const runId = `backfill_${yearMonth}_${Date.now()}`;
      const sm = new DiscoveryStateMachine({
        runId,
        mode: 'backfill',
        sinceTimestamp,
        untilTimestamp,
        collectors: createAllCollectors(),
        preFilter: new HeuristicPreFilter({ maxItems: 300 }), // Conservative for backfill
        classifier: new GeminiClassifier(),
        committer: null, // Don't commit to GitHub on every month — do it at the end
      });

      await db.updateBackfillMonth(yearMonth, { run_id: runId });

      const stats = await sm.execute();

      // Mark month as completed
      await db.updateBackfillMonth(yearMonth, {
        status: 'completed',
        items_found: stats.collected,
        items_processed: stats.merged,
        completed_at: new Date().toISOString(),
      });

      log.info(`Backfill month ${yearMonth} completed: ${stats.merged} tools added`);
      return { yearMonth, stats };

    } catch (error) {
      log.error(`Backfill month ${yearMonth} failed: ${error.message}`);

      await db.updateBackfillMonth(yearMonth, {
        status: 'failed',
        error_message: error.message,
      });

      throw error;
    }
  }

  /**
   * Get the overall backfill progress.
   */
  async getProgress() {
    const client = db.getClient();

    const { data: all } = await client.from('backfill_progress')
      .select('status')
      .order('year_month');

    if (!all) return { total: 0, completed: 0, pending: 0, failed: 0, inProgress: 0, percent: 0 };

    const counts = { total: all.length, completed: 0, pending: 0, failed: 0, in_progress: 0 };
    for (const row of all) {
      counts[row.status] = (counts[row.status] || 0) + 1;
    }

    return {
      total: counts.total,
      completed: counts.completed,
      pending: counts.pending,
      failed: counts.failed,
      inProgress: counts.in_progress,
      percent: counts.total > 0 ? Math.round((counts.completed / counts.total) * 100) : 0,
    };
  }

  /**
   * After all months are done, do a final GitHub commit.
   */
  async finalCommit() {
    const committer = new GitHubCommitter();
    const exportData = await db.exportToolsAsJson();
    await committer.commit(exportData, 'backfill_final');
    log.info(`Final backfill commit: ${exportData.metadata.totalTools} tools`);
  }

  async _getFailedMonth() {
    const client = db.getClient();
    const { data } = await client.from('backfill_progress')
      .select('*')
      .eq('status', 'failed')
      .order('year_month', { ascending: true })
      .limit(1)
      .maybeSingle();
    return data;
  }
}

module.exports = { BackfillManager };
