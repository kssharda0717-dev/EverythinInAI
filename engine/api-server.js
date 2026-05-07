/**
 * EverythinInAI Discovery Engine — HTTP API Server
 *
 * Alternative to the Execute Command approach.
 * n8n can call this via HTTP Request nodes instead of shell commands.
 * This is more robust for production use on Oracle Cloud.
 *
 * Endpoints:
 *   POST /run/incremental     — Trigger incremental discovery
 *   POST /run/backfill        — Process next backfill month
 *   POST /run/backfill-init   — Initialize backfill progress
 *   GET  /status              — Engine status
 *   GET  /status/backfill     — Backfill progress
 *   GET  /tools/export        — Export tools as JSON (data.json format)
 *   GET  /health              — Health check
 */

const http = require('http');
const { config, validateConfig } = require('./core/config');
const { DiscoveryStateMachine } = require('./core/state-machine');
const { BackfillManager } = require('./core/backfill');
const db = require('./core/database');
const { createAllCollectors } = require('./collectors');
const { HeuristicPreFilter } = require('./intelligence/pre-filter');
const { GeminiClassifier } = require('./intelligence/classifier');
const { GitHubCommitter } = require('./intelligence/github-committer');
const { createLogger } = require('./utils/logger');

const log = createLogger('server');
const PORT = process.env.PORT || 3847;

// Track running operations to prevent concurrent runs
let isRunning = false;
let currentOperation = null;

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  try {
    // Health check
    if (path === '/health' && method === 'GET') {
      return sendJson(res, 200, { status: 'ok', isRunning, currentOperation, timestamp: new Date().toISOString() });
    }

    // Engine status
    if (path === '/status' && method === 'GET') {
      const toolCount = await db.getToolCount();
      const latestInc = await db.getLatestRun('incremental');
      const latestBf = await db.getLatestRun('backfill');
      return sendJson(res, 200, { toolCount, latestIncremental: latestInc, latestBackfill: latestBf, isRunning });
    }

    // Backfill status
    if (path === '/status/backfill' && method === 'GET') {
      const manager = new BackfillManager();
      const progress = await manager.getProgress();
      return sendJson(res, 200, progress);
    }

    // Export tools
    if (path === '/tools/export' && method === 'GET') {
      const data = await db.exportToolsAsJson();
      return sendJson(res, 200, data);
    }

    // Prevent concurrent runs
    if (isRunning) {
      return sendJson(res, 409, { error: 'Engine is already running', operation: currentOperation });
    }

    // Run incremental
    if (path === '/run/incremental' && method === 'POST') {
      isRunning = true;
      currentOperation = 'incremental';

      // Run async — respond immediately
      const runPromise = runIncremental().finally(() => {
        isRunning = false;
        currentOperation = null;
      });

      // Wait for completion (with timeout)
      const result = await Promise.race([
        runPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 540000)), // 9 min timeout
      ]);

      return sendJson(res, 200, { success: true, result });
    }

    // Run backfill
    if (path === '/run/backfill' && method === 'POST') {
      isRunning = true;
      currentOperation = 'backfill';

      try {
        const result = await runBackfill();
        return sendJson(res, 200, { success: true, result });
      } finally {
        isRunning = false;
        currentOperation = null;
      }
    }

    // Initialize backfill
    if (path === '/run/backfill-init' && method === 'POST') {
      const manager = new BackfillManager();
      const count = await manager.initialize();
      return sendJson(res, 200, { success: true, monthsInitialized: count });
    }

    // 404
    sendJson(res, 404, { error: 'Not found' });

  } catch (error) {
    log.error(`Request error: ${error.message}`);
    isRunning = false;
    currentOperation = null;
    sendJson(res, 500, { error: error.message });
  }
}

async function runIncremental() {
  const hours = config.engine.incrementalHours;
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - (hours * 60 * 60);

  const sm = new DiscoveryStateMachine({
    runId: `inc_${Date.now()}`,
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

async function runBackfill() {
  const manager = new BackfillManager();
  await manager.initialize();
  const result = await manager.processNextMonth();
  const progress = await manager.getProgress();
  return { processed: result, progress };
}

// Start server
const server = http.createServer(handleRequest);
server.listen(PORT, '0.0.0.0', () => {
  log.info(`EverythinInAI Engine API running on port ${PORT}`);
});
