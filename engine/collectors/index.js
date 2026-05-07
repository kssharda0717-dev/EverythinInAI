/**
 * EverythinInAI Discovery Engine — Collector Registry
 *
 * Central registry for all source collectors.
 * To add a new source, create a new collector file and register it here.
 */
const { HackerNewsCollector } = require('./hackernews');
const { GitHubCollector } = require('./github');
const { RSSCollector } = require('./rss');

function createAllCollectors() {
  return [
    new HackerNewsCollector(),
    new GitHubCollector(),
    new RSSCollector(),
  ];
}

module.exports = { createAllCollectors, HackerNewsCollector, GitHubCollector, RSSCollector };
