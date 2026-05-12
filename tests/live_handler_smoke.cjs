#!/usr/bin/env node
/**
 * Live Handler Smoke Test
 *
 * Actually invokes the read-only Telegram command handlers against the real
 * Supabase project. Catches runtime bugs that static analysis can't see
 * (e.g. handler tries to access a property of null).
 *
 * Only invokes READ-ONLY handlers — never anything that writes/inserts.
 * Safe to run against production.
 *
 * Run: node tests/live_handler_smoke.cjs
 */

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// Stub Telegram env so listener loads
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '999';

// Stub axios.post so handlers can "send replies" to a recorder
const Module = require('module');
const origRequire = Module.prototype.require;
const replies = [];
Module.prototype.require = function(name) {
  if (name === 'axios') {
    return {
      post: async (url, body) => { replies.push({ url, body }); return { data: { ok: true } }; },
      get: async () => ({ data: { result: [] } }),
      create: () => ({}),
      default: { post: async () => ({}), get: async () => ({}) },
    };
  }
  return origRequire.apply(this, arguments);
};

// Now read the listener source and inline-eval to extract the handler functions.
// The listener has `main().catch(...)` at the bottom that starts polling. We do
// NOT want that to run. We accomplish this by reading the source, removing the
// poll() invocation, and eval-ing what remains.

const fs = require('fs');
const src = fs.readFileSync(path.join(ROOT, 'avatar/orchestrator/telegram_listener.js'), 'utf8');

// Strip the poll() invocation at the bottom — keep only function definitions
const cleanSrc = src.replace(/\npoll\(\);[\s\S]*$/m, '\n');

// Inject a return at the very end so our handlers are exported
const finalSrc = cleanSrc + `
module.exports = { handleStatus, handleHealthcheck, handleAuditRejects, handlePerf, handleTravel };
`;

// Write to a temp file in the SAME directory as the original (so relative
// require paths like '../../engine/core/database' still resolve correctly)
const tmpPath = path.join(ROOT, 'avatar/orchestrator', '_tmp_listener_test.cjs');
fs.writeFileSync(tmpPath, finalSrc);

let handlers;
try {
  handlers = require(tmpPath);
} catch (err) {
  console.log('❌ Failed to load listener:', err.message);
  fs.unlinkSync(tmpPath);
  process.exit(1);
}

const tests = [
  { name: 'handleStatus', invoke: () => handlers.handleStatus(123) },
  { name: 'handleHealthcheck', invoke: () => handlers.handleHealthcheck(123) },
  { name: 'handleAuditRejects', invoke: () => handlers.handleAuditRejects(123) },
  { name: 'handlePerf', invoke: () => handlers.handlePerf(123) },
  { name: 'handleTravel(list)', invoke: () => handlers.handleTravel(123, '/travel list') },
  { name: 'handleTravel(home)', invoke: () => handlers.handleTravel(123, '/travel home') },
];

console.log('═══════════════════════════════════════════════════════');
console.log('  LIVE HANDLER SMOKE TEST');
console.log('═══════════════════════════════════════════════════════\n');

(async () => {
  let failures = 0;
  for (const t of tests) {
    replies.length = 0;
    try {
      const start = Date.now();
      await Promise.race([
        t.invoke(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT after 15s')), 15000)),
      ]);
      const ms = Date.now() - start;
      const lastReply = replies[replies.length - 1];
      const preview = lastReply?.body?.text?.slice(0, 80).replace(/\n/g, ' ') || '(no reply)';
      console.log(`  ✓ ${t.name.padEnd(28)} ${ms}ms — ${preview}…`);
    } catch (err) {
      console.log(`  ❌ ${t.name.padEnd(28)} CRASHED: ${err.message?.slice(0, 100)}`);
      failures++;
    }
  }

  // Clean up temp file
  try { fs.unlinkSync(tmpPath); } catch {}

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`SUMMARY: ${tests.length - failures}/${tests.length} handlers ran cleanly against live DB`);
  console.log('═══════════════════════════════════════════════════════');
  process.exit(failures === 0 ? 0 : 1);
})();
