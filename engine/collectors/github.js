/**
 * EverythinInAI Discovery Engine — GitHub Collector
 *
 * Fixes the critical 1,000-result limit of GitHub Search API.
 * Strategy: Split the time range into smaller windows so each window
 * returns fewer than 1,000 results. Uses binary splitting if a window
 * hits the limit.
 *
 * Also uses multiple topic queries to maximize coverage:
 *   - topic:ai-tools
 *   - topic:artificial-intelligence + stars:>20
 *   - topic:llm + topic:tool
 *   - topic:machine-learning + topic:tool
 */
const { BaseCollector } = require('./base');
const { config } = require('../core/config');

const SEARCH_QUERIES = [
  'topic:ai-tools stars:>10',
  'topic:artificial-intelligence stars:>20',
  'topic:llm stars:>15',
  'topic:machine-learning topic:tool stars:>15',
  'topic:generative-ai stars:>10',
  '"ai tool" in:description stars:>20',
  '"ai-powered" in:description stars:>30',
];

const PER_PAGE = 100;
const MAX_RESULTS_PER_QUERY = 1000; // GitHub hard limit

class GitHubCollector extends BaseCollector {
  constructor() {
    super('github');
    this.headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (config.github.token) {
      this.headers.Authorization = `Bearer ${config.github.token}`;
    }
  }

  async collect(sinceTimestamp, untilTimestamp) {
    const sinceDate = new Date(sinceTimestamp * 1000).toISOString().substring(0, 10);
    const untilDate = new Date(untilTimestamp * 1000).toISOString().substring(0, 10);

    const allItems = [];
    const seenRepoIds = new Set();

    for (const baseQuery of SEARCH_QUERIES) {
      try {
        const items = await this._fetchQueryWithSplitting(
          baseQuery, sinceDate, untilDate, seenRepoIds
        );
        allItems.push(...items);
        this.log.info(`  Query "${baseQuery}": ${items.length} new repos`);
      } catch (error) {
        this.log.error(`  Query "${baseQuery}" failed: ${error.message}`);
      }

      // GitHub API rate limit: 10 requests/minute for unauthenticated, 30 for authenticated
      await this._sleep(config.github.token ? 2000 : 6000);
    }

    this.log.info(`Total GitHub repos: ${allItems.length}`);
    return allItems;
  }

  /**
   * Fetch a query, splitting the date range if results hit the 1000 limit.
   */
  async _fetchQueryWithSplitting(baseQuery, sinceDate, untilDate, seenRepoIds) {
    const items = [];
    const dateRanges = [{ since: sinceDate, until: untilDate }];

    while (dateRanges.length > 0) {
      const range = dateRanges.shift();
      const { repos, totalCount } = await this._fetchDateRange(baseQuery, range.since, range.until);

      if (totalCount >= MAX_RESULTS_PER_QUERY && range.since !== range.until) {
        // Split the range in half and re-queue
        const midDate = this._midDate(range.since, range.until);
        if (midDate && midDate !== range.since && midDate !== range.until) {
          this.log.debug(`Splitting range ${range.since}..${range.until} at ${midDate} (${totalCount} results)`);
          dateRanges.push({ since: range.since, until: midDate });
          dateRanges.push({ since: midDate, until: range.until });
          continue;
        }
      }

      // Process repos
      for (const repo of repos) {
        if (seenRepoIds.has(repo.id)) continue;
        seenRepoIds.add(repo.id);

        items.push(this.createItem({
          raw_title: repo.name || '',
          raw_description: repo.description || '',
          url: repo.html_url,
          homepage: repo.homepage || '',
          source: 'github',
          source_url: repo.html_url,
          upvotes: repo.stargazers_count || 0,
          author: repo.owner?.login || '',
          language: repo.language || '',
          topics: repo.topics || [],
          published_at: repo.pushed_at || repo.updated_at || new Date().toISOString(),
        }));
      }
    }

    return items;
  }

  async _fetchDateRange(baseQuery, sinceDate, untilDate) {
    const allRepos = [];
    let page = 1;
    let totalCount = 0;

    while (page <= 10) { // Max 10 pages = 1000 results
      const query = `${baseQuery} pushed:${sinceDate}..${untilDate}`;
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${PER_PAGE}&page=${page}`;

      try {
        const data = await this.fetchWithRetry(url, { headers: this.headers });
        if (!data || !data.items) break;

        totalCount = data.total_count || 0;
        allRepos.push(...data.items);

        if (data.items.length < PER_PAGE) break; // Last page
        page++;

        // Rate limit delay
        await this._sleep(config.github.token ? 1000 : 6000);
      } catch (error) {
        if (error.response?.status === 422) {
          // GitHub returns 422 for too-complex queries
          this.log.warn(`Query too complex, skipping: ${query}`);
          break;
        }
        throw error;
      }
    }

    return { repos: allRepos, totalCount };
  }

  _midDate(sinceDate, untilDate) {
    const sinceMs = new Date(sinceDate).getTime();
    const untilMs = new Date(untilDate).getTime();
    const midMs = sinceMs + Math.floor((untilMs - sinceMs) / 2);
    const mid = new Date(midMs).toISOString().substring(0, 10);
    return mid;
  }
}

module.exports = { GitHubCollector };
