/**
 * EverythinInAI Discovery Engine — Dynamic Rate Limiter & Queue Manager
 *
 * This is NOT a "Wait 4s" node. This is a production-grade adaptive rate limiter
 * that tracks three dimensions of Gemini's free tier simultaneously:
 *   1. Requests Per Minute (RPM) — sliding window
 *   2. Tokens Per Minute (TPM) — estimated from payload size
 *   3. Requests Per Day (RPD) — daily counter with midnight reset
 *
 * On 429 or 503 errors, it applies exponential backoff with jitter.
 * It also provides a "pressure gauge" that the state machine can query
 * to decide whether to continue or pause.
 */

const { config } = require('./config');
const { createLogger } = require('../utils/logger');

const log = createLogger('rate-limiter');

class DynamicRateLimiter {
  constructor(options = {}) {
    this.rpmLimit = options.rpmLimit || config.gemini.rpmLimit;
    this.tpmLimit = options.tpmLimit || config.gemini.tpmLimit;
    this.rpdLimit = options.rpdLimit || config.gemini.rpdLimit;

    // Sliding window for RPM (stores timestamps of recent requests)
    this.requestTimestamps = [];

    // Token tracking for TPM (stores { timestamp, tokens } pairs)
    this.tokenLog = [];

    // Daily counter
    this.dailyCount = 0;
    this.dailyResetDate = this._todayString();

    // Backoff state
    this.consecutiveErrors = 0;
    this.baseBackoffMs = 2000;
    this.maxBackoffMs = 120000; // 2 minutes max
    this.isBackingOff = false;

    // Metrics
    this.totalRequests = 0;
    this.totalErrors = 0;
    this.totalTokens = 0;
  }

  _todayString() {
    return new Date().toISOString().substring(0, 10);
  }

  _cleanSlidingWindow(windowMs = 60000) {
    const cutoff = Date.now() - windowMs;
    this.requestTimestamps = this.requestTimestamps.filter(ts => ts > cutoff);
    this.tokenLog = this.tokenLog.filter(entry => entry.timestamp > cutoff);
  }

  _resetDailyIfNeeded() {
    const today = this._todayString();
    if (today !== this.dailyResetDate) {
      log.info(`Daily counter reset (was ${this.dailyCount})`);
      this.dailyCount = 0;
      this.dailyResetDate = today;
    }
  }

  /**
   * Estimate token count from a string payload.
   * Rough approximation: 1 token ≈ 4 characters for English text.
   */
  estimateTokens(payload) {
    if (typeof payload === 'string') return Math.ceil(payload.length / 4);
    if (typeof payload === 'object') return Math.ceil(JSON.stringify(payload).length / 4);
    return 100; // fallback
  }

  /**
   * Get the current "pressure" across all three dimensions.
   * Returns a value between 0.0 (no pressure) and 1.0 (at limit).
   */
  getPressure() {
    this._cleanSlidingWindow();
    this._resetDailyIfNeeded();

    const rpmPressure = this.requestTimestamps.length / this.rpmLimit;
    const tpmTokens = this.tokenLog.reduce((sum, e) => sum + e.tokens, 0);
    const tpmPressure = tpmTokens / this.tpmLimit;
    const rpdPressure = this.dailyCount / this.rpdLimit;

    return {
      rpm: Math.min(1.0, rpmPressure),
      tpm: Math.min(1.0, tpmPressure),
      rpd: Math.min(1.0, rpdPressure),
      max: Math.min(1.0, Math.max(rpmPressure, tpmPressure, rpdPressure)),
      isBackingOff: this.isBackingOff,
      canProceed: rpmPressure < 0.9 && tpmPressure < 0.9 && rpdPressure < 0.95 && !this.isBackingOff,
    };
  }

  /**
   * Wait until it's safe to make a request.
   * Returns the estimated wait time in ms (0 if no wait needed).
   */
  async waitForSlot(estimatedTokens = 500) {
    this._cleanSlidingWindow();
    this._resetDailyIfNeeded();

    let totalWait = 0;

    // Check daily limit first (hardest constraint)
    if (this.dailyCount >= this.rpdLimit * 0.95) {
      const msUntilMidnight = this._msUntilMidnight();
      log.warn(`Daily limit approaching (${this.dailyCount}/${this.rpdLimit}). Pausing until midnight (${Math.round(msUntilMidnight / 60000)}m)`);
      // Don't actually wait until midnight — signal the caller to stop
      return { wait: msUntilMidnight, shouldStop: true, reason: 'daily_limit' };
    }

    // Check RPM
    while (this.requestTimestamps.length >= this.rpmLimit) {
      const oldestRequest = this.requestTimestamps[0];
      const waitMs = Math.max(0, oldestRequest + 60000 - Date.now()) + 100;
      log.debug(`RPM limit reached (${this.requestTimestamps.length}/${this.rpmLimit}), waiting ${waitMs}ms`);
      await this._sleep(waitMs);
      totalWait += waitMs;
      this._cleanSlidingWindow();
    }

    // Check TPM
    const currentTokens = this.tokenLog.reduce((sum, e) => sum + e.tokens, 0);
    if (currentTokens + estimatedTokens > this.tpmLimit * 0.9) {
      const oldestToken = this.tokenLog[0];
      const waitMs = oldestToken ? Math.max(0, oldestToken.timestamp + 60000 - Date.now()) + 100 : 5000;
      log.debug(`TPM limit approaching (${currentTokens}/${this.tpmLimit}), waiting ${waitMs}ms`);
      await this._sleep(waitMs);
      totalWait += waitMs;
      this._cleanSlidingWindow();
    }

    // Apply backoff if we've been getting errors
    if (this.consecutiveErrors > 0) {
      const backoffMs = this._calculateBackoff();
      log.info(`Backoff: ${backoffMs}ms (${this.consecutiveErrors} consecutive errors)`);
      this.isBackingOff = true;
      await this._sleep(backoffMs);
      totalWait += backoffMs;
      this.isBackingOff = false;
    }

    return { wait: totalWait, shouldStop: false, reason: null };
  }

  /**
   * Record a successful request.
   */
  recordSuccess(estimatedTokens = 500) {
    const now = Date.now();
    this.requestTimestamps.push(now);
    this.tokenLog.push({ timestamp: now, tokens: estimatedTokens });
    this.dailyCount++;
    this.totalRequests++;
    this.totalTokens += estimatedTokens;
    this.consecutiveErrors = 0; // Reset backoff on success
  }

  /**
   * Record a failed request (429, 503, or other error).
   */
  recordError(statusCode) {
    this.consecutiveErrors++;
    this.totalErrors++;

    if (statusCode === 429) {
      log.warn(`429 Too Many Requests — consecutive errors: ${this.consecutiveErrors}`);
    } else if (statusCode === 503) {
      log.warn(`503 Service Unavailable — consecutive errors: ${this.consecutiveErrors}`);
    } else {
      log.warn(`API error ${statusCode} — consecutive errors: ${this.consecutiveErrors}`);
    }
  }

  /**
   * Calculate exponential backoff with jitter.
   */
  _calculateBackoff() {
    const exponential = this.baseBackoffMs * Math.pow(2, this.consecutiveErrors - 1);
    const capped = Math.min(exponential, this.maxBackoffMs);
    const jitter = capped * 0.5 * Math.random(); // 0-50% jitter
    return Math.round(capped + jitter);
  }

  _msUntilMidnight() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime() - now.getTime();
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get a summary of the rate limiter's state for logging/monitoring.
   */
  getStats() {
    this._cleanSlidingWindow();
    this._resetDailyIfNeeded();
    return {
      rpm: { current: this.requestTimestamps.length, limit: this.rpmLimit },
      tpm: { current: this.tokenLog.reduce((s, e) => s + e.tokens, 0), limit: this.tpmLimit },
      rpd: { current: this.dailyCount, limit: this.rpdLimit },
      backoff: { consecutiveErrors: this.consecutiveErrors, isBackingOff: this.isBackingOff },
      totals: { requests: this.totalRequests, errors: this.totalErrors, tokens: this.totalTokens },
    };
  }
}

// Singleton instance
let instance = null;
function getRateLimiter() {
  if (!instance) {
    instance = new DynamicRateLimiter();
  }
  return instance;
}

module.exports = { DynamicRateLimiter, getRateLimiter };
