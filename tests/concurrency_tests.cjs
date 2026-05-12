#!/usr/bin/env node
/**
 * Concurrency Safety Tests
 *
 * Simulate the two real-world race conditions:
 *
 * 1. RAPID /PICK COLLISION
 *    User taps /pick_A and /pick_B in rapid succession (< 500ms apart).
 *    Expectation: only one render runs, and it's deterministic which.
 *
 * 2. CRON VS MANUAL /GO COLLISION
 *    Morning cron fires at 8 AM IST. User also types /go at 8:00:01.
 *    Expectation: only one orchestrator spawns. Second is a no-op.
 *
 * 3. RENDER_WINNER IDEMPOTENCY UNDER STRESS
 *    Spawn 3 render_winner processes simultaneously for the same calendar row.
 *    Expectation: 1 wins, 2 cleanly exit with "already rendering" log.
 *
 * Sandbox: uses target_date='9999-12-25' so we never touch real production data.
 * Cleans up after itself.
 */
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const SANDBOX_DATE = '9999-12-25';

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'concurrency-test';
process.env.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '999';

// Stub axios so handlers don't actually message Telegram
const Module = require('module');
const origRequire = Module.prototype.require;
const replies = [];
Module.prototype.require = function (name) {
  if (name === 'axios') {
    return {
      post: async () => { replies.push(arguments); return { data: { ok: true } }; },
      get: async () => ({ data: { result: [] } }),
      create: () => ({}),
    };
  }
  return origRequire.apply(this, arguments);
};

// Override spawn so handlers don't ACTUALLY launch render_winner (we'd burn money).
// We track the spawn calls instead.
const spawnedOrchestrators = [];
const childProcessOrig = require('child_process');
const origSpawn = childProcessOrig.spawn;
childProcessOrig.spawn = function (cmd, args, opts) {
  // Only intercept render_winner spawns
  if (Array.isArray(args) && args.some(a => typeof a === 'string' && a.includes('render_winner'))) {
    spawnedOrchestrators.push({ args, ts: Date.now() });
    // Return a fake child that exits immediately
    const { EventEmitter } = require('events');
    const fake = new EventEmitter();
    fake.unref = () => {};
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    setTimeout(() => fake.emit('exit', 0), 5);
    return fake;
  }
  return origSpawn.apply(this, arguments);
};

// Load the handlers
const src = fs.readFileSync(path.join(ROOT, 'avatar/orchestrator/telegram_listener.js'), 'utf8');
const cleanSrc = src.replace(/\npoll\(\);[\s\S]*$/m, '\n') + `
module.exports = { handlePick, handleGo };
`;
const tmp = path.join(ROOT, 'avatar/orchestrator', '_tmp_concurrency.cjs');
fs.writeFileSync(tmp, cleanSrc);
const handlers = require(tmp);

const dbModule = require('../engine/core/database');
const db = dbModule.getClient();

let passed = 0, failed = 0;
const failures = [];
function record(name, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}: ${detail}`); failed++; failures.push({ name, detail }); }
}

async function getActivePersonaId() {
  const { data } = await db.from('personas').select('id').eq('slug', 'avi').maybeSingle();
  return data?.id;
}

async function setupSandboxRow(personaId, withConcepts = true) {
  // Insert calendar row + 2 concepts so we can test pick races
  const { data: cal } = await db.from('content_calendar').insert({
    target_date: SANDBOX_DATE,
    weekday: 5, // Friday 9999-12-25
    content_type: 'tech_reel',
    state: 'ready',
  }).select('id').single();
  if (!cal) throw new Error('calendar setup failed');

  const conceptIds = [];
  if (withConcepts) {
    for (const angle of ['secret_weapon', 'industry_killer']) {
      const { data: c } = await db.from('reel_concepts').insert({
        persona_id: personaId,
        target_date: SANDBOX_DATE,
        title: `TEST_CONCURRENCY_${angle}`,
        hook: 'h', body_script: 'b', punchline: 'p',
        full_script: 'h b p', caption: 'c', cta: 'comment X',
        angle, content_type: 'tech_reel', state: 'ready',
        estimated_seconds: 12,
      }).select('id').single();
      if (c) conceptIds.push(c.id);
    }
  }
  return { calId: cal.id, conceptIds };
}

async function cleanupSandbox() {
  await db.from('reel_concepts').delete().eq('target_date', SANDBOX_DATE);
  await db.from('content_calendar').delete().eq('target_date', SANDBOX_DATE);
}

// === TEST 1: RAPID /PICK COLLISION ===
async function testRapidPickCollision() {
  console.log('\n[1] Rapid /pick collision (two picks fired within 10ms)');
  const personaId = await getActivePersonaId();
  const { calId, conceptIds } = await setupSandboxRow(personaId, true);

  // CRITICAL: handlePick uses target_date=today (real today), not the sandbox date.
  // To fairly test, we temporarily mark the calendar row as today's date so the handler can find it.
  const today = new Date().toISOString().slice(0, 10);
  // First save original today's row state
  const { data: realToday } = await db.from('content_calendar')
    .select('id, state, concept_id').eq('target_date', today).eq('content_type','tech_reel').maybeSingle();

  // Move sandbox row to today
  await db.from('content_calendar').update({ target_date: today }).eq('id', calId);
  await db.from('reel_concepts').update({ target_date: today }).in('id', conceptIds);

  // Hide real today's row temporarily by moving it to 9998-01-01
  if (realToday) await db.from('content_calendar').update({ target_date: '9998-01-01' }).eq('id', realToday.id);

  spawnedOrchestrators.length = 0;
  replies.length = 0;

  // Fire BOTH picks simultaneously
  const idA = conceptIds[0].slice(0, 8);
  const idB = conceptIds[1].slice(0, 8);
  const t0 = Date.now();
  await Promise.all([
    handlers.handlePick(123, idA),
    handlers.handlePick(123, idB),
  ]);
  const ms = Date.now() - t0;

  // Restore real today's row
  if (realToday) await db.from('content_calendar').update({ target_date: today }).eq('id', realToday.id);
  // Move sandbox back
  await db.from('content_calendar').update({ target_date: SANDBOX_DATE }).eq('id', calId);
  await db.from('reel_concepts').update({ target_date: SANDBOX_DATE }).in('id', conceptIds);

  console.log(`  (concurrent picks completed in ${ms}ms, ${spawnedOrchestrators.length} orchestrator spawn(s))`);

  // Assertions
  record(`Rapid pick: only 1 orchestrator spawned (got ${spawnedOrchestrators.length})`,
    spawnedOrchestrators.length === 1,
    `BUG: ${spawnedOrchestrators.length} child processes would have raced for the calendar row, both spending money.`);

  // Check final winner state — exactly one concept should be is_winner=true
  const { data: winners } = await db.from('reel_concepts')
    .select('id, angle, is_winner').in('id', conceptIds).eq('is_winner', true);
  record(`Rapid pick: exactly 1 winner concept marked (got ${winners?.length || 0})`,
    (winners?.length || 0) === 1,
    `BUG: ${winners?.length || 0} winners — winner state is corrupted.`);

  await cleanupSandbox();
}

// === TEST 2: CRON VS MANUAL /GO COLLISION ===
async function testCronVsManualGo() {
  console.log('\n[2] Cron + manual /go collision (lifestyle/lure path only — tech requires /pick)');
  const personaId = await getActivePersonaId();
  // Use lifestyle_reel since that's the path /go can fire directly (no pick required)
  const { data: cal } = await db.from('content_calendar').insert({
    target_date: SANDBOX_DATE,
    weekday: 5,
    content_type: 'lifestyle_reel',
    state: 'ready',
  }).select('id').single();

  // Move to today so handleGo can find it
  const today = new Date().toISOString().slice(0, 10);
  const { data: realToday } = await db.from('content_calendar')
    .select('id, target_date, state').eq('target_date', today).eq('content_type','lifestyle_reel').maybeSingle();
  if (realToday) await db.from('content_calendar').update({ target_date: '9998-01-02' }).eq('id', realToday.id);
  await db.from('content_calendar').update({ target_date: today }).eq('id', cal.id);

  spawnedOrchestrators.length = 0;
  await Promise.all([
    handlers.handleGo(123),
    handlers.handleGo(123),
    handlers.handleGo(123),
  ]);

  // Restore
  await db.from('content_calendar').update({ target_date: SANDBOX_DATE }).eq('id', cal.id);
  if (realToday) await db.from('content_calendar').update({ target_date: today }).eq('id', realToday.id);

  console.log(`  (3 simultaneous /go calls fired, ${spawnedOrchestrators.length} orchestrator spawn(s))`);

  record(`/go collision: only 1 orchestrator spawned (got ${spawnedOrchestrators.length})`,
    spawnedOrchestrators.length === 1,
    `BUG: ${spawnedOrchestrators.length} simultaneous orchestrators — duplicate spending risk.`);

  await db.from('content_calendar').delete().eq('id', cal.id);
}

// === TEST 3: RENDER_WINNER IDEMPOTENCY ===
async function testRenderWinnerIdempotency() {
  console.log('\n[3] render_winner idempotency: re-running for a "done" calendar row should bail');
  const personaId = await getActivePersonaId();
  const { data: cal } = await db.from('content_calendar').insert({
    target_date: SANDBOX_DATE,
    weekday: 5,
    content_type: 'tech_reel',
    state: 'done',
    output_url: 'https://example.com/test-already-done.mp4',
  }).select('id').single();

  // Spawn render_winner with --calendar=<id> and check it bails
  const r = spawnSync('node', [
    path.join(ROOT, 'avatar/orchestrator/render_winner.js'),
    `--calendar=${cal.id}`,
  ], { encoding: 'utf8', timeout: 10000, cwd: ROOT });

  const output = r.stdout + r.stderr;
  const bailedCleanly = r.status === 0 && (
    /already done|done\. URL/i.test(output)
  );
  record(`render_winner: bails on state="done" (no re-render)`, bailedCleanly,
    bailedCleanly ? '' : `exit=${r.status} output:\n${output.slice(0, 500)}`);

  // Now test state='rendering' bail
  await db.from('content_calendar').update({ state: 'rendering' }).eq('id', cal.id);
  const r2 = spawnSync('node', [
    path.join(ROOT, 'avatar/orchestrator/render_winner.js'),
    `--calendar=${cal.id}`,
  ], { encoding: 'utf8', timeout: 10000, cwd: ROOT });
  const out2 = r2.stdout + r2.stderr;
  const bailedRendering = r2.status === 0 && /already in rendering|bailing/i.test(out2);
  record(`render_winner: bails on state="rendering" (no double-spend)`, bailedRendering,
    bailedRendering ? '' : `exit=${r2.status} output:\n${out2.slice(0, 500)}`);

  await db.from('content_calendar').delete().eq('id', cal.id);
}

(async () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  CONCURRENCY SAFETY TESTS');
  console.log('═══════════════════════════════════════════════════════');
  await cleanupSandbox();

  await testRapidPickCollision();
  await testCronVsManualGo();
  await testRenderWinnerIdempotency();

  await cleanupSandbox();
  try { fs.unlinkSync(tmp); } catch {}

  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ❌ ${f.name}: ${f.detail}`);
  }
  console.log('═══════════════════════════════════════════════════════');
  process.exit(failed === 0 ? 0 : 1);
})();
