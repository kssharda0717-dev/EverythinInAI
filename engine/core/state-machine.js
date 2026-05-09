/**
 * EverythinInAI Discovery Engine — State Machine Orchestrator
 *
 * States: INIT → COLLECT → NORMALIZE → FILTER → CLASSIFY → MERGE → COMMIT → DONE
 *
 * Each state transition is checkpointed to the database.
 * If the process crashes, it resumes from the last successful state.
 * This replaces the fragile linear n8n pipeline with a resilient,
 * self-healing execution model.
 */

const { createLogger } = require('../utils/logger');
const { config } = require('./config');
const db = require('./database');
const { getRateLimiter } = require('./rate-limiter');

const log = createLogger('state-machine');

// State transition map — defines valid transitions
const TRANSITIONS = {
  init:        ['collecting'],
  collecting:  ['normalizing', 'failed'],
  normalizing: ['filtering', 'failed'],
  filtering:   ['classifying', 'failed'],
  classifying: ['merging', 'failed'],
  merging:     ['committing', 'failed'],
  committing:  ['done', 'failed'],
  done:        [],
  failed:      [],
};

class DiscoveryStateMachine {
  constructor(options = {}) {
    this.runId = options.runId || `run_${Date.now()}`;
    this.mode = options.mode || config.engine.mode;
    this.sinceTimestamp = options.sinceTimestamp || 0;
    this.untilTimestamp = options.untilTimestamp || Math.floor(Date.now() / 1000);
    this.state = 'init';
    this.collectors = options.collectors || [];
    this.classifier = options.classifier || null;
    this.preFilter = options.preFilter || null;
    this.merger = options.merger || null;
    this.committer = options.committer || null;

    // Accumulated data (in-memory between states)
    this.rawItems = [];
    this.normalizedItems = [];
    this.filteredItems = [];

    // Stats
    this.stats = {
      collected: 0,
      normalized: 0,
      filtered: 0,
      classified: 0,
      merged: 0,
      rejected: 0,
      errors: [],
    };
  }

  /**
   * Transition to a new state with validation.
   */
  async transition(newState) {
    // Idempotent: re-transitioning to the same state during resume is a no-op.
    if (this.state === newState) {
      return;
    }
    const allowed = TRANSITIONS[this.state];
    if (!allowed || !allowed.includes(newState)) {
      throw new Error(`Invalid transition: ${this.state} → ${newState}. Allowed: [${allowed?.join(', ')}]`);
    }

    const oldState = this.state;
    this.state = newState;

    // Checkpoint to database
    await db.updateRunState(this.runId, newState, {
      items_collected: this.stats.collected,
      items_filtered: this.stats.filtered,
      items_classified: this.stats.classified,
      items_merged: this.stats.merged,
      items_rejected: this.stats.rejected,
      checkpoint: {
        lastState: oldState,
        transitionedAt: new Date().toISOString(),
        rateLimiter: getRateLimiter().getStats(),
      },
    });

    log.info(`State: ${oldState} → ${newState}`);
  }

  /**
   * Resume from a crashed run.
   */
  async resume(existingRun) {
    this.runId = existingRun.id;
    this.mode = existingRun.mode;
    this.state = existingRun.state;
    this.sinceTimestamp = existingRun.since_timestamp;
    this.untilTimestamp = existingRun.until_timestamp;
    this.stats.collected = existingRun.items_collected || 0;
    this.stats.filtered = existingRun.items_filtered || 0;
    this.stats.classified = existingRun.items_classified || 0;
    this.stats.merged = existingRun.items_merged || 0;
    this.stats.rejected = existingRun.items_rejected || 0;

    log.info(`Resuming run ${this.runId} from state: ${this.state}`);
    return this.state;
  }

  /**
   * Execute the full pipeline from current state to DONE.
   */
  async execute() {
    try {
      // If resuming, skip to the appropriate state
      const stateOrder = ['init', 'collecting', 'normalizing', 'filtering', 'classifying', 'merging', 'committing', 'done'];
      const startIndex = stateOrder.indexOf(this.state);

      if (startIndex <= 0) {
        // Fresh run
        await db.createRun(this.runId, this.mode, this.sinceTimestamp, this.untilTimestamp);
        await this._executeCollect();
      }
      if (startIndex <= 1) await this._executeNormalize();
      if (startIndex <= 2) await this._executeFilter();
      if (startIndex <= 3) await this._executeClassify();
      if (startIndex <= 5) await this._executeMerge();
      if (startIndex <= 6) await this._executeCommit();

      await this.transition('done');
      log.info('═══════════════════════════════════════════════════');
      log.info(`  RUN COMPLETE: ${this.runId}`);
      log.info(`  Collected: ${this.stats.collected}`);
      log.info(`  Filtered:  ${this.stats.filtered}`);
      log.info(`  Classified: ${this.stats.classified}`);
      log.info(`  Merged:    ${this.stats.merged}`);
      log.info(`  Rejected:  ${this.stats.rejected}`);
      log.info('═══════════════════════════════════════════════════');

      return this.stats;

    } catch (error) {
      log.error(`Fatal error in state ${this.state}: ${error.message}`);
      this.stats.errors.push({ state: this.state, error: error.message, at: new Date().toISOString() });

      try {
        await this.transition('failed');
      } catch (e) {
        log.error(`Failed to transition to failed state: ${e.message}`);
      }

      throw error;
    }
  }

  // ─── STATE HANDLERS ─────────────────────────────────────────────────────────

  async _executeCollect() {
    await this.transition('collecting');
    log.info(`Collecting from ${this.collectors.length} sources...`);

    const allItems = [];
    for (const collector of this.collectors) {
      try {
        const items = await collector.collect(this.sinceTimestamp, this.untilTimestamp);
        log.info(`  ${collector.name}: ${items.length} items`);
        allItems.push(...items);
      } catch (error) {
        log.error(`  ${collector.name} FAILED: ${error.message}`);
        this.stats.errors.push({ collector: collector.name, error: error.message });
        // Continue with other collectors — one failure should not kill the run
      }
    }

    this.rawItems = allItems;
    this.stats.collected = allItems.length;
    log.info(`Total collected: ${allItems.length}`);
  }

  async _executeNormalize() {
    await this.transition('normalizing');
    // Items are already normalized by individual collectors.
    // This step does cross-source deduplication by URL.
    const seen = new Set();
    const unique = [];

    for (const item of this.rawItems) {
      const normUrl = this._normalizeUrl(item.url);
      if (!normUrl || seen.has(normUrl)) continue;
      seen.add(normUrl);
      unique.push({ ...item, url_normalized: normUrl });
    }

    this.normalizedItems = unique;
    this.stats.normalized = unique.length;
    log.info(`Normalized: ${this.rawItems.length} → ${unique.length} unique items`);
  }

  async _executeFilter() {
    await this.transition('filtering');

    if (!this.preFilter) {
      log.warn('No pre-filter configured, passing all items through');
      this.filteredItems = this.normalizedItems;
      this.stats.filtered = this.filteredItems.length;
      return;
    }

    const results = this.preFilter.filterAll(this.normalizedItems);
    this.filteredItems = results.passed;
    this.stats.filtered = results.passed.length;
    this.stats.rejected += results.rejected.length;

    log.info(`Filtered: ${this.normalizedItems.length} → ${results.passed.length} passed, ${results.rejected.length} rejected`);

    // Enqueue passed items to the database queue
    const enqueued = await db.enqueueItems(results.passed, this.runId);
    log.info(`Enqueued ${enqueued} items for classification`);
  }

  async _executeClassify() {
    await this.transition('classifying');

    if (!this.classifier) {
      log.warn('No classifier configured, skipping classification');
      return;
    }

    const batchSize = config.gemini.batchSize;
    const rateLimiter = getRateLimiter();
    let totalClassified = 0;
    let totalRejected = 0;

    while (true) {
      // Check rate limiter pressure
      const pressure = rateLimiter.getPressure();
      if (pressure.rpd >= 0.95) {
        log.warn('Daily API limit reached. Stopping classification. Will resume next run.');
        break;
      }

      // Dequeue a batch
      const batch = await db.dequeueItemsForClassification(batchSize, this.runId);
      if (batch.length === 0) {
        log.info('No more items to classify');
        break;
      }

      // Wait for rate limit slot
      const slot = await rateLimiter.waitForSlot(batch.length * 500);
      if (slot.shouldStop) {
        log.warn(`Rate limiter says stop: ${slot.reason}`);
        // Re-mark items as pending so they can be picked up next run
        for (const item of batch) {
          await db.markItemError(item.id, `Deferred: ${slot.reason}`);
        }
        break;
      }

      // Classify the batch
      try {
        const results = await this.classifier.classifyBatch(batch);
        rateLimiter.recordSuccess(results.estimatedTokens || 2000);

        for (const result of results.items) {
          // v2: accept anything with a valid type AND confidence ≥ 0.6
          // Phase 17: tool threshold bumped 0.7 → 0.75 to keep marginal items out of the directory.
          const isAcceptedTool = result.type === 'tool' && result.confidence >= 0.75;
          const isAcceptedSignal = result.type && result.type !== 'tool' && result.confidence >= 0.6;

          if (isAcceptedTool || isAcceptedSignal) {
            await db.markItemClassified(result.queueId, result);
            totalClassified++;
          } else {
            await db.markItemRejected(
              result.queueId,
              `Not classifiable (type: ${result.type || 'null'}, confidence: ${result.confidence})`
            );
            totalRejected++;
          }
        }

        log.info(`Batch: ${results.items.length} processed (${totalClassified} tools, ${totalRejected} rejected)`);

      } catch (error) {
        const statusCode = error.response?.status || error.statusCode || 500;
        rateLimiter.recordError(statusCode);

        if (statusCode === 429 || statusCode === 503) {
          // Re-mark items as pending for retry
          for (const item of batch) {
            await db.markItemError(item.id, `API error ${statusCode}, will retry`);
          }
          log.warn(`API error ${statusCode}, items re-queued for retry`);
        } else {
          for (const item of batch) {
            await db.markItemError(item.id, `Classification error: ${error.message}`);
          }
          log.error(`Classification error: ${error.message}`);
        }
      }
    }

    this.stats.classified = totalClassified;
    this.stats.rejected += totalRejected;
    log.info(`Classification complete: ${totalClassified} tools found, ${totalRejected} rejected`);
  }

  async _executeMerge() {
    await this.transition('merging');

    const classifiedItems = await db.getClassifiedItems(this.runId);
    let merged = 0;
    let mergedSignals = 0;
    let skipped = 0;

    for (const item of classifiedItems) {
      const geminiData = item.gemini_response;
      if (!geminiData || !geminiData.name || !geminiData.url) {
        await db.markItemRejected(item.id, 'Missing name or URL from Gemini');
        skipped++;
        continue;
      }

      // v2 BRANCH: route signals (news/research/drama/etc.) to ai_signals table
      if (geminiData.type && geminiData.type !== 'tool') {
        try {
          const urlNorm = this._normalizeUrl(geminiData.url);
          const dup = await db.checkSignalDuplicate(urlNorm);
          if (dup.isDuplicate) {
            await db.markItemRejected(item.id, `Duplicate signal: "${dup.matchedTitle}"`);
            skipped++;
            continue;
          }
          await db.insertSignal({
            ...geminiData,
            source: item.source,
            source_url: item.source_url,
            author: item.author,
            upvotes: item.upvotes,
            comments: item.comments,
            published_at: item.published_at,
            run_id: this.runId,
          });
          const dbClient = db.getClient();
          await dbClient.from('discovery_queue').update({ status: 'merged' }).eq('id', item.id);
          mergedSignals++;
        } catch (err) {
          log.error(`Failed to merge signal ${geminiData.name}: ${err.message}`);
          await db.markItemError(item.id, `Signal merge error: ${err.message}`);
          skipped++;
        }
        continue;
      }

      // Fuzzy deduplication check
      const urlNorm = this._normalizeUrl(geminiData.url);
      const dupCheck = await db.checkDuplicate(geminiData.name, urlNorm);

      if (dupCheck.isDuplicate) {
        await db.markItemRejected(item.id, `Duplicate of "${dupCheck.matchedName}" (${dupCheck.matchType}, similarity: ${dupCheck.similarity})`);
        skipped++;
        continue;
      }

      // Insert into tools table
      try {
        const tool = await db.insertTool({
          name: geminiData.name,
          tagline: geminiData.tagline || '',
          description: geminiData.description || '',
          url: geminiData.url,
          category: geminiData.category || 'Other',
          tags: geminiData.tags || [],
          pricing: geminiData.pricing || 'unknown',
          source: item.source,
          source_url: item.source_url,
          confidence: geminiData.confidence,
          upvotes: item.upvotes,
          author: item.author,
          homepage: item.homepage || '',
          language: item.language || '',
          topics: item.topics || [],
          published_at: item.published_at,
          run_id: this.runId,
        });

        if (tool) {
          // Update queue item status
          const dbClient = db.getClient();
          await dbClient.from('discovery_queue')
            .update({ status: 'merged' })
            .eq('id', item.id);
          merged++;
        } else {
          skipped++;
        }
      } catch (error) {
        log.error(`Failed to merge tool ${geminiData.name}: ${error.message}`);
        await db.markItemError(item.id, `Merge error: ${error.message}`);
        skipped++;
      }
    }

    this.stats.merged = merged + mergedSignals;
    log.info(`Merge complete: ${merged} tools, ${mergedSignals} signals added, ${skipped} skipped`);
  }

  async _executeCommit() {
    await this.transition('committing');

    // Export to data.json for backwards compatibility with GitHub
    if (this.committer) {
      try {
        const exportData = await db.exportToolsAsJson();
        await this.committer.commit(exportData, this.runId);
        log.info(`Committed ${exportData.tools.length} tools to GitHub`);
      } catch (error) {
        log.error(`GitHub commit failed (non-fatal): ${error.message}`);
        this.stats.errors.push({ phase: 'commit', error: error.message });
        // Non-fatal — data is safe in Supabase
      }
    } else {
      log.info('No committer configured, skipping GitHub sync');
    }
  }

  // ─── UTILITIES ──────────────────────────────────────────────────────────────

  _normalizeUrl(raw) {
    if (!raw) return '';
    try {
      const u = new URL(raw.trim());
      // Strip www, trailing slash, query params, fragments
      const host = u.hostname.replace(/^www\./, '').toLowerCase();
      const path = u.pathname.replace(/\/$/, '');
      return `${host}${path}`;
    } catch {
      return raw.trim().toLowerCase().replace(/\/$/, '');
    }
  }
}

module.exports = { DiscoveryStateMachine };
