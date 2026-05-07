/**
 * EverythinInAI Discovery Engine — Hacker News Collector
 *
 * Uses the HN Algolia API with FULL PAGINATION.
 * The old workflow capped at 100 results per query. This fetches ALL pages.
 *
 * Search strategy:
 *   - Multiple query variants to maximize coverage
 *   - Deduplicates by HN objectID across queries
 *   - Respects Algolia's rate limits (no auth required, generous limits)
 */
const { BaseCollector } = require('./base');

const QUERIES = [
  // Direct tool launches
  { query: 'AI tool', tags: 'show_hn' },
  { query: '"built with AI" OR "AI-powered"', tags: 'show_hn' },
  { query: 'LLM OR GPT OR "AI assistant" OR "AI agent"', tags: 'show_hn' },
  { query: '"generative AI" OR diffusion OR "text to"', tags: 'show_hn' },
  // Broader: any Show HN with AI-related terms
  { query: 'machine learning tool OR ML tool', tags: 'show_hn' },
  { query: 'chatbot OR copilot OR "AI API"', tags: 'show_hn' },
  // Launch HN (non-Show HN but still tool announcements)
  { query: '"Show HN" AI', tags: 'story' },
];

const HITS_PER_PAGE = 100; // Algolia max
const MAX_PAGES_PER_QUERY = 10; // Safety cap: 1000 items per query

class HackerNewsCollector extends BaseCollector {
  constructor() {
    super('hacker_news');
  }

  async collect(sinceTimestamp, untilTimestamp) {
    const allItems = [];
    const seenObjectIds = new Set();

    for (const queryDef of QUERIES) {
      try {
        const items = await this._fetchQuery(queryDef, sinceTimestamp, untilTimestamp, seenObjectIds);
        allItems.push(...items);
        this.log.info(`  Query "${queryDef.query}": ${items.length} new items`);
      } catch (error) {
        this.log.error(`  Query "${queryDef.query}" failed: ${error.message}`);
        // Continue with other queries
      }

      // Small delay between queries to be respectful
      await this._sleep(500);
    }

    this.log.info(`Total HN items: ${allItems.length} (deduplicated across ${QUERIES.length} queries)`);
    return allItems;
  }

  async _fetchQuery(queryDef, sinceTs, untilTs, seenObjectIds) {
    const items = [];
    let page = 0;

    while (page < MAX_PAGES_PER_QUERY) {
      const url = this._buildUrl(queryDef, sinceTs, untilTs, page);
      const data = await this.fetchWithRetry(url);

      if (!data || !data.hits || data.hits.length === 0) break;

      for (const hit of data.hits) {
        if (seenObjectIds.has(hit.objectID)) continue;
        seenObjectIds.add(hit.objectID);

        const url = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`;
        if (!url) continue;

        items.push(this.createItem({
          raw_title: hit.title || hit.story_title || '',
          raw_description: hit.story_text || '',
          url: url,
          source: 'hacker_news',
          source_url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          upvotes: hit.points || 0,
          comments: hit.num_comments || 0,
          author: hit.author || '',
          published_at: hit.created_at || new Date().toISOString(),
        }));
      }

      // Check if there are more pages
      const totalPages = Math.ceil((data.nbHits || 0) / HITS_PER_PAGE);
      page++;
      if (page >= totalPages) break;

      // Rate limit: small delay between pages
      await this._sleep(200);
    }

    return items;
  }

  _buildUrl(queryDef, sinceTs, untilTs, page) {
    const params = new URLSearchParams({
      query: queryDef.query,
      tags: queryDef.tags,
      numericFilters: `created_at_i>${sinceTs},created_at_i<${untilTs}`,
      hitsPerPage: String(HITS_PER_PAGE),
      page: String(page),
    });
    return `https://hn.algolia.com/api/v1/search?${params.toString()}`;
  }
}

module.exports = { HackerNewsCollector };
