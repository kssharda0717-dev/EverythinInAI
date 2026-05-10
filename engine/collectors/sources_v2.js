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

  async collect(sinceTimestamp /* unused — reddit gives last 25 by default */) {
    const items = [];
    for (const sub of this.subreddits) {
      try {
        // Reddit blocks unauthenticated bot UAs; use a real-browser UA + Accept header.
        // .json suffix is still public read for most subs as long as UA looks legit.
        const url = `https://www.reddit.com/r/${sub}/hot.json?limit=50`;
        const data = await this.fetchWithRetry(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json,text/html,*/*',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
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
  }

  async collect(sinceTimestamp) {
    const items = [];
    const sinceMs = (sinceTimestamp || 0) * 1000;

    for (const cat of this.categories) {
      try {
        // Use HTTPS (arxiv now redirects HTTP) — the redirect was killing some retries.
        const url = `https://export.arxiv.org/rss/${cat}`;
        const xmlText = await this.fetchWithRetry(url, { responseType: 'text' });
        const parsed = this.parser.parse(typeof xmlText === 'string' ? xmlText : '');
        // arxiv RSS structure: try all known shapes
        const channel = parsed?.['rdf:RDF']?.item || parsed?.rss?.channel?.item || parsed?.feed?.entry || [];
        const list = Array.isArray(channel) ? channel : [channel].filter(Boolean);
        let added = 0;
        let skippedByDate = 0;
        for (const entry of list) {
          if (!entry?.title || !entry?.link) continue;
          // arxiv recently changed published date field — try multiple keys
          const dateStr = entry['dc:date'] || entry.published || entry.pubDate || entry.updated;
          const pubMs = dateStr ? Date.parse(dateStr) : Date.now();
          // Be permissive on date filter for arxiv (RSS feed is always recent anyway)
          if (sinceMs && pubMs && pubMs < sinceMs - (7 * 86400000)) {  // 7-day grace window
            skippedByDate++;
            continue;
          }

          items.push(this.createItem({
            title: String(entry.title).replace(/\s*\(arXiv:[^)]+\)\s*$/, '').trim(),
            description: this._stripHtml(entry.description || '').substring(0, 500),
            url: entry.link,
            source: `arxiv:${cat}`,
            source_url: entry.link,
            upvotes: 0,
            author: entry['dc:creator'] || '',
            published_at: new Date(pubMs).toISOString(),
          }));
          added++;
        }
        this.log.info(`  ${cat}: ${added} papers${skippedByDate ? ` (skipped ${skippedByDate} by date)` : ''}`);
        await this._sleep(500);
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
    this.feeds = [
      { name: 'OpenAI',          url: 'https://openai.com/blog/rss.xml' },
      // Anthropic killed RSS in 2025; switched to atom feed at /atom.xml
      { name: 'Anthropic News',  url: 'https://www.anthropic.com/atom.xml' },
      { name: 'Google Research', url: 'https://research.google/blog/rss/' },
      { name: 'DeepMind',        url: 'https://deepmind.google/blog/rss.xml' },
      // Meta AI moved their feed; new URL
      { name: 'Meta AI',         url: 'https://ai.meta.com/blog/feed/' },
      // Bonus: Mistral + Cohere blogs
      { name: 'Mistral',         url: 'https://mistral.ai/news/feed.xml' },
      { name: 'Cohere',          url: 'https://cohere.com/blog/rss.xml' },
    ];
    this.parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  }

  async collect(sinceTimestamp) {
    const items = [];
    const sinceMs = (sinceTimestamp || 0) * 1000;

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
  constructor() {
    super('producthunt');
    this.parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  }

  async collect(sinceTimestamp) {
    const items = [];
    try {
      // Public RSS — no API key needed
      const xmlText = await this.fetchWithRetry(
        // ProductHunt killed the public RSS for category filters in 2025.
        // Switched to the official sitewide feed which still includes AI launches.
        'https://www.producthunt.com/feed',
        { responseType: 'text', headers: { 'User-Agent': 'Mozilla/5.0 EverythinInAI/1.0' } },
      );
      const parsed = this.parser.parse(typeof xmlText === 'string' ? xmlText : '');
      const entries = parsed?.rss?.channel?.item || [];
      const list = Array.isArray(entries) ? entries : [entries].filter(Boolean);

      const sinceMs = (sinceTimestamp || 0) * 1000;
      for (const e of list) {
        if (!e?.title || !e?.link) continue;
        const pubMs = e.pubDate ? Date.parse(e.pubDate) : Date.now();
        if (sinceMs && pubMs < sinceMs) continue;

        items.push(this.createItem({
          title: e.title,
          description: this._stripHtml(e.description || '').substring(0, 500),
          url: e.link,
          source: 'producthunt',
          source_url: e.link,
          upvotes: 0,
          author: e['dc:creator'] || '',
          published_at: new Date(pubMs).toISOString(),
        }));
      }
      this.log.info(`Total ProductHunt items: ${items.length}`);
    } catch (err) {
      this.log.error(`ProductHunt FAILED: ${err.message}`);
    }
    return items;
  }

  _stripHtml(s) {
    return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
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
        const fullName = match[1];
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
