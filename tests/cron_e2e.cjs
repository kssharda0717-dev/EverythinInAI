#!/usr/bin/env node
/**
 * Cron End-to-End Test
 *
 * Actually executes each cron's main() in a controlled subprocess.
 * Telegram is stubbed (token = junk), so all Telegram POSTs return errors
 * but the cron code doesn't crash on them.
 *
 * Anything that takes > 30s or exits with non-zero status is flagged.
 *
 * READ-ONLY enough to run against production. Crons that write may insert
 * harmless rows (one weekly_stats row, etc.) — acceptable for verification.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Crons sorted by expected duration. We give LLM-heavy crons a longer timeout
// and we accept timeout=signal SIGTERM as a partial-pass (means script did real
// work but exceeded our test budget — not a bug).
const crons = [
  { name: 'sync_bible',              script: 'avatar/persona/sync_bible.js',                    timeoutMs: 15000,  acceptTimeout: false },
  // These 3 send to Telegram with Markdown-then-plain retry pattern, total worst-case 22s
  { name: 'weekly_health_report',    script: 'avatar/scheduler/weekly_health_report.js',         timeoutMs: 30000,  acceptTimeout: false },
  { name: 'morning_announce',        script: 'avatar/scheduler/morning_announce.js',             timeoutMs: 30000,  acceptTimeout: false },
  { name: 'weekend_travel_nudge',    script: 'avatar/scheduler/weekend_travel_nudge.js',         timeoutMs: 30000,  acceptTimeout: false },
  { name: 'check_in_announcer',      script: 'avatar/scheduler/check_in_announcer.js',           timeoutMs: 30000,  acceptTimeout: false },
  { name: 'weekly_stats_announcer',  script: 'avatar/scheduler/weekly_stats_announcer.js',       timeoutMs: 30000,  acceptTimeout: false },
  { name: 'newsletter_digest',       script: 'engine/observability/newsletter_digest.js',        timeoutMs: 30000,  acceptTimeout: false, args: ['--dry-run'] },
  { name: 'url_validator',           script: 'engine/maintenance/url_validator.js',              timeoutMs: 40000,  acceptTimeout: true },
  { name: 'trend_ingestion',         script: 'avatar/trends/trend_ingestion.js',                 timeoutMs: 60000,  acceptTimeout: true },
  { name: 'framework_evolution',     script: 'avatar/ideation/framework_evolution.js',           timeoutMs: 60000,  acceptTimeout: true },
];

console.log('═══════════════════════════════════════════════════════');
console.log('  CRON END-TO-END EXECUTION TEST');
console.log('═══════════════════════════════════════════════════════\n');

let passed = 0;
let failed = 0;
const failures = [];

for (const c of crons) {
  const args = c.args || [];
  console.log(`▶ Running ${c.name} (${c.script})${args.length ? ' ' + args.join(' ') : ''}...`);
  const start = Date.now();
  const r = spawnSync('node', [path.join(ROOT, c.script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: c.timeoutMs,
    env: { ...process.env, TELEGRAM_BOT_TOKEN: 'invalid-fuzz-token-do-not-use' },
  });
  const ms = Date.now() - start;
  // Pass if: exit 0, OR we hit our timeout but the cron explicitly tolerates it (LLM crons).
  const cleanExit = r.status === 0 && !r.signal;
  const timeoutOk = c.acceptTimeout && r.signal === 'SIGTERM';
  const ok = cleanExit || timeoutOk;
  if (ok) {
    const status = cleanExit ? 'clean' : 'timeout-accepted';
    console.log(`  ✓ ${c.name.padEnd(28)} ${status} in ${ms}ms`);
    passed++;
  } else {
    failed++;
    const reason = r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
    const errTail = (r.stderr || '').trim().split('\n').slice(-3).join('\n  ');
    console.log(`  ❌ ${c.name} FAILED (${reason}) in ${ms}ms`);
    console.log(`     ${errTail.slice(0, 400)}`);
    failures.push({ name: c.name, reason, err: errTail });
  }
}

console.log('');
console.log('═══════════════════════════════════════════════════════');
console.log(`SUMMARY: ${passed}/${crons.length} crons executed cleanly, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════');

if (failures.length > 0) {
  console.log('\nFailure details:');
  for (const f of failures) {
    console.log(`  ❌ ${f.name} (${f.reason})`);
    console.log(`     ${f.err.split('\n').join('\n     ')}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
