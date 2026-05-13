#!/usr/bin/env node
/**
 * Scrapers Diagnostic
 * Runs each "dead" collector live and reports what came back.
 * Read-only: never writes to DB.
 */
const {
  RedditCollector,
  ArxivCollector,
  HuggingFaceCollector,
  AILabBlogsCollector,
  ProductHuntCollector,
  GitHubTrendingCollector,
} = require('../engine/collectors/sources_v2');

(async () => {
  const collectors = [
    ['Reddit',         new RedditCollector()],
    ['ArXiv',          new ArxivCollector()],
    ['HuggingFace',    new HuggingFaceCollector()],
    ['AILabBlogs',     new AILabBlogsCollector()],
    ['ProductHunt/Replicate', new ProductHuntCollector()],
    ['GitHubTrending', new GitHubTrendingCollector()],
  ];
  const sinceTimestamp = Math.floor(Date.now() / 1000) - 7 * 86400; // last 7 days

  console.log('\n' + '═'.repeat(70));
  console.log('  SCRAPER DIAGNOSTIC — what each "dead" collector actually returns');
  console.log('═'.repeat(70) + '\n');

  for (const [name, c] of collectors) {
    console.log('\n──── [' + name + '] ────');
    const t0 = Date.now();
    try {
      const items = await c.collect(sinceTimestamp);
      const ms = Date.now() - t0;
      console.log(`  Returned ${items?.length ?? 0} items in ${ms}ms`);
      if (items && items.length > 0) {
        console.log('  First 3 items:');
        for (const it of items.slice(0, 3)) {
          console.log(`    • ${(it.title || '(no title)').slice(0, 80)}`);
          console.log(`      url: ${(it.url || '(no url)').slice(0, 100)}`);
          console.log(`      source: ${it.source || '(no source)'}`);
        }
      }
    } catch (err) {
      const ms = Date.now() - t0;
      console.log(`  ✗ ERROR after ${ms}ms: ${err.message}`);
    }
  }
  console.log('\n' + '═'.repeat(70));
  process.exit(0);
})();
