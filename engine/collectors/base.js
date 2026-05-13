/**
 * EverythinInAI Discovery Engine — Base Collector
 *
 * All source collectors extend this class.
 * Provides: retry logic, timeout handling, and a normalized output schema.
 */
const axios = require('axios');
const { createLogger } = require('../utils/logger');

class BaseCollector {
  constructor(name) {
    this.name = name;
    this.log = createLogger(`collector:${name}`);
    this.maxRetries = 3;
    this.retryDelayMs = 2000;
    this.timeoutMs = 15000;
  }

  /**
   * Subclasses MUST implement this method.
   * @param {number} sinceTimestamp - Unix timestamp (seconds) for the start of the window
   * @param {number} untilTimestamp - Unix timestamp (seconds) for the end of the window
   * @returns {Array} Array of normalized items
   */
  async collect(sinceTimestamp, untilTimestamp) {
    throw new Error(`${this.name}.collect() not implemented`);
  }

  /**
   * HTTP GET with retry logic.
   */
  async fetchWithRetry(url, options = {}) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await axios.get(url, {
          timeout: this.timeoutMs,
          headers: options.headers || {},
          ...options,
        });
        return response.data;
      } catch (error) {
        lastError = error;
        const status = error.response?.status;

        if (status === 403 || status === 401) {
          this.log.error(`Auth/forbidden error (${status}) on ${url} — not retrying`);
          throw error;
        }

        if (status === 404) {
          this.log.warn(`404 Not Found: ${url}`);
          return null;
        }

        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
          this.log.warn(`Attempt ${attempt}/${this.maxRetries} failed for ${url}: ${error.message}. Retrying in ${delay}ms`);
          await this._sleep(delay);
        }
      }
    }
    this.log.error(`All ${this.maxRetries} attempts failed for ${url}: ${lastError.message}`);
    throw lastError;
  }

  /**
   * Create a normalized item object.
   *
   * Accepts BOTH `title`/`description` AND `raw_title`/`raw_description` as input.
   * The 5 v2 collectors (Reddit, ArXiv, HuggingFace, AILabBlogs, Replicate,
   * GitHubTrending) use the shorter `title` / `description`. Without aliasing,
   * every item from those scrapers landed in the queue with empty raw_title and
   * was rejected by the classifier — which is why all 5 had 0 tools in the live DB.
   */
  createItem(fields) {
    const title = fields.raw_title || fields.title || '';
    const description = fields.raw_description || fields.description || '';
    return {
      raw_title: String(title).substring(0, 1000),
      raw_description: String(description).substring(0, 5000),
      url: fields.url || '',
      source: fields.source || this.name,
      source_url: fields.source_url || '',
      upvotes: fields.upvotes || 0,
      comments: fields.comments || 0,
      author: fields.author || '',
      homepage: fields.homepage || '',
      language: fields.language || '',
      topics: fields.topics || [],
      published_at: fields.published_at || new Date().toISOString(),
    };
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { BaseCollector };
