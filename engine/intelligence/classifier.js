/**
 * EverythinInAI Discovery Engine — Gemini Classifier
 *
 * Sends batches of pre-filtered items to Gemini 1.5 Flash for classification.
 * Uses structured JSON output mode for reliable parsing.
 * Integrates with the DynamicRateLimiter for safe API usage.
 *
 * Key improvements over the old n8n node:
 *   1. API key is NOT in the URL — it's in the header (x-goog-api-key)
 *   2. Robust JSON extraction with multiple fallback strategies
 *   3. Token estimation for accurate rate limiting
 *   4. Batch results are accumulated properly (fixes the n8n loop bug)
 */

const axios = require('axios');
const { config } = require('../core/config');
const { getRateLimiter } = require('../core/rate-limiter');
const { createLogger } = require('../utils/logger');

const log = createLogger('classifier');

const CATEGORIES = [
  'LLM & Chat', 'Image Generation', 'Video Generation', 'Audio & Music',
  'Code Assistant', 'Writing & Content', 'Search & Research', 'Productivity',
  'Data Analysis', 'Customer Service', 'Marketing', 'Education',
  'Healthcare', 'Finance', 'Developer Tools', 'Agent & Automation',
  'Voice & Speech', 'Video Editing', '3D & Design', 'Other',
];

const PRICING_OPTIONS = ['free', 'freemium', 'paid', 'open_source', 'unknown'];

class GeminiClassifier {
  constructor() {
    this.apiKey = config.gemini.apiKey;
    this.model = config.gemini.model;
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
  }

  /**
   * Classify a batch of queue items.
   * @param {Array} items - Items from the discovery_queue table
   * @returns {Object} { items: [...classified results], estimatedTokens: number }
   */
  async classifyBatch(items) {
    const prompt = this._buildPrompt(items);
    const estimatedInputTokens = Math.ceil(prompt.length / 4);

    log.debug(`Classifying batch of ${items.length} items (~${estimatedInputTokens} input tokens)`);

    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 8192,
      },
    };

    const response = await axios.post(this.baseUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      timeout: 60000,
    });

    // Extract and parse the response
    const rawText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const estimatedOutputTokens = Math.ceil(rawText.length / 4);
    const totalTokens = estimatedInputTokens + estimatedOutputTokens;

    const parsed = this._parseResponse(rawText, items);

    log.debug(`Batch classified: ${parsed.length} results (~${totalTokens} total tokens)`);

    return {
      items: parsed,
      estimatedTokens: totalTokens,
    };
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

    return `You are an AI tool classifier for the world's most comprehensive AI tools directory.

Analyze each item below and determine if it is a REAL, USABLE AI-powered software tool or product.

CRITERIA FOR "IS AN AI TOOL":
- It is software, an app, an API, a library, or a platform that users can actually use
- It uses AI/ML as a core feature (not just mentions AI in passing)
- It has a real product URL where users can access or download it
- Open-source repos that provide a usable tool/library count as tools

NOT AN AI TOOL IF:
- News article, blog post, opinion piece, or editorial
- Academic research paper (even if it has code)
- GitHub "awesome list" or curated collection (not a tool itself)
- Company announcement without a usable product
- Job posting, funding announcement, or acquisition news
- Tutorial, guide, or "how to" content

For each item that IS an AI tool, provide enriched metadata.
For items that are NOT tools, still include them with is_ai_tool: false.

RESPOND WITH A JSON ARRAY. Each element must have this exact structure:
{
  "index": <number matching the input index>,
  "queueId": "<the queue_id from input>",
  "is_ai_tool": <boolean>,
  "confidence": <0.0 to 1.0>,
  "name": "<clean product name>" or null,
  "tagline": "<single sentence, max 100 chars>" or null,
  "description": "<2-3 sentences about the product, features, target users>" or null,
  "url": "<primary product URL, prefer homepage over GitHub/PH listing>" or null,
  "category": <one of ${JSON.stringify(CATEGORIES)}> or null,
  "tags": ["tag1", "tag2", "tag3"] or [],
  "pricing": <one of ${JSON.stringify(PRICING_OPTIONS)}> or null
}

Return ONLY the JSON array. No markdown fences, no explanation.

ITEMS TO ANALYZE:
${JSON.stringify(itemsForPrompt, null, 2)}`;
  }

  _parseResponse(rawText, originalItems) {
    let parsed;

    // Strategy 1: Direct JSON parse (should work with responseMimeType: application/json)
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Strategy 2: Extract JSON array from text
      try {
        const match = rawText.match(/\[[\s\S]*\]/);
        if (match) {
          parsed = JSON.parse(match[0]);
        }
      } catch {
        // Strategy 3: Try to fix common JSON issues
        try {
          const cleaned = rawText
            .replace(/```json\s*/g, '')
            .replace(/```\s*/g, '')
            .trim();
          parsed = JSON.parse(cleaned);
        } catch {
          log.error(`Failed to parse Gemini response. Raw text (first 500 chars): ${rawText.substring(0, 500)}`);
          // Return all items as errors so they can be retried
          return originalItems.map(item => ({
            queueId: item.id,
            is_ai_tool: false,
            confidence: 0,
            error: 'Failed to parse Gemini response',
          }));
        }
      }
    }

    if (!Array.isArray(parsed)) {
      log.error('Gemini response is not an array');
      return originalItems.map(item => ({
        queueId: item.id,
        is_ai_tool: false,
        confidence: 0,
        error: 'Response not an array',
      }));
    }

    // Map parsed results back to queue IDs
    return parsed.map((result, idx) => {
      // Try to match by queueId first, then by index
      const queueId = result.queueId || result.queue_id ||
        (originalItems[result.index]?.id) ||
        (originalItems[idx]?.id) || null;

      return {
        queueId,
        is_ai_tool: !!result.is_ai_tool,
        confidence: typeof result.confidence === 'number' ? result.confidence : 0,
        name: result.name || null,
        tagline: result.tagline || null,
        description: result.description || null,
        url: result.url || null,
        category: CATEGORIES.includes(result.category) ? result.category : 'Other',
        tags: Array.isArray(result.tags) ? result.tags.slice(0, 5).map(t => String(t).toLowerCase()) : [],
        pricing: PRICING_OPTIONS.includes(result.pricing) ? result.pricing : 'unknown',
      };
    });
  }
}

module.exports = { GeminiClassifier };
