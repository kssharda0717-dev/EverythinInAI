/**
 * EverythinInAI Discovery Engine — Gemini Classifier v2
 *
 * v2 upgrade (May 2026):
 *   - Outputs full taxonomy: tool / news / research / opinion / drama / funding /
 *     release / tutorial / meme
 *   - Computes virality_score (0-10) for avatar prioritization
 *   - Suggests avatar_angles
 *   - Determines is_evergreen and newsworthy_until
 *   - Maintains backwards compatibility: still fills v1 fields when type==='tool'
 *
 * State machine reads `result.type`. If 'tool', the v1 path triggers (insert into
 * `tools`). Otherwise the new signal path triggers (insert into `ai_signals`).
 */

const axios = require('axios');
const { config } = require('../core/config');
const { createLogger } = require('../utils/logger');

const log = createLogger('classifier');

// Tool categories (kept for backwards compatibility)
const CATEGORIES = [
  'Code Assistant', 'Image Generation', 'Video Generation', 'Audio & Music',
  'LLM & Chat', 'Agent & Automation', 'Data & Analytics', 'Productivity',
  'Marketing & Sales', 'Developer Tools', 'Design Tools', 'Research & Education',
  'Healthcare', 'Finance', 'Gaming', 'Robotics', 'Security',
  'Translation & Language', 'Writing & Content', 'Other',
];

const PRICING_OPTIONS = ['free', 'freemium', 'paid', 'enterprise', 'unknown'];

const SIGNAL_TYPES = [
  'tool', 'news', 'research', 'opinion', 'drama', 'funding',
  'release', 'tutorial', 'meme',
];

const AVATAR_ANGLES = [
  'hot_take', 'explainer', 'humor', 'tutorial',
  'reaction', 'curation', 'lure',
];

class GeminiClassifier {
  constructor() {
    this.apiKey = config.gemini.apiKey;
    this.model = config.gemini.model;
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
  }

  async classifyBatch(items) {
    const prompt = this._buildPrompt(items);
    const estimatedInputTokens = Math.ceil(prompt.length / 4);
    log.debug(`Classifying batch of ${items.length} items (~${estimatedInputTokens} input tokens)`);

    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 16384,
      },
    };

    const response = await axios.post(this.baseUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      timeout: 90000,
    });

    const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const estimatedOutputTokens = Math.ceil(rawText.length / 4);
    const totalTokens = estimatedInputTokens + estimatedOutputTokens;

    const parsed = this._parseResponse(rawText, items);

    log.debug(`Batch classified: ${parsed.length} results (~${totalTokens} total tokens)`);

    return { items: parsed, estimatedTokens: totalTokens };
  }

  _buildPrompt(items) {
    const itemsForPrompt = items.map((item, idx) => ({
      index: idx,
      queue_id: item.id,
      title: item.raw_title,
      description: (item.raw_description || '').substring(0, 500),
      url: item.url,
      source: item.source,
      upvotes: item.upvotes,
    }));

    return `You are the classification brain for EverythinInAI — a real-time directory of EVERYTHING happening in the AI ecosystem (tools, news, research, drama, releases, opinions). You classify items into one of 9 types and enrich each with structured metadata that powers a downstream avatar content pipeline.

═══════════════════════════════════════════════════════════════
TAXONOMY — pick exactly ONE \`type\` per item:
═══════════════════════════════════════════════════════════════

• "tool"      — a usable AI product / library / API / app. Has a homepage where someone can sign up, install, or fork. Examples: LangChain, Cursor, Perplexity, Replicate, Lovable.

• "news"      — newsworthy event in AI. Time-sensitive, decays fast. Examples: "OpenAI announces GPT-5", "EU passes AI act".

• "research"  — academic paper, preprint, or formal research finding. Examples: arXiv papers, Google research blog posts, DeepMind papers.

• "opinion"   — analysis, hot take, blog essay, expert commentary. Examples: Karpathy's blog, Stratechery on AI.

• "drama"     — controversy, lawsuit, public argument, scandal, departure. Examples: Sam Altman firing, Sutskever leaves OpenAI, copyright lawsuits.

• "funding"   — VC announcement, IPO, M&A, valuation news. Examples: "Mistral raises $640M", "Anthropic acquires X".

• "release"   — formal product/model launch by a recognized lab/company. Examples: "Claude 4 released", "Gemini 2.5 Flash GA", "Llama 4 weights drop".

• "tutorial"  — well-crafted educational content (NOT generic listicles). Examples: "Build a RAG agent in 30 lines", "Fine-tune Llama for X".

• "meme"      — viral AI moment, joke, screenshot going around.

═══════════════════════════════════════════════════════════════
HARD REJECT (set type:null AND is_ai_tool:false) — these get discarded:
═══════════════════════════════════════════════════════════════

• Generic listicles ("Top 10 AI tools you must use in 2026")
• "Awesome-XYZ" GitHub lists with no original tool
• Pure marketing fluff with no substance
• Job postings, dead links, spam
• Items mentioning AI only in passing
• Non-English content unless extremely high-virality

═══════════════════════════════════════════════════════════════
For EACH item, output an object with this EXACT shape:
═══════════════════════════════════════════════════════════════

{
  "index": <input index>,
  "queueId": "<input queue_id>",
  "type": "tool" | "news" | "research" | "opinion" | "drama" | "funding" | "release" | "tutorial" | "meme" | null,
  "subtype": "<short free text e.g. 'model_launch', 'preprint', 'lawsuit'>",
  "confidence": <0.0 to 1.0>,

  "name": "<clean human-readable name or headline>",
  "summary": "<single sentence, max 120 chars>",
  "narrative": "<2-3 sentences explaining why it matters>",
  "url": "<primary URL>",

  "entities": ["OpenAI", "Anthropic", ...],
  "topics": ["agents", "rag", "diffusion", "open-source", ...],

  "virality_score": <0 to 10>,
  "avatar_angles": ["hot_take" | "explainer" | "humor" | "tutorial" | "reaction" | "curation" | "lure"],
  "is_evergreen": <true if still relevant 6 months from now>,
  "newsworthy_until": <ISO timestamp or null>,

  "is_ai_tool": <true ONLY when type === "tool">,
  "tagline": "<single sentence elevator pitch, max 100 chars>",
  "description": "<2-3 sentences for product detail page>",
  "category": <one of ${JSON.stringify(CATEGORIES)}> or null,
  "tags": ["tag1", "tag2"] or [],
  "pricing": <one of ${JSON.stringify(PRICING_OPTIONS)}>
}

═══════════════════════════════════════════════════════════════
VIRALITY SCORING GUIDE (0-10):
═══════════════════════════════════════════════════════════════

10 = "Sam Altman fired" / "GPT-5 just released" tier — everyone in tech is talking
 8 = New SOTA model / major lab drama / massive funding round
 6 = Solid useful tool many devs would care about / interesting research
 4 = Niche-but-quality tool / mid-tier news
 2 = Boring update / yet-another-llm-wrapper / minor blog post
 0 = Spam / irrelevant

═══════════════════════════════════════════════════════════════
RETURN A JSON ARRAY. No markdown fences. No explanation.
═══════════════════════════════════════════════════════════════

ITEMS TO CLASSIFY:
${JSON.stringify(itemsForPrompt, null, 2)}`;
  }

  _parseResponse(rawText, originalItems) {
    let parsed;

    try {
      parsed = JSON.parse(rawText);
    } catch {
      try {
        const match = rawText.match(/\[[\s\S]*\]/);
        if (match) parsed = JSON.parse(match[0]);
      } catch {
        try {
          const cleaned = rawText
            .replace(/```json\s*/g, '')
            .replace(/```\s*/g, '')
            .trim();
          parsed = JSON.parse(cleaned);
        } catch {
          log.error(`Failed to parse Gemini response. First 500 chars: ${rawText.substring(0, 500)}`);
          return originalItems.map((item) => ({
            queueId: item.id,
            type: null,
            is_ai_tool: false,
            confidence: 0,
            error: 'Failed to parse Gemini response',
          }));
        }
      }
    }

    if (!Array.isArray(parsed)) {
      log.error('Gemini response is not an array');
      return originalItems.map((item) => ({
        queueId: item.id,
        type: null,
        is_ai_tool: false,
        confidence: 0,
        error: 'Response not an array',
      }));
    }

    return parsed.map((result, idx) => {
      const originalItem = originalItems[result.index] || originalItems[idx];
      if (!originalItem) {
        return { queueId: null, type: null, is_ai_tool: false, error: 'No matching input item' };
      }

      const type = SIGNAL_TYPES.includes(result.type) ? result.type : null;
      const isTool = type === 'tool';

      const angles = Array.isArray(result.avatar_angles)
        ? result.avatar_angles.filter((a) => AVATAR_ANGLES.includes(a))
        : [];

      const category = isTool && CATEGORIES.includes(result.category)
        ? result.category
        : (isTool ? 'Other' : null);

      const pricing = isTool && PRICING_OPTIONS.includes(result.pricing)
        ? result.pricing
        : (isTool ? 'unknown' : null);

      const virality = typeof result.virality_score === 'number'
        ? Math.max(0, Math.min(10, Math.round(result.virality_score)))
        : 0;

      return {
        queueId: result.queueId || originalItem.id,
        type,
        subtype: (result.subtype || '').substring(0, 100),
        confidence: typeof result.confidence === 'number' ? Math.max(0, Math.min(1, result.confidence)) : 0,

        name: result.name || originalItem.raw_title,
        summary: (result.summary || '').substring(0, 240),
        narrative: (result.narrative || '').substring(0, 1500),
        url: result.url || originalItem.url,

        entities: Array.isArray(result.entities) ? result.entities.slice(0, 20).map(String) : [],
        topics: Array.isArray(result.topics) ? result.topics.slice(0, 20).map(String) : [],

        virality_score: virality,
        avatar_angles: angles,
        is_evergreen: result.is_evergreen === true,
        newsworthy_until: result.newsworthy_until || null,

        is_ai_tool: isTool === true,
        tagline: isTool ? (result.tagline || '').substring(0, 200) : null,
        description: isTool ? (result.description || '').substring(0, 1500) : null,
        category,
        tags: Array.isArray(result.tags)
          ? result.tags.map((t) => String(t).toLowerCase().substring(0, 50)).slice(0, 10)
          : [],
        pricing,
      };
    });
  }
}

module.exports = { GeminiClassifier, CATEGORIES, PRICING_OPTIONS, SIGNAL_TYPES, AVATAR_ANGLES };
