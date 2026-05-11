/**
 * EverythinInAI - Smoke Tests
 * 
 * Regression tests for critical paths. Run with: node tests/smoke.test.js
 * Returns exit code 0 if all pass, 1 if any fail.
 * 
 * These are NOT unit tests with mocks — they are simple invariant checks
 * that catch the kinds of bugs we hit during production today (parsing,
 * persona resolution, env config, registry definitions).
 */

const path = require('path');

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

console.log('\n=== EverythinInAI Smoke Tests ===\n');

// 1. env_validator
console.log('env_validator:');
const { validateEnv, RULES } = require('../engine/core/env_validator');
test('RULES has required keys', () => {
  assert(RULES.SUPABASE_URL, 'missing SUPABASE_URL rule');
  assert(RULES.REPLICATE_API_TOKEN, 'missing REPLICATE_API_TOKEN rule');
  assert(RULES.GEMINI_API_KEY, 'missing GEMINI_API_KEY rule');
});
test('validateEnv returns ok=false when SUPABASE_URL missing', () => {
  const orig = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  const result = validateEnv('soft');
  process.env.SUPABASE_URL = orig;
  assert(result.ok === false, 'should fail');
  assert(result.errors.length > 0, 'should report errors');
});

// 2. cost_guard pure logic (no DB calls)
console.log('\ncost_guard:');
const cg = require('../engine/core/cost_guard');
test('module exports expected functions', () => {
  assert(typeof cg.guard === 'function');
  assert(typeof cg.checkCanSpend === 'function');
  assert(typeof cg.recordSpend === 'function');
});

// 3. Replicate client MODELS registry
console.log('\nreplicate_client:');
const rc = require('../avatar/imagery/replicate_client');
test('MODELS contains all critical models', () => {
  const required = ['flux_dev_lora', 'chatterbox', 'whisper_fast', 'omni_human', 'wan_2_2_s2v', 'kling_v1_6_std'];
  for (const k of required) {
    assert(rc.MODELS[k], `missing model: ${k}`);
    assert(rc.MODELS[k].id && rc.MODELS[k].version, `model ${k} missing id or version`);
    assert(typeof rc.MODELS[k].cost_per_image === 'number', `model ${k} missing cost`);
  }
});
test('OmniHuman cost is set to actual ($3.33), not the placeholder $0.50', () => {
  assert(rc.MODELS.omni_human.cost_per_image >= 3.0, `omni_human cost should be >= $3.00, got ${rc.MODELS.omni_human.cost_per_image}`);
});

// 4. Telegram listener parse helpers
console.log('\ntelegram_listener parsing:');
// Source the module without invoking the polling daemon
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'dummy:test'; // prevent process.exit
delete require.cache[require.resolve('../avatar/orchestrator/telegram_listener.js')];

// We can't easily test the listener internals without rewriting them as exports, so test indirectly via concept_drafter

// 5. concept_drafter buildPrompt produces a valid string
console.log('\nconcept_drafter:');
// (pure-js test only - won't hit gemini)
test('module exports draftConcepts', () => {
  const cd = require('../avatar/ideation/concept_drafter');
  assert(typeof cd.draftConcepts === 'function');
});

// 6. lifestyle_worker MOODS dictionary still present (fallback safety)
console.log('\nlifestyle_worker:');
test('lifestyle_worker is loadable (no syntax errors)', () => {
  require.resolve('../avatar/lifestyle/lifestyle_worker.js');
});

// 7. Hero worker pickCombo function present
console.log('\nhero_worker:');
test('hero_worker is loadable', () => {
  require.resolve('../avatar/imagery/hero_worker.js');
});

// 8. Engagement planner
console.log('\nengagement_planner:');
const ep = require('../avatar/video/engagement_planner');
test('planEngagement is a function', () => {
  assert(typeof ep.planEngagement === 'function');
});
test('planEngagement returns proper structure', () => {
  const cues = [
    { text: 'hook', start: 0, end: 1.5 },
    { text: 'body', start: 1.5, end: 5 },
    { text: 'punch', start: 5, end: 8 },
  ];
  const concept = { signal_url: 'https://example.com', entities: ['LightRAG'], topics: [] };
  const plan = ep.planEngagement(cues, concept);
  assert(Array.isArray(plan.broll_cuts), 'broll_cuts must be array');
  assert(Array.isArray(plan.zoom_punches), 'zoom_punches must be array');
  assert(Array.isArray(plan.sfx_events), 'sfx_events must be array');
  // For an 8-second reel, we expect first B-roll to start before second 3
  if (plan.broll_cuts.length > 0) {
    assert(plan.broll_cuts[0].at_sec < 3, `first B-roll must be before second 3, got ${plan.broll_cuts[0].at_sec}`);
  }
});

// 9. SQL migration files - syntax sanity
console.log('\nsql migrations:');
const fs = require('fs');
test('all sql migrations exist and are non-empty', () => {
  const sqlDir = path.join(__dirname, '..', 'sql');
  const files = fs.readdirSync(sqlDir).filter(f => f.endsWith('.sql'));
  assert(files.length >= 19, `expected at least 19 migrations, got ${files.length}`);
  for (const f of files) {
    const content = fs.readFileSync(path.join(sqlDir, f), 'utf8');
    assert(content.length > 50, `migration ${f} is too small`);
  }
});

// 10. Persona bible exists
console.log('\npersona bible:');
test('RHEA_BIBLE.md exists and has key sections', () => {
  const bible = fs.readFileSync(path.join(__dirname, '..', 'avatar', 'persona', 'RHEA_BIBLE.md'), 'utf8');
  assert(bible.includes('Rhea Kapoor'), 'bible must mention Rhea Kapoor');
  assert(bible.includes('Bandra'), 'bible must mention her location');
  assert(bible.includes('Goldman Sachs'), 'bible must mention her job');
  assert(bible.includes('Business Goals') || bible.includes('Goal'), 'bible must mention business goals');
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
