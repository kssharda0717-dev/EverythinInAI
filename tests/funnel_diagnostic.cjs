#!/usr/bin/env node
/**
 * Per-source funnel diagnostic.
 * For each source, counts how many items entered the discovery_queue and where they landed.
 * Read-only: never writes.
 */
const db = require('../engine/core/database').getClient();

(async () => {
  const lookbackMin = parseInt(process.argv[2] || '90', 10);
  const since = new Date(Date.now() - lookbackMin * 60 * 1000).toISOString();

  const { data: rows, error } = await db.from('discovery_queue')
    .select('source, status, error_message, raw_title')
    .gte('created_at', since)
    .limit(5000);

  if (error) { console.log('ERROR:', error.message); return; }
  if (!rows || rows.length === 0) {
    console.log(`No discovery_queue rows in the last ${lookbackMin} minutes.`);
    console.log('Either the cron has not fired in this window, or the queue is purged after processing.');
    return;
  }

  console.log(`\nTotal queue rows in last ${lookbackMin}m: ${rows.length}\n`);

  // Group by source x status
  const bySource = {};
  for (const r of rows) {
    const src = r.source || 'unknown';
    if (!bySource[src]) {
      bySource[src] = { total: 0, classified: 0, rejected: 0, dedup: 0, error: 0, pending: 0, processing: 0 };
    }
    const s = bySource[src];
    s.total++;
    const status = r.status || 'unknown';
    const err = (r.error_message || '').toLowerCase();
    if (status === 'classified') s.classified++;
    else if (status === 'rejected') {
      if (err.includes('duplicate') || err.includes('dedup') || err.includes('already exists') || err.includes('similar')) {
        s.dedup++;
      } else {
        s.rejected++;
      }
    }
    else if (status === 'error') s.error++;
    else if (status === 'pending') s.pending++;
    else if (status === 'processing') s.processing++;
  }

  console.log('PER-SOURCE FUNNEL:');
  console.log('Source                 | Total | Classified | Rejected | DedupSkip | Error | Pending');
  console.log('-'.repeat(95));
  const sorted = Object.entries(bySource).sort((a, b) => b[1].total - a[1].total);
  for (const [src, c] of sorted) {
    console.log(
      src.padEnd(22) + ' | ' +
      String(c.total).padStart(5) + ' | ' +
      String(c.classified).padStart(10) + ' | ' +
      String(c.rejected).padStart(8) + ' | ' +
      String(c.dedup).padStart(9) + ' | ' +
      String(c.error).padStart(5) + ' | ' +
      String(c.pending).padStart(7)
    );
  }

  // Sample rejected items per non-github source
  console.log('\nSAMPLE REJECTIONS (top 3 per non-github/HN source):');
  const focus = Object.keys(bySource).filter(s => !s.startsWith('github') && !s.startsWith('hacker'));
  for (const src of focus) {
    const { data: rejs } = await db.from('discovery_queue')
      .select('raw_title, error_message')
      .eq('source', src)
      .eq('status', 'rejected')
      .gte('created_at', since)
      .limit(3);
    if (rejs && rejs.length > 0) {
      console.log('\n  ' + src + ':');
      for (const r of rejs) {
        const title = (r.raw_title || '(empty)').slice(0, 70);
        const reason = (r.error_message || '(no reason)').slice(0, 100);
        console.log('    title  : ' + title);
        console.log('    reason : ' + reason);
      }
    }
  }
  process.exit(0);
})().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
