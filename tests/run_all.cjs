#!/usr/bin/env node
/**
 * Master Test Runner
 *
 * Runs all four hostile audits in sequence and reports a combined result.
 * Safe to run against production — read-only.
 *
 * Usage:  node tests/run_all.cjs
 * Exit:   0 = all clean, 1 = any failure
 */

const { spawnSync } = require('child_process');
const path = require('path');

const TESTS = [
  { name: 'Schema Audit (column mismatches)', file: 'schema_audit.cjs' },
  { name: 'Cron Script Smoke Test', file: 'cron_smoke.cjs' },
  { name: 'Telegram Command Coverage', file: 'telegram_commands.cjs' },
  { name: 'Live Handler Smoke Test', file: 'live_handler_smoke.cjs' },
  { name: 'Unit Smoke Tests', file: 'smoke.test.cjs' },
];

console.log('═══════════════════════════════════════════════════════');
console.log('  MASTER TEST RUNNER');
console.log('═══════════════════════════════════════════════════════');

let failures = 0;
const results = [];

for (const t of TESTS) {
  console.log(`\n▶ ${t.name}`);
  console.log('─'.repeat(60));
  const r = spawnSync('node', [path.join(__dirname, t.file)], {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..'),
    timeout: 300_000,
  });
  if (r.status === 0) {
    results.push({ name: t.name, ok: true });
  } else {
    failures++;
    results.push({ name: t.name, ok: false, code: r.status });
  }
}

console.log('');
console.log('═══════════════════════════════════════════════════════');
console.log('  FINAL REPORT');
console.log('═══════════════════════════════════════════════════════');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '❌'} ${r.name}`);
}
console.log('');
console.log(`  ${TESTS.length - failures}/${TESTS.length} test suites passed.`);
console.log('═══════════════════════════════════════════════════════');

process.exit(failures === 0 ? 0 : 1);
