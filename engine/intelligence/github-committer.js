/**
 * EverythinInAI Discovery Engine — GitHub Committer
 *
 * Syncs the Supabase tools table back to data.json in the GitHub repo.
 * This is for backwards compatibility and provides a public API endpoint
 * via GitHub's raw content URL.
 *
 * Handles the SHA race condition by reading the current SHA immediately
 * before writing, with retry logic for 409 Conflict errors.
 */

const axios = require('axios');
const { config } = require('../core/config');
const { createLogger } = require('../utils/logger');

const log = createLogger('github-committer');

class GitHubCommitter {
  constructor() {
    this.token = config.github.token;
    this.repo = config.github.repo;
    this.branch = config.github.branch;
    this.apiBase = `https://api.github.com/repos/${this.repo}/contents/data.json`;
    this.headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  /**
   * Commit the exported tools data to GitHub.
   * Retries on 409 Conflict (SHA mismatch).
   */
  async commit(exportData, runId) {
    if (!this.token) {
      log.warn('No GitHub token configured, skipping commit');
      return;
    }

    const jsonString = JSON.stringify(exportData, null, 2);

    // Validate JSON integrity before committing
    try {
      JSON.parse(jsonString);
    } catch (e) {
      throw new Error(`JSON validation failed before commit: ${e.message}`);
    }

    const base64Content = Buffer.from(jsonString).toString('base64');
    const commitMessage = `chore(data): update AI tools directory (${exportData.metadata.totalTools} tools) [run: ${runId}]`;

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts++;

      try {
        // Get current SHA (must be done immediately before PUT)
        const currentSha = await this._getCurrentSha();

        const body = {
          message: commitMessage,
          content: base64Content,
          branch: this.branch,
        };
        if (currentSha) body.sha = currentSha;

        await axios.put(this.apiBase, body, {
          headers: this.headers,
          timeout: 30000,
        });

        log.info(`Committed data.json (${exportData.metadata.totalTools} tools, ${Math.round(jsonString.length / 1024)}KB)`);
        return;

      } catch (error) {
        if (error.response?.status === 409 && attempts < maxAttempts) {
          log.warn(`SHA conflict on attempt ${attempts}, retrying...`);
          await this._sleep(1000 * attempts);
          continue;
        }
        throw new Error(`GitHub commit failed: ${error.response?.data?.message || error.message}`);
      }
    }
  }

  async _getCurrentSha() {
    try {
      const response = await axios.get(this.apiBase, {
        headers: this.headers,
        timeout: 10000,
      });
      return response.data?.sha || null;
    } catch (error) {
      if (error.response?.status === 404) {
        log.info('data.json does not exist yet, will create');
        return null;
      }
      throw error;
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { GitHubCommitter };
