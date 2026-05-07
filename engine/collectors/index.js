/**
 * EverythinInAI Discovery Engine — Collector Registry
 *
 * Central registry for all source collectors.
 * To add a new source, create a new collector file and register it here.
 */
const { HackerNewsCollector } = require('./hackernews');
const { GitHubCollector } = require('./github');
const { RSSCollector } = require('./rss');
const {
  RedditCollector,
  ArxivCollector,
  HuggingFaceCollector,
  AILabBlogsCollector,
  ProductHuntCollector,
  GitHubTrendingCollector,
} = require('./sources_v2');

function createAllCollectors() {
  return [
    new HackerNewsCollector(),
    new GitHubCollector(),
    new RSSCollector(),
    // v2 sources (May 2026)
    new RedditCollector(),
    new ArxivCollector(),
    new HuggingFaceCollector(),
    new AILabBlogsCollector(),
    new ProductHuntCollector(),
    new GitHubTrendingCollector(),
  ];
}

module.exports = {
  createAllCollectors,
  HackerNewsCollector,
  GitHubCollector,
  RSSCollector,
  RedditCollector,
  ArxivCollector,
  HuggingFaceCollector,
  AILabBlogsCollector,
  ProductHuntCollector,
  GitHubTrendingCollector,
};
