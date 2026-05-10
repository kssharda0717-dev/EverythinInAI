/**
 * EverythinInAI Discovery Engine — Heuristic Pre-Filter v4.0
 *
 * WHAT CHANGED FROM v3.0:
 *
 * 1. FLUID SCORING: Instead of rigid keyword lists, v4 uses weighted signal
 *    categories that combine additively. An item can score high even if it
 *    doesn't match any predefined keyword — as long as it has enough positive
 *    signals from other dimensions (source, engagement, domain, structure).
 *
 * 2. ANTI-PATTERNS: Explicit detection of listicles, comparison articles,
 *    news roundups, and "best X tools" posts that v3 let through.
 *
 * 3. NOVELTY BONUS: Items from the last 48 hours get a freshness boost.
 *    This ensures we capture tools that are too new to have standard patterns.
 *
 * 4. URL STRUCTURE ANALYSIS: Product URLs (short paths, custom domains)
 *    score higher than article URLs (long paths with dates/slugs).
 *
 * 5. NO HARD DROPS: v4 never drops an item entirely. Everything gets a score.
 *    The state machine decides the cutoff based on available Gemini budget.
 *    Items below the cutoff are saved in the queue as "low_priority" for
 *    future processing when budget allows.
 */

const { createLogger } = require('../utils/logger');

const log = createLogger('pre-filter');

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL DICTIONARIES
// ═══════════════════════════════════════════════════════════════════════════════

// Title signals: phrases that strongly indicate a tool launch
const LAUNCH_SIGNALS = [
  'show hn', 'launch', 'launching', 'introducing', 'we built', 'i built',
  'just launched', 'just shipped', 'new tool', 'open source release',
  'we made', 'i made', 'presenting', 'announcing', 'check out',
  'try out', 'built this', 'side project', 'weekend project',
  'beta launch', 'public beta', 'v1', 'v2', '1.0', '2.0',
];

// Title signals: AI/ML technology terms
const TECH_SIGNALS = [
  'ai', 'llm', 'gpt', 'claude', 'gemini', 'chatbot', 'copilot',
  'assistant', 'agent', 'automate', 'automation', 'api', 'model', 'sdk',
  'plugin', 'extension', 'platform', 'bot', 'workflow', 'pipeline',
  'diffusion', 'generative', 'neural', 'transformer', 'rag', 'vector',
  'embedding', 'fine-tune', 'finetune', 'prompt', 'inference',
  'text-to', 'speech-to', 'image-to', 'voice', 'tts', 'stt',
  'openai', 'anthropic', 'hugging face', 'huggingface', 'langchain',
  'llamaindex', 'ollama', 'mistral', 'llama', 'stable diffusion',
  'midjourney', 'dall-e', 'whisper', 'sam', 'yolo',
];

// Anti-patterns: titles that indicate news/listicles, NOT tools
const ANTI_PATTERNS = [
  'best ai tools', 'top ai tools', 'ai tools for', 'tools you need',
  'tools to try', 'tools in 202', 'comparison', 'vs ', ' vs.',
  'review of', 'roundup', 'weekly', 'daily', 'newsletter',
  'what is', 'how to use', 'guide to', 'tutorial', 'explained',
  'the future of', 'state of ai', 'ai trends', 'ai news',
  'raises $', 'funding', 'acquired', 'acquisition', 'ipo',
  'layoff', 'hiring', 'job', 'career', 'salary',
  'regulation', 'policy', 'lawsuit', 'sued', 'ban',
  'opinion:', 'editorial', 'analysis:', 'deep dive',
];

// Domains where tools are typically hosted
const TOOL_HOSTING_DOMAINS = [
  'github.com', 'huggingface.co', 'replicate.com', 'vercel.app',
  'netlify.app', 'streamlit.app', 'gradio.app', 'replit.com',
  'railway.app', 'render.com', 'fly.dev', 'modal.com',
  'spaces.huggingface.co', 'colab.research.google.com',
  'supabase.co', 'firebase.google.com', 'herokuapp.com',
];

// Domains that are almost always news/content, not tools
const NEWS_DOMAINS = [
  'techcrunch.com', 'venturebeat.com', 'wired.com', 'theverge.com',
  'thenextweb.com', 'zdnet.com', 'businessinsider.com', 'forbes.com',
  'towardsdatascience.com', 'analyticsvidhya.com', 'medium.com',
  'substack.com', 'nytimes.com', 'washingtonpost.com', 'bbc.com',
  'reuters.com', 'bloomberg.com', 'cnbc.com', 'arstechnica.com',
];

// Academic domains — very unlikely to be tools
const ACADEMIC_DOMAINS = [
  'arxiv.org', 'paperswithcode.com', 'semanticscholar.org',
  'scholar.google.com', 'dl.acm.org', 'ieeexplore.ieee.org',
  'researchgate.net', 'aclanthology.org', 'proceedings.mlr.press',
  'openreview.net', 'jmlr.org',
];

// HARD BLACKLIST: URL patterns that are NEVER tools (Phase 17 credibility fix)
// Anything matching these patterns is rejected before any other scoring runs.
// This stops LinkedIn profiles, Medium articles, YouTube videos, Twitter posts,
// Reddit threads, and similar from polluting the directory.
const HARD_BLACKLIST_PATTERNS = [
  // Profile pages (people, not products)
  /linkedin\.com\/(in|posts|pulse|company|jobs)\//i,
  /twitter\.com\/[^/]+\/status\//i,
  /x\.com\/[^/]+\/status\//i,
  /facebook\.com\//i,
  /instagram\.com\/(p|reel|tv)\//i,
  /threads\.net\//i,
  /tiktok\.com\/@/i,

  // Blog / article URLs
  /medium\.com\/(@|.*\/.*-)/i,           // medium.com/@user OR medium.com/pub/article-slug
  /\.medium\.com\//i,                    // sub.medium.com/...
  /substack\.com\/p\//i,                 // substack post
  /dev\.to\/[^/]+\/[^/]+/i,              // dev.to articles (long path)
  /hashnode\.com\//i,
  /hashnode\.dev\//i,
  /freecodecamp\.org\/news\//i,
  /geeksforgeeks\.org\//i,
  /towardsdatascience\.com\//i,
  /analyticsvidhya\.com\//i,
  /kdnuggets\.com\//i,
  /machinelearningmastery\.com\//i,

  // Reddit / HN / discussion threads (not products)
  /reddit\.com\/r\/[^/]+\/comments\//i,
  /news\.ycombinator\.com\/item/i,

  // Video / podcast (not products)
  /youtube\.com\/watch/i,
  /youtu\.be\//i,
  /vimeo\.com\/\d+/i,
  /spotify\.com\/(episode|show)\//i,

  // Q&A / forum threads
  /stackoverflow\.com\/questions\//i,
  /quora\.com\//i,

  // Newsletter archives (not signup pages — rejecting individual issues)
  /\/issues?\/\d+/i,                     // /issue/123 or /issues/123
  /\/newsletter\/[^/]+\/[^/]+/i,

  // App Store / Play Store / Chrome Web Store (treat as discovery, not tools)
  /apps\.apple\.com\//i,
  /play\.google\.com\/store\//i,
  /chrome\.google\.com\/webstore\//i,
  /chromewebstore\.google\.com\//i,

  // ── v5 ADDITIONS (May 2026 hardening, after enabling Reddit/HF/ArXiv/Replicate) ──
  // Reddit image hosts (memes / screenshots / not products)
  /i\.redd\.it\//i,
  /preview\.redd\.it\//i,
  /v\.redd\.it\//i,
  /imgur\.com\//i,
  /i\.imgur\.com\//i,
  /pbs\.twimg\.com\//i,
  /scontent[^/]*\.fbcdn\.net\//i,

  // ArXiv abstract listing pages (we want the actual paper or project page)
  /arxiv\.org\/list\//i,

  // GitHub low-signal repos (dotfiles, configs, awesome-X lists, learning notes)
  /github\.com\/[^/]+\/dotfiles?(\/|$)/i,
  /github\.com\/[^/]+\/(my-)?config(s)?(\/|$)/i,
  /github\.com\/[^/]+\/notes?(\/|$)/i,
  /github\.com\/[^/]+\/learning(\/|$)/i,
  /github\.com\/[^/]+\/playground(\/|$)/i,
  /github\.com\/[^/]+\/awesome-/i,
  /github\.com\/[^/]+\/(homework|coursework|hw|assignment|tutorial|practice)(\/|$)/i,

  // Replicate test/demo private models
  /replicate\.com\/[^/]+\/(test|demo|temp|tmp|sandbox|playground)/i,

  // Course pages, university syllabi (educational content, not tools)
  /coursera\.org\//i,
  /udemy\.com\//i,
  /edx\.org\//i,
  /udacity\.com\//i,
  /\.edu\/courses?\//i,

  // Generic Reddit subreddit landing (we want individual links, not the sub itself)
  /^https?:\/\/(www\.)?reddit\.com\/r\/[^/]+\/?$/i,

  // Direct PDF / archive downloads (we need the project landing page, not the binary)
  /\.(pdf|ps|tar\.gz|tgz|zip|rar|7z)$/i,

  // Job board posts (definitely not tools)
  /jobs\.lever\.co\//i,
  /greenhouse\.io\/[^/]+\/jobs\//i,
  /workday\.com\//i,
  /careers\.[^/]+\.[^/]+\/[^/]+\/job/i,

  // Crypto / NFT marketplaces (off-topic)
  /opensea\.io\//i,
  /etherscan\.io\//i,
  /coinbase\.com\/(price|earn)\//i,

  // E-commerce reseller pages
  /amazon\.[a-z.]+\/[^/]+\/dp\//i,
  /ebay\.com\/itm\//i,

  // Patreon / OnlyFans / Ko-fi (creator subscription pages, not products)
  /patreon\.com\/[^/]+$/i,
  /onlyfans\.com\//i,
  /ko-fi\.com\//i,
  /buymeacoffee\.com\//i,

  // Wikipedia (encyclopedia entries are not tools)
  /wikipedia\.org\/wiki\//i,

  // Reddit user profiles (definitely not tools)
  /reddit\.com\/user\//i,
  /reddit\.com\/u\//i,
];

// ═══════════════════════════════════════════════════════════════════════════════
// SCORING ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

class HeuristicPreFilter {
  constructor(options = {}) {
    this.minScore = options.minScore || 20; // Below this → low_priority
    this.maxItems = options.maxItems || 500;
  }

  /**
   * Score and filter all items.
   * Returns { passed: [...], rejected: [...] }
   * "rejected" items are those below minScore (academic papers, pure news).
   * "passed" items are sorted by score (highest first) and capped at maxItems.
   */
  filterAll(items) {
    const scored = items.map(item => {
      const result = this.scoreItem(item);
      return { ...item, heuristic_score: result.score, score_reasons: result.reasons };
    });

    // Sort by score descending
    scored.sort((a, b) => b.heuristic_score - a.heuristic_score);

    const passed = [];
    const rejected = [];

    for (const item of scored) {
      if (item.heuristic_score < 0) {
        rejected.push(item);
      } else if (item.heuristic_score < this.minScore) {
        rejected.push(item);
      } else {
        passed.push(item);
      }
    }

    // Cap at maxItems (prioritize highest scores)
    const capped = passed.slice(0, this.maxItems);
    const overflow = passed.slice(this.maxItems);

    log.info(`Scoring: ${items.length} items → ${capped.length} passed, ${rejected.length + overflow.length} rejected/deferred`);
    if (capped.length > 0) {
      log.info(`  Score range: ${capped[capped.length - 1].heuristic_score} - ${capped[0].heuristic_score}`);
    }

    return { passed: capped, rejected: [...rejected, ...overflow] };
  }

  /**
   * Score a single item across multiple signal dimensions.
   */
  scoreItem(item) {
    const title = (item.raw_title || '').toLowerCase();
    const desc = (item.raw_description || '').toLowerCase();
    const url = item.url || '';
    const source = item.source || '';
    const upvotes = item.upvotes || 0;
    const domain = this._extractDomain(url);

    let score = 0;
    const reasons = [];

    // ── DIMENSION 0: HARD BLACKLIST (Phase 17) ─ instant rejection ──
    // Profile pages, articles, threads, videos, etc. are NEVER tools.
    // Reject before any other scoring to save Gemini money + protect credibility.
    const hardMatch = HARD_BLACKLIST_PATTERNS.find(rx => rx.test(url));
    if (hardMatch) {
      return { score: -100, reasons: [`Hard blacklist: URL pattern (${hardMatch.toString().slice(0, 40)})`] };
    }

    // ── DIMENSION 1: ANTI-SIGNALS (checked first — can push score negative) ──

    // Academic domain → hard reject
    if (ACADEMIC_DOMAINS.some(d => domain.includes(d))) {
      return { score: -100, reasons: ['Hard reject: academic domain'] };
    }

    // Anti-pattern title match
    const antiMatch = ANTI_PATTERNS.find(p => title.includes(p));
    if (antiMatch) {
      score -= 25;
      reasons.push(`-25: Anti-pattern "${antiMatch}"`);
    }

    // News domain
    if (NEWS_DOMAINS.some(d => domain.includes(d))) {
      score -= 20;
      reasons.push('-20: News/content domain');
    }

    // ── DIMENSION 2: LAUNCH SIGNALS ──────────────────────────────────────────

    const launchMatch = LAUNCH_SIGNALS.find(s => title.includes(s));
    if (launchMatch) {
      score += 25;
      reasons.push(`+25: Launch signal "${launchMatch}"`);
    }

    // ── DIMENSION 3: TECHNOLOGY SIGNALS ──────────────────────────────────────

    // Count how many tech signals appear in title + description
    let techHits = 0;
    const titleAndDesc = `${title} ${desc}`;
    for (const signal of TECH_SIGNALS) {
      if (titleAndDesc.includes(signal)) techHits++;
    }

    if (techHits >= 3) {
      score += 20;
      reasons.push(`+20: ${techHits} tech signals`);
    } else if (techHits >= 1) {
      score += 10;
      reasons.push(`+10: ${techHits} tech signal(s)`);
    }

    // ── DIMENSION 4: SOURCE TRUST ────────────────────────────────────────────

    const sourceScores = {
      product_hunt: 25,
      github: 18,
      hacker_news: 12,
      tldr_ai: 15,
      bens_bites: 15,
      the_rundown_ai: 12,
    };
    const sourceScore = sourceScores[source] || 5;
    score += sourceScore;
    reasons.push(`+${sourceScore}: Source (${source})`);

    // ── DIMENSION 5: DOMAIN ANALYSIS ─────────────────────────────────────────

    if (TOOL_HOSTING_DOMAINS.some(d => domain.includes(d))) {
      score += 15;
      reasons.push('+15: Tool hosting domain');
    }

    // Custom domain (not a known platform) with short path → likely a product
    if (!TOOL_HOSTING_DOMAINS.some(d => domain.includes(d)) &&
        !NEWS_DOMAINS.some(d => domain.includes(d)) &&
        !ACADEMIC_DOMAINS.some(d => domain.includes(d))) {
      const pathDepth = (url.split('/').length - 3); // after protocol + domain
      if (pathDepth <= 1) {
        score += 10;
        reasons.push('+10: Custom domain with short path (product pattern)');
      }
    }

    // ── DIMENSION 6: URL STRUCTURE ───────────────────────────────────────────

    // URLs with dates in them are almost always articles
    if (/\/\d{4}\/\d{2}\//.test(url)) {
      score -= 12;
      reasons.push('-12: Date pattern in URL (article)');
    }

    // ── DIMENSION 7: ENGAGEMENT ──────────────────────────────────────────────

    if (upvotes > 200) {
      score += 18;
      reasons.push('+18: Viral (200+ upvotes/stars)');
    } else if (upvotes > 50) {
      score += 10;
      reasons.push('+10: Strong engagement (50+)');
    } else if (upvotes > 10) {
      score += 5;
      reasons.push('+5: Some engagement (10+)');
    }

    // ── DIMENSION 8: TITLE STRUCTURE ─────────────────────────────────────────

    const wordCount = (item.raw_title || '').trim().split(/\s+/).length;

    // Very short titles (1-3 words) are often product names
    if (wordCount >= 1 && wordCount <= 3) {
      score += 8;
      reasons.push(`+8: Short title (${wordCount} words — product name pattern)`);
    }

    // Very long titles (>15 words) are usually news headlines
    if (wordCount > 15) {
      score -= 8;
      reasons.push(`-8: Long title (${wordCount} words — headline pattern)`);
    }

    // Title contains a colon followed by a tagline (common for launches)
    if (/^[^:]{2,30}:/.test(item.raw_title || '')) {
      score += 5;
      reasons.push('+5: "Name: Tagline" pattern');
    }

    // ── DIMENSION 9: FRESHNESS BONUS ─────────────────────────────────────────

    if (item.published_at) {
      try {
        const ageMs = Date.now() - new Date(item.published_at).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);
        if (ageHours < 48) {
          score += 8;
          reasons.push('+8: Fresh (< 48 hours old)');
        }
      } catch { /* ignore */ }
    }

    // ── DIMENSION 10: DESCRIPTION RICHNESS ───────────────────────────────────

    if (desc.length > 200) {
      score += 5;
      reasons.push('+5: Rich description');
    }

    // Clamp to [-50, 100]
    score = Math.max(-50, Math.min(100, score));

    return { score, reasons };
  }

  _extractDomain(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return '';
    }
  }
}

module.exports = { HeuristicPreFilter };
