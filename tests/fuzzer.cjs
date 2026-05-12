#!/usr/bin/env node
/**
 * Edge-Case Fuzzer
 * Throws ~50 malformed/random inputs at every Telegram handler.
 * Any unhandled throw is a real bug.
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'fuzz-token';
process.env.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '999';

const Module = require('module');
const origRequire = Module.prototype.require;
const sentReplies = [];
Module.prototype.require = function (name) {
  if (name === 'axios') {
    return {
      post: async (url, body) => { sentReplies.push(body); return { data: { ok: true } }; },
      get: async () => ({ data: { result: [] } }),
      create: () => ({}),
    };
  }
  return origRequire.apply(this, arguments);
};

const src = fs.readFileSync(path.join(ROOT, 'avatar/orchestrator/telegram_listener.js'), 'utf8');
const cleanSrc = src.replace(/\npoll\(\);[\s\S]*$/m, '\n') + `
module.exports = { handlePosted, handleStats, handleWeeklyStats, handleTravel, handlePick, handleStatus, handleHealthcheck, handleAuditRejects, handlePerf };
`;
const tmp = path.join(ROOT, 'avatar/orchestrator', '_tmp_fuzz.cjs');
fs.writeFileSync(tmp, cleanSrc);
const handlers = require(tmp);

function generateFuzzInputs(prefix) {
  const inputs = [
    prefix, prefix + ' ', prefix + '  ',
    prefix + '\n\n', prefix + '\t',
    prefix + ' '.repeat(500),
    prefix + ' \u00e9\u00f1 \ud83c\udf89',
    prefix + ' " \\ \' `` $$',
    prefix + ' <script>alert(1)</script>',
    prefix + " ' OR 1=1 --",
    prefix + ' ' + 'A'.repeat(3000),
    prefix + ' v=', prefix + ' v=abc', prefix + ' v=-1', prefix + ' v=NaN',
    prefix + ' v=0', prefix + ' v=null', prefix + ' v=undefined',
    prefix + ' xxxxxxxx', prefix + ' 00000000', prefix + ' ffffffff',
    prefix + ' DROP TABLE', prefix + ' ../../etc/passwd',
    prefix + ' v=109 w=abc',
    prefix + ' v=109 totalwatch=99m 99s',
    prefix + ' v=109 totalwatch=-5s',
    prefix + ' v=0 totalwatch=10m',
    prefix + ' totalwatch=6m',
    prefix + ' totalwatch=6m 49s v=109',
    prefix + ' xyz=abc',
    prefix + ' v=v=v=109',
    prefix + ' v==109',
    prefix + ' \ud83d\udd25\ud83d\udca9\ud83c\udf89',
    prefix + '_',
    prefix + ' _',
    prefix + ' v=10\nwatch=3',
    prefix + ' {"v":109}',
    prefix + ' [109,3.5]',
    prefix + ' v=-100 totalwatch=-1s',
    prefix + ' v=99999999999 totalwatch=999999h',
    prefix + " '; DELETE FROM reel_concepts; --",
    prefix + ' \x00\x01',
  ];
  return inputs;
}

const targets = [
  { name: 'handleStats', fn: handlers.handleStats, prefix: '/stats_abc123' },
  { name: 'handlePosted', fn: handlers.handlePosted, prefix: '/posted' },
  { name: 'handleTravel', fn: handlers.handleTravel, prefix: '/travel' },
  { name: 'handleWeeklyStats', fn: handlers.handleWeeklyStats, prefix: '/weekly_stats' },
];

console.log('═══════════════════════════════════════════════════════');
console.log('  EDGE-CASE FUZZER');
console.log('═══════════════════════════════════════════════════════\n');

let totalRuns = 0;
let crashes = 0;
const crashLog = [];

(async () => {
  for (const t of targets) {
    const inputs = generateFuzzInputs(t.prefix);
    let crashed = 0;
    for (const input of inputs) {
      totalRuns++;
      sentReplies.length = 0;
      try {
        await Promise.race([
          t.fn(123, input),
          new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 15000)),
        ]);
      } catch (err) {
        crashed++;
        crashes++;
        crashLog.push({ handler: t.name, input: input.slice(0, 80).replace(/\n/g, '\\n'), err: err.message?.slice(0, 120) });
      }
    }
    console.log(`  ${crashed === 0 ? '\u2713' : '\u274c'} ${t.name.padEnd(22)} ${inputs.length - crashed}/${inputs.length} survived`);
  }

  // Also test handlePick with random short prefixes
  let pickCrashes = 0;
  const pickInputs = ['', ' ', 'x', '00', '00000000', 'xxxxxxxx', '\n', 'a'.repeat(100)];
  for (const p of pickInputs) {
    totalRuns++;
    try {
      await Promise.race([
        handlers.handlePick(123, p),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 15000)),
      ]);
    } catch (err) {
      pickCrashes++; crashes++;
      crashLog.push({ handler: 'handlePick', input: p, err: err.message?.slice(0, 120) });
    }
  }
  console.log(`  ${pickCrashes === 0 ? '\u2713' : '\u274c'} handlePick              ${pickInputs.length - pickCrashes}/${pickInputs.length} survived`);

  try { fs.unlinkSync(tmp); } catch {}

  console.log('');
  if (crashLog.length > 0) {
    console.log('Crash log:');
    for (const c of crashLog.slice(0, 25)) {
      console.log(`  \u274c ${c.handler}('${c.input}'): ${c.err}`);
    }
  }
  console.log('');
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log(`SUMMARY: ${totalRuns - crashes}/${totalRuns} fuzz inputs handled gracefully, ${crashes} crashes`);
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  process.exit(crashes === 0 ? 0 : 1);
})();
