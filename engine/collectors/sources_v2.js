/**
 * EverythinInAI Discovery Engine — Collectors v2
 *
 * Adds 6 new source families to dramatically expand AI-ecosystem coverage:
 *   1. RedditCollector       — r/MachineLearning, r/singularity, r/LocalLLaMA, r/OpenAI, r/StableDiffusion
 *   2. ArxivCollector        — cs.AI, cs.CL, cs.LG (last 24h)
 *   3. HuggingFaceCollector  — trending Models + Spaces APIs
 *   4. AILabBlogsCollector   — OpenAI, Anthropic, Google Research, DeepMind RSS
 *   5. ProductHuntCollector  — official RSS for AI category
 *   6. GitHubTrendingCollector — daily trending repos (catches non-AI-tagged repos)
 *
 * All collectors extend BaseCollector and emit normalized items via createItem().
 * The state machine + classifier handle the rest.
 */

const { BaseCollector } = require('./base');
const { XMLParser } = require('fast-xml-parser');
const { createLogger } = require('../utils/logger');

// ─── 1. REDDIT ──────────────────────────────────────────────────────────────
class RedditCollector extends BaseCollector {
  constructor() {
    super('reddit');
    this.subreddits = [
      'MachineLearning',
      'singularity',
      'LocalLLaMA',
      'OpenAI',
      'StableDiffusion',
      'LangChain',
    ];
  }

  // Get a Reddit OAuth token. Cached for 1 hour.
  // Requires REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET in env. If absent, returns null
  // and we fall back to public www.reddit.com (which now 403s from server IPs but
  // works from residential IPs).
  async _getRedditToken() {
    if (this._tokenCache && this._tokenCache.expires > Date.now()) return this._tokenCache.token;
    const clientId = process.env.REDDIT_CLIENT_ID;
    const clientSecret = process.env.REDDIT_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    try {
      const axios = require('axios');
      const res = await axios.post(
        'https://www.reddit.com/api/v1/access_token',
        'grant_type=client_credentials',
        {
          auth: { username: clientId, password: clientSecret },
          headers: {
            'User-Agent': 'EverythinInAI/1.0 (by u/everythininai_bot)',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 10000,
        },
      );
      const token = res.data?.access_token;
      if (!token) return null;
      this._tokenCache = { token, expires: Date.now() + 55 * 60_000 };  // refresh after 55min
      this.log.info('Acquired Reddit OAuth token');
      return token;
    } catch (err) {
      this.log.warn(`Reddit OAuth failed: ${err.message}; falling back to public endpoint`);
      return null;
    }
  }

  async collect(sinceTimestamp /* unused — reddit gives last 25 by default */) {
    const items = [];
    const token = await this._getRedditToken();
    const baseHost = token ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
    for (const sub of this.subreddits) {
      try {
        const url = `${baseHost}/r/${sub}/hot.json?limit=50`;
        const headers = {
          'User-Agent': 'EverythinInAI/1.0 (by u/everythininai_bot)',
          'Accept': 'application/json,text/html,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const data = await this.fetchWithRetry(url, { headers });
        const posts = data?.data?.children || [];
        let added = 0;
        for (const p of posts) {
          const post = p.data;
          if (!post || post.stickied || post.over_18) continue;
          // Skip pure self-text posts that don't link out (low signal)
          if (post.is_self && !post.selftext_html) continue;
          const targetUrl = post.url_overridden_by_dest || post.url || `https://reddit.com${post.permalink}`;
          items.push(this.createItem({
            title: post.title,
            description: (post.selftext || '').substring(0, 500),
            url: targetUrl,
            source: `reddit:${sub}`,
            source_url: `https://reddit.com${post.permalink}`,
            upvotes: post.ups || 0,
            comments: post.num_comments || 0,
            author: post.author || '',
            published_at: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
          }));
          added++;
        }
        this.log.info(`  r/${sub}: ${added} posts`);
        await this._sleep(800);  // be polite to reddit
      } catch (err) {
        this.log.error(`  r/${sub} FAILED: ${err.message}`);
      }
    }
    this.log.info(`Total Reddit items: ${items.length}`);
    return items;
  }
}

// ─── 2. ARXIV ────────────────────────────────────────────────────────────────
class ArxivCollector extends BaseCollector {
  constructor() {
    super('arxiv');
    this.categories = ['cs.AI', 'cs.CL', 'cs.LG'];
    this.parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    // ArXiv API is slow, especially for cs.AI. Default 15s timeout caused that
    // category to consistently fail. Bump to 30s.
    this.timeoutMs = 30000;
  }

    async collect(sinceTimestamp) {
    const items = [];
    // Use the proper arXiv /api/query endpoint which actually returns results.
    // RSS endpoints are unreliable; this returns Atom-formatted results.
    for (const cat of this.categories) {
      try {
        const url = `https://export.arxiv.org/api/query?search_query=cat:${cat}&start=0&max_results=50&sortBy=submittedDate&sortOrder=descending`;
        const xmlText = await this.fetchWithRetry(url, { responseType: 'text' });
        const parsed = this.parser.parse(typeof xmlText === 'string' ? xmlText : '');
        const entries = parsed?.feed?.entry || [];
        const list = Array.isArray(entries) ? entries : [entries].filter(Boolean);
        let added = 0;
        let skippedNonTool = 0;
        for (const entry of list) {
          if (!entry?.title || !entry?.id) continue;
          const link = String(entry.id || '').replace('http://', 'https://');
          const summary = this._stripHtml(entry.summary || '').substring(0, 500);
          const titleStr = String(entry.title).replace(/\s+/g, ' ').trim();
          // Quality gate: only keep papers that mention code/tool/release/repo
          // This filters out pure-theory papers that won't be usable as "tools"
          const hasCodeSignal = /github\.com|huggingface\.co|code|implementation|release|open[- ]source|\btool\b|\bframework\b|\blibrary\b|\bsdk\b/i.test(titleStr + ' ' + summary);
          if (!hasCodeSignal) { skippedNonTool++; continue; }
          const authorList = Array.isArray(entry.author) ? entry.author : [entry.author].filter(Boolean);
          const authorName = authorList[0]?.name || '';
          const pubStr = entry.published || entry.updated;
          const pubMs = pubStr ? Date.parse(pubStr) : Date.now();
          items.push(this.createItem({
            title: titleStr,
            description: summary,
            url: link,
            source: `arxiv:${cat}`,
            source_url: link,
            upvotes: 0,
            author: authorName,
            published_at: new Date(pubMs).toISOString(),
          }));
          added++;
        }
        this.log.info(`  ${cat}: ${added} papers (skipped ${skippedNonTool} non-tool theoretical)`);
        await this._sleep(800);
      } catch (err) {
        this.log.error(`  arxiv ${cat} FAILED: ${err.message}`);
      }
    }
    this.log.info(`Total arXiv items: ${items.length}`);
    return items;
  }

  _stripHtml(s) {
    return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

// ─── 3. HUGGING FACE ────────────────────────────────────────────────────────
class HuggingFaceCollector extends BaseCollector {
  constructor() {
    super('huggingface');
  }

  async collect() {
    const items = [];

    // Trending models
    try {
      const models = await this.fetchWithRetry(
        // HF deprecated 'trending'; using 'likes' descending gives the same effective top set.
        'https://huggingface.co/api/models?sort=likes&direction=-1&limit=50',
      );
      let added = 0;
      for (const m of models || []) {
        if (!m?.id) continue;
        const tags = Array.isArray(m.tags) ? m.tags.slice(0, 10) : [];
        items.push(this.createItem({
          title: m.id,
          description: `Trending HF model. Tags: ${tags.join(', ')}. ${m.downloads || 0} downloads.`,
          url: `https://huggingface.co/${m.id}`,
          source: 'huggingface:models',
          source_url: `https://huggingface.co/${m.id}`,
          upvotes: m.likes || 0,
          author: m.id.split('/')[0] || '',
          published_at: m.lastModified || m.createdAt || null,
        }));
        added++;
      }
      this.log.info(`  HF Models: ${added}`);
    } catch (err) {
      this.log.error(`  HF Models FAILED: ${err.message}`);
    }

    // Trending Spaces
    try {
      const spaces = await this.fetchWithRetry(
        // HF deprecated 'trending' for spaces too; switch to 'likes' descending.
        'https://huggingface.co/api/spaces?sort=likes&direction=-1&limit=50',
      );
      let added = 0;
      for (const s of spaces || []) {
        if (!s?.id) continue;
        items.push(this.createItem({
          title: s.id,
          description: `Trending HF Space (interactive AI demo). ${s.likes || 0} likes.`,
          url: `https://huggingface.co/spaces/${s.id}`,
          source: 'huggingface:spaces',
          source_url: `https://huggingface.co/spaces/${s.id}`,
          upvotes: s.likes || 0,
          author: s.id.split('/')[0] || '',
          published_at: s.lastModified || s.createdAt || null,
        }));
        added++;
      }
      this.log.info(`  HF Spaces: ${added}`);
    } catch (err) {
      this.log.error(`  HF Spaces FAILED: ${err.message}`);
    }

    this.log.info(`Total HuggingFace items: ${items.length}`);
    return items;
  }
}

// ─── 4. OFFICIAL AI LAB BLOGS ───────────────────────────────────────────────
class AILabBlogsCollector extends BaseCollector {
  constructor() {
    super('ai_lab_blogs');
    // Curated AI lab blog feeds. Most labs killed their public RSS in 2025.
    // We keep only verified-working direct RSS endpoints.
    // Anthropic/Meta/Mistral RSS are dead industry-wide; we accept the reduced
    // coverage rather than depend on flaky RSSHub public instances.
    // Verified-working RSS feeds (curl + XML parser confirmed they have items).
    // The Batch (deeplearning.ai) and Rachel Woods AI exchange returned 404 — dropped.
    // TLDR AI returns near-empty XML — dropped.
    this.feeds = [
      { name: 'OpenAI',            url: 'https://openai.com/blog/rss.xml' },
      { name: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml' },
      { name: 'BAIR Berkeley AI',  url: 'https://bair.berkeley.edu/blog/feed.xml' },
      { name: 'Import AI',         url: 'https://importai.substack.com/feed' },
    ];
    // AI labs publish 1-2 posts per WEEK, not multiple per hour like Reddit/HN.
    // The incremental cron's 6h sinceTimestamp filter killed every item. Use a
    // 14-day window for these feeds regardless of what the orchestrator passes.
    this.minLookbackDays = 14;
    this.parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  }

  async collect(sinceTimestamp) {
    const items = [];
    // Honour caller's window OR our minLookbackDays floor, whichever is wider.
    const callerSinceMs = (sinceTimestamp || 0) * 1000;
    const floorSinceMs = Date.now() - (this.minLookbackDays * 86_400_000);
    const sinceMs = callerSinceMs > 0 ? Math.min(callerSinceMs, floorSinceMs) : floorSinceMs;
    for (const feed of this.feeds) {
      try {
        const xmlText = await this.fetchWithRetry(feed.url, { responseType: 'text' });
        const parsed = this.parser.parse(typeof xmlText === 'string' ? xmlText : '');

        // Try RSS 2.0 first, then Atom
        let entries = parsed?.rss?.channel?.item || parsed?.feed?.entry || [];
        entries = Array.isArray(entries) ? entries : [entries].filter(Boolean);

        let added = 0;
        for (const e of entries) {
          if (!e) continue;
          const title = e.title?.['#text'] || e.title || '';
          const link = e.link?.['@_href'] || e.link || e.guid?.['#text'] || e.guid || '';
          const date = e.pubDate || e.published || e.updated;
          const pubMs = date ? Date.parse(date) : Date.now();
          if (sinceMs && pubMs < sinceMs) continue;
          if (!title || !link) continue;

          items.push(this.createItem({
            title: String(title).trim(),
            description: this._stripHtml(e.description || e.summary?.['#text'] || e.summary || '').substring(0, 500),
            url: typeof link === 'string' ? link : link['@_href'] || '',
            source: `lab_blog:${feed.name.toLowerCase().replace(/\s+/g, '_')}`,
            source_url: typeof link === 'string' ? link : link['@_href'] || '',
            upvotes: 0,
            author: e['dc:creator'] || e.author?.name || feed.name,
            published_at: new Date(pubMs).toISOString(),
          }));
          added++;
        }
        this.log.info(`  ${feed.name}: ${added}`);
        await this._sleep(300);
      } catch (err) {
        this.log.error(`  ${feed.name} FAILED: ${err.message}`);
      }
    }
    this.log.info(`Total AI Lab Blogs items: ${items.length}`);
    return items;
  }

  _stripHtml(s) {
    return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

// ─── 5. PRODUCT HUNT (replaces dead RSS feed in original) ────────────────────
class ProductHuntCollector extends BaseCollector {
  // NOTE: ProductHunt killed all public RSS feeds in 2025. Their GraphQL API
  // requires auth tokens. Rather than maintain a broken collector, we keep
  // the class name (so registry doesn't break) but route it to the
  // Replicate Explore API instead, which returns 50 trending public AI models
  // per call and is a much higher-quality signal than PH ever was.
  constructor() {
    super('replicate_explore');
  }
  async collect() {
    const items = [];
    try {
      // Replicate's public models endpoint. Requires REPLICATE_API_TOKEN from .env.
      const token = process.env.REPLICATE_API_TOKEN || '';
      if (!token) {
        this.log.warn('REPLICATE_API_TOKEN not set; skipping Replicate Explore');
        return [];
      }
      const data = await this.fetchWithRetry(
        'https://api.replicate.com/v1/models',
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'EverythinInAI/1.0',
            'Accept': 'application/json',
          },
        },
      );
      const models = data?.results || [];
      let added = 0;
      for (const m of models) {
        if (!m?.url) continue;
        const fullName = `${m.owner}/${m.name}`;
        items.push(this.createItem({
          title: fullName,
          description: (m.description || `${m.cover_image_url ? 'Visual AI model. ' : ''}Run count: ${m.run_count || 0}.`).substring(0, 500),
          url: m.url,
          source: 'replicate',
          source_url: m.url,
          upvotes: m.run_count || 0,
          author: m.owner,
          homepage: m.github_url || m.paper_url || '',
          published_at: m.created_at || new Date().toISOString(),
        }));
        added++;
      }
      this.log.info(`  Replicate: ${added} models`);
    } catch (err) {
      this.log.error(`  Replicate FAILED: ${err.message}`);
    }
    this.log.info(`Total ProductHunt/Replicate items: ${items.length}`);
    return items;
  }
}

// ─── 6. GITHUB TRENDING (catches repos that aren't AI-tagged but are trending) ──
class GitHubTrendingCollector extends BaseCollector {
  constructor() {
    super('github_trending');
  }

  async collect() {
    const items = [];
    try {
      const html = await this.fetchWithRetry(
        'https://github.com/trending?since=daily&spoken_language_code=en',
        { responseType: 'text' },
      );

      // Lightweight HTML parse — extract repo links + stars without bringing in cheerio
      const repoRegex = /<h2 class="h3 lh-condensed">[\s\S]*?<a href="\/([^"]+)"/g;
      const seen = new Set();
      let match;
      let added = 0;
      while ((match = repoRegex.exec(html)) !== null && added < 30) {
        // Strip trailing /stargazers, /issues, /pulls etc. so we get the canonical repo URL
        const fullName = match[1].replace(/\/(stargazers|issues|pulls|forks|wiki)$/, '');
        if (seen.has(fullName)) continue;
        seen.add(fullName);
        const repoUrl = `https://github.com/${fullName}`;
        items.push(this.createItem({
          title: fullName,
          description: `Trending GitHub repo (today). The classifier will determine if this is AI-related.`,
          url: repoUrl,
          source: 'github_trending',
          source_url: repoUrl,
          upvotes: 0,
          author: fullName.split('/')[0],
          published_at: new Date().toISOString(),
        }));
        added++;
      }
      this.log.info(`Total GitHub Trending items: ${added}`);
    } catch (err) {
      this.log.error(`GitHub Trending FAILED: ${err.message}`);
    }
    return items;
  }
}

module.exports = {
  RedditCollector,
  ArxivCollector,
  HuggingFaceCollector,
  AILabBlogsCollector,
  ProductHuntCollector,
  GitHubTrendingCollector,
};
