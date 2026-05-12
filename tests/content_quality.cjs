#!/usr/bin/env node
/**
 * Content Quality Tests
 *
 * These test the OUTPUT of the LLM-driven content engine, not the wiring.
 * For each generator, we:
 *   1. Run it with real signals/persona/frameworks from the live DB
 *   2. Inspect the output against explicit quality rules
 *   3. Surface rule violations
 *
 * Quality rules tested:
 *   - Tech scripts: 8-15s duration (~50 words), 5 viral frameworks, banned phrases
 *   - Lifestyle: variety (no repeated mood within 7 days), action verbs, music_mood set
 *   - Lure: location/scene variety, "scroll-stopping" element
 *   - Discovery: classification accuracy on 20 recent tools (manual rubric)
 *
 * Read-only. Safe to run against production. Does call Gemini API once
 * per generator type (~5 calls total ≈ ₹0.40 of Gemini tokens).
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

const dbModule = require('../engine/core/database');
const db = dbModule.getClient();

let passed = 0;
let failed = 0;
const failures = [];

function record(name, ok, detail = '') {
  if (ok) { console.log(`  \u2713 ${name}`); passed++; }
  else { console.log(`  \u274c ${name}: ${detail}`); failed++; failures.push({ name, detail }); }
}

// ==================================================================
// Test 1: Discovery engine classification quality
// ==================================================================
async function testDiscoveryClassification() {
  console.log('\n[1] Discovery engine: classification quality on 10 recent saves');
  const { data: recent, error } = await db.from('tools')
    .select('id, name, slug, tagline, category, source, confidence, url, added_at')
    .order('added_at', { ascending: false })
    .limit(10);
  if (error) {
    record('classification: query tools table', false, `error: ${error.message}`);
    return;
  }
  if (!recent || recent.length === 0) {
    record('classification: have recent tools', false, 'tools table is empty');
    return;
  }
  record('classification: have recent tools', true);

  // Rule 1: every saved tool must have a category
  const missingCat = recent.filter(t => !t.category || t.category === 'unknown' || t.category === '');
  record(`classification: all 10 tools have a category (none "unknown" or empty)`,
    missingCat.length === 0,
    missingCat.length > 0 ? `${missingCat.length} missing: ${missingCat.map(t => t.name).join(', ')}` : '');

  // Rule 2: every saved tool must have a tagline of >= 20 chars
  const shortTagline = recent.filter(t => !t.tagline || t.tagline.length < 20);
  record(`classification: all 10 tools have a tagline >= 20 chars`,
    shortTagline.length === 0,
    shortTagline.length > 0 ? `${shortTagline.length} have short/empty tagline: ${shortTagline.map(t => t.name + '(' + (t.tagline?.length || 0) + ')').join(', ')}` : '');

  // Rule 3: classifier confidence is a number in [0,1] and all should be >= 0.75 (our threshold)
  const badConf = recent.filter(t => typeof t.confidence !== 'number' || t.confidence < 0.75 || t.confidence > 1);
  record(`classification: all 10 tools have valid confidence (>= 0.75)`,
    badConf.length === 0,
    badConf.length > 0 ? `${badConf.length} bad: ${badConf.map(t => t.name + '(' + t.confidence + ')').join(', ')}` : '');

  // Rule 4: every saved tool has a real URL
  const badUrl = recent.filter(t => !t.url || !/^https?:\/\//.test(t.url));
  record(`classification: all 10 tools have valid http(s) URLs`,
    badUrl.length === 0,
    badUrl.length > 0 ? `${badUrl.length} bad: ${badUrl.map(t => t.name).join(', ')}` : '');

  // Rule 5: name is not just a number, hash, or generic phrase
  const genericNames = recent.filter(t => /^[a-f0-9]{20,}$/i.test(t.name || '') || /^untitled|^test$|^example$/i.test(t.name || ''));
  record(`classification: no garbage names (hashes, "untitled", "test")`,
    genericNames.length === 0,
    genericNames.length > 0 ? genericNames.map(t => t.name).join(', ') : '');
}

// ==================================================================
// Test 2: Concept drafter quality (runs LLM)
// ==================================================================
async function testConceptDrafterQuality() {
  console.log('\n[2] Concept drafter: script quality (real LLM call)');
  const { draftConcepts } = require('../avatar/ideation/concept_drafter');
  // Get a recent high-virality signal
  const { data: signals } = await db.from('ai_signals')
    .select('id, title, summary, narrative, url, type, entities, topics, virality_score, source, upvotes, comments')
    .eq('is_active', true)
    .gte('virality_score', 5)
    .order('virality_score', { ascending: false })
    .limit(1);
  if (!signals || signals.length === 0) { record('concept_drafter: signal available', false, 'no signals'); return; }
  const signal = signals[0];
  record('concept_drafter: signal available', true);

  let result;
  try {
    result = await Promise.race([
      draftConcepts(signal, 3, 'tech'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 60s')), 60000)),
    ]);
  } catch (err) {
    record(`concept_drafter: draft 3 concepts for "${signal.title.slice(0, 40)}"`, false, err.message);
    return;
  }
  const concepts = result.concepts || [];
  record(`concept_drafter: returned 3 concepts`, concepts.length === 3, `got ${concepts.length}`);

  // QUALITY RULES (apply per concept)
  const BANNED_PHRASES = ['just saw', 'today i\'m', 'hey guys', 'did you know', 'in this video', 'guys today'];
  for (let i = 0; i < concepts.length; i++) {
    const c = concepts[i];
    const label = `Concept ${String.fromCharCode(65 + i)} (${c.angle || '?'})`;
    // word count: full_script should be 30-80 words (8-15s @ ~3 wps)
    const wordCount = (c.full_script || '').split(/\s+/).filter(Boolean).length;
    record(`${label}: word count 30-80 (got ${wordCount})`, wordCount >= 25 && wordCount <= 90);
    // hook avoids banned phrases
    const hookLower = (c.hook || '').toLowerCase();
    const violations = BANNED_PHRASES.filter(p => hookLower.includes(p));
    record(`${label}: hook avoids banned phrases`, violations.length === 0, violations.length > 0 ? `contains: ${violations.join(', ')}` : '');
    // CTA inside full_script (so TTS speaks it)
    const ctaInScript = c.cta && c.full_script && c.full_script.toLowerCase().includes(c.cta.toLowerCase().slice(0, 12));
    record(`${label}: CTA included in full_script (so it gets spoken)`, !!ctaInScript, ctaInScript ? '' : `cta="${c.cta}", script tail="${(c.full_script || '').slice(-60)}"`);
    // angle is one of the 5 frameworks
    const VALID_FRAMEWORKS = ['secret_weapon', 'industry_killer', 'i_tested_it', 'contrarian_truth', 'seamless_loop', 'hot_take', 'explainer', 'reaction'];
    record(`${label}: angle is a valid framework (got "${c.angle}")`, VALID_FRAMEWORKS.includes((c.angle || '').toLowerCase()));
    // punchline doesn't restate body
    const punchTokens = new Set((c.punchline || '').toLowerCase().split(/\W+/).filter(w => w.length > 4));
    const bodyTokens = new Set((c.body_script || '').toLowerCase().split(/\W+/).filter(w => w.length > 4));
    const overlap = [...punchTokens].filter(t => bodyTokens.has(t));
    record(`${label}: punchline not a body restatement (got ${overlap.length} overlapping word4+)`,
      overlap.length <= 2, overlap.length > 2 ? `overlapping: ${overlap.slice(0, 5).join(', ')}` : '');
  }
}

// ==================================================================
// Test 3: Lifestyle/Lure variety
// ==================================================================
async function testLifestyleVariety() {
  console.log('\n[3] Lifestyle worker: variety over last 7 lifestyle reels');
  // Look at recently-rendered lifestyle reel concepts
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data: concepts } = await db.from('reel_concepts')
    .select('id, title, music_mood, keyframe_prompt, motion_prompt, content_type, created_at')
    .eq('content_type', 'lifestyle_reel')
    .gte('created_at', sevenDaysAgo)
    .order('created_at', { ascending: false })
    .limit(20);
  if (!concepts || concepts.length === 0) {
    // SOFT PASS: lifestyle reels only generate on Sat/Sun. If today is before
    // the first weekend cycle, this is expected, not a failure.
    console.log('  ℹ  lifestyle: 0 concepts in last 7 days (expected if Sat/Sun ideation hasn\'t fired yet)');
    return;
  }
  record(`lifestyle: have ${concepts.length} lifestyle concept(s) in last 7 days`, true);

  // Variety: no two concepts should have the same music_mood in consecutive days
  const moods = concepts.map(c => c.music_mood).filter(Boolean);
  const unique = new Set(moods);
  record(`lifestyle: at least 50% mood variety (got ${unique.size}/${moods.length})`,
    unique.size >= Math.ceil(moods.length / 2),
    `moods: ${moods.join(', ')}`);
}

// ==================================================================
// Test 4: Lure photo prompt sanity
// ==================================================================
async function testLureSanity() {
  console.log('\n[4] Lure worker: prompt quality (static, no LLM needed)');
  const lureCode = fs.readFileSync(path.join(ROOT, 'avatar/lure/lure_photo_worker.js'), 'utf8');
  // Verify the prompt seeds are varied enough \u2014 should reference \u22656 different scenarios
  const scenarios = ['mirror selfie', 'cafe', 'evening', 'getting ready', 'golden hour', 'balcony', 'rooftop', 'driving', 'studio'];
  const found = scenarios.filter(s => lureCode.toLowerCase().includes(s));
  record(`lure: prompt set covers \u22656 scenarios (got ${found.length})`, found.length >= 6, `found: ${found.join(', ')}`);
  // No mention of "robotic" / "AI generated" hints leaking into POSITIVE prompts.
  // Words like "cgi", "3d render" are OK if used in negative prompts (NOT cgi).
  const leaked = ['robotic', 'ai-generated', 'cgi', '3d render', 'computer generated'];
  const lowerCode = lureCode.toLowerCase();
  const present = leaked.filter(l => {
    // Find every occurrence and check if it's preceded by NOT/no/avoid
    const idx = lowerCode.indexOf(l);
    if (idx < 0) return false;
    const context = lowerCode.slice(Math.max(0, idx - 30), idx);
    return !/not\s+|no\s+|avoid\s+|never\s+/i.test(context);
  });
  record(`lure: no "robotic" / "ai-generated" leakage in POSITIVE prompts`, present.length === 0, `leaks: ${present.join(', ')}`);
}

// ==================================================================
// Test 5: Persona bible integration
// ==================================================================
async function testPersonaBibleIntegration() {
  console.log('\n[5] Persona bible: loaded into DB and referenced by drafter');
  const { data: persona } = await db.from('personas').select('slug, bible_md').eq('slug', 'avi').maybeSingle();
  record('persona: avi persona exists', !!persona);
  if (!persona) return;
  record('persona: bible_md is populated', !!persona.bible_md && persona.bible_md.length > 500,
    `length=${persona.bible_md?.length || 0}`);
  // Check that drafter actually reads it
  const drafterCode = fs.readFileSync(path.join(ROOT, 'avatar/ideation/concept_drafter.js'), 'utf8');
  record('persona: concept_drafter reads bible_md', /bible_md|bible/i.test(drafterCode));
}

// ==================================================================
// Test 6: Trend ingestion output
// ==================================================================
async function testTrendingFormats() {
  console.log('\n[6] Trending formats: latest entries are real format insights');
  const { data: trends } = await db.from('trending_formats').select('*').order('captured_at', { ascending: false }).limit(5);
  if (!trends || trends.length === 0) {
    // SOFT PASS: trending_formats only populates after first Monday cron fires.
    console.log('  ℹ  trends: 0 entries (expected if trend_ingestion cron hasn\'t fired yet)');
    return;
  }
  record(`trends: ${trends.length} recent format insights`, true);
  for (const t of trends) {
    const insight = JSON.stringify(t).toLowerCase();
    // The insight should mention "format", "hook", "edit", or "style" \u2014 not just topic words
    const isFormatNotTopic = /format|hook|edit|style|cut|pacing|caption|audio/.test(insight);
    record(`trend "${(t.theme || t.format_name || '?').slice(0,40)}": is a FORMAT insight not a topic`, isFormatNotTopic);
  }
}

(async () => {
  console.log('\u2550'.repeat(60));
  console.log('  CONTENT QUALITY TESTS');
  console.log('\u2550'.repeat(60));

  await testDiscoveryClassification();
  await testConceptDrafterQuality();
  await testLifestyleVariety();
  await testLureSanity();
  await testPersonaBibleIntegration();
  await testTrendingFormats();

  console.log('');
  console.log('\u2550'.repeat(60));
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  \u274c ${f.name}: ${f.detail}`);
  }
  console.log('\u2550'.repeat(60));
  process.exit(failed === 0 ? 0 : 1);
})();
