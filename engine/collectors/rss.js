/**
 * EverythinInAI Discovery Engine — RSS/Atom Feed Collector
 *
 * Replaces the fragile regex-based XML parser with `fast-xml-parser`.
 * Handles RSS 2.0, Atom, and CDATA-wrapped content.
 *
 * Feeds:
 *   - Product Hunt AI category
 *   - TLDR AI newsletter
 *   - Ben's Bites
 *   - The Rundown AI
 *   - AI Tool Report
 *   (Easily extensible — just add URLs to FEEDS array)
 */
const { XMLParser } = require('fast-xml-parser');
const { BaseCollector } = require('./base');

const FEEDS = [
  {
    url: 'https://www.producthunt.com/feed?category=artificial-intelligence',
    source: 'product_hunt',
    label: 'Product Hunt AI',
  },
  {
    url: 'https://tldr.tech/api/rss/ai',
    source: 'tldr_ai',
    label: 'TLDR AI',
  },
  {
    url: 'https://www.bensbites.com/feed',
    source: 'bens_bites',
    label: "Ben's Bites",
  },
  {
    url: 'https://therundownai.com/feed',
    source: 'the_rundown_ai',
    label: 'The Rundown AI',
  },
];

class RSSCollector extends BaseCollector {
  constructor(feeds = FEEDS) {
    super('rss');
    this.feeds = feeds;
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      cdataPropName: '__cdata',
      parseTagValue: true,
      trimValues: true,
    });
  }

  async collect(sinceTimestamp, _untilTimestamp) {
    const allItems = [];
    const sinceDate = new Date(sinceTimestamp * 1000);

    for (const feed of this.feeds) {
      try {
        const items = await this._fetchFeed(feed, sinceDate);
        allItems.push(...items);
        this.log.info(`  ${feed.label}: ${items.length} items`);
      } catch (error) {
        this.log.error(`  ${feed.label} (${feed.url}) failed: ${error.message}`);
        // Continue with other feeds
      }

      await this._sleep(500);
    }

    this.log.info(`Total RSS items: ${allItems.length}`);
    return allItems;
  }

  async _fetchFeed(feed, sinceDate) {
    const rawXml = await this.fetchWithRetry(feed.url, {
      headers: {
        'User-Agent': 'EverythinInAI-Bot/2.0 (+https://github.com/kssharda0717-dev/EverythinInAI)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
      // Response might be text, not JSON
      transformResponse: [(data) => data],
    });

    if (!rawXml || typeof rawXml !== 'string') {
      this.log.warn(`Empty or non-string response from ${feed.label}`);
      return [];
    }

    const parsed = this.parser.parse(rawXml);
    const items = [];

    // Handle RSS 2.0 format
    const rssItems = this._extractPath(parsed, ['rss', 'channel', 'item']);
    if (rssItems) {
      const itemArray = Array.isArray(rssItems) ? rssItems : [rssItems];
      for (const item of itemArray) {
        const normalized = this._normalizeRssItem(item, feed, sinceDate);
        if (normalized) items.push(normalized);
      }
    }

    // Handle Atom format
    const atomEntries = this._extractPath(parsed, ['feed', 'entry']);
    if (atomEntries) {
      const entryArray = Array.isArray(atomEntries) ? atomEntries : [atomEntries];
      for (const entry of entryArray) {
        const normalized = this._normalizeAtomEntry(entry, feed, sinceDate);
        if (normalized) items.push(normalized);
      }
    }

    return items;
  }

  _normalizeRssItem(item, feed, sinceDate) {
    const title = this._extractText(item.title);
    const link = this._extractLink(item.link);
    const description = this._extractText(item.description);
    const pubDate = item.pubDate || item['dc:date'] || '';

    if (!title || !link) return null;

    // Date filter
    if (pubDate) {
      try {
        const itemDate = new Date(pubDate);
        if (itemDate < sinceDate) return null;
      } catch { /* ignore invalid dates */ }
    }

    return this.createItem({
      raw_title: title,
      raw_description: this._stripHtml(description).substring(0, 2000),
      url: link,
      source: feed.source,
      source_url: link,
      author: this._extractText(item['dc:creator'] || item.author || ''),
      published_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    });
  }

  _normalizeAtomEntry(entry, feed, sinceDate) {
    const title = this._extractText(entry.title);
    let link = '';
    if (entry.link) {
      if (typeof entry.link === 'string') link = entry.link;
      else if (Array.isArray(entry.link)) {
        const alt = entry.link.find(l => l['@_rel'] === 'alternate');
        link = (alt || entry.link[0])?.['@_href'] || '';
      } else {
        link = entry.link['@_href'] || '';
      }
    }
    const description = this._extractText(entry.summary || entry.content || '');
    const pubDate = entry.published || entry.updated || '';

    if (!title || !link) return null;

    if (pubDate) {
      try {
        const itemDate = new Date(pubDate);
        if (itemDate < sinceDate) return null;
      } catch { /* ignore */ }
    }

    return this.createItem({
      raw_title: title,
      raw_description: this._stripHtml(description).substring(0, 2000),
      url: link,
      source: feed.source,
      source_url: link,
      author: this._extractText(entry.author?.name || ''),
      published_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    });
  }

  _extractPath(obj, path) {
    let current = obj;
    for (const key of path) {
      if (!current || typeof current !== 'object') return null;
      current = current[key];
    }
    return current;
  }

  _extractText(val) {
    if (!val) return '';
    if (typeof val === 'string') return val.trim();
    if (val.__cdata) return String(val.__cdata).trim();
    if (val['#text']) return String(val['#text']).trim();
    return String(val).trim();
  }

  _extractLink(val) {
    if (!val) return '';
    if (typeof val === 'string') return val.trim();
    if (val['#text']) return String(val['#text']).trim();
    if (val['@_href']) return String(val['@_href']).trim();
    return '';
  }

  _stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

module.exports = { RSSCollector };
