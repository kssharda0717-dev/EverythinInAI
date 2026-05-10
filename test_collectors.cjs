const { createAllCollectors } = require('./engine/collectors');
const collectors = createAllCollectors();
const since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
const until = Math.floor(Date.now() / 1000);

(async () => {
  // Skip already-working collectors that don't depend on the changes
  const skip = ['HackerNewsCollector', 'GitHubCollector', 'RSSCollector', 'GitHubTrendingCollector'];
  for (const c of collectors) {
    if (skip.includes(c.constructor.name)) continue;
    const start = Date.now();
    try {
      const items = await c.collect(since, until);
      console.log('  RESULT', c.constructor.name.padEnd(28), 'returned', String(items?.length || 0).padStart(5), 'items in', (Date.now() - start), 'ms');
    } catch (err) {
      console.log('  ERROR ', c.constructor.name.padEnd(28), 'FAILED:', err.message?.slice(0, 100));
    }
  }
})();
