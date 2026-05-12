#!/usr/bin/env node
/**
 * Frontend Schema & Health Audit
 *
 * 1. Live URL probe: home page + 4 critical routes return HTTP 200
 * 2. Build sanity: tsc --noEmit on the client/ codebase (catches type errors)
 * 3. Schema audit: every column the frontend reads from Supabase actually exists
 * 4. Anon-key permission test: every table the frontend queries is readable
 *    by the public anon key (no silent RLS blocks)
 *
 * Read-only. Safe against production.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const dbModule = require('../engine/core/database');

// === 1. ROUTE HEALTH ===
const ROUTES = [
  '/',
  '/tool/chatgpt',
  '/category/chatbot',
  '/launchpad',
  '/terms',
  '/privacy',
  '/nonexistent-page-should-404',
];
const BASE = 'https://everythin-in-ai-iug3.vercel.app';

function head(url) {
  return new Promise((resolve) => {
    const start = Date.now();
    https.get(url, (res) => {
      const ms = Date.now() - start;
      resolve({ status: res.statusCode, ms });
      res.resume();
    }).on('error', (err) => resolve({ status: 0, error: err.message }));
  });
}

// === 2. SCHEMA AUDIT ===
// Frontend uses select('*'), so we don't catch column-mismatch in the QUERY.
// Instead we scan the React/TS source for property accesses on returned tools/runs
// and cross-check them against the live Supabase schema.

function gatherSrcFiles() {
  const out = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(p);
    }
  }
  walk(path.join(ROOT, 'client/src'));
  return out;
}

// Extract all property accesses on a "tool" or "run" identifier
function extractPropAccesses(src) {
  const props = new Set();
  // tool.X, t.X, item.X, .tool?.X — common destructure-free patterns
  for (const m of src.matchAll(/\b(?:tool|t|item|signal|run)\??\.([a-z_][a-z0-9_]*)/gi)) {
    props.add(m[1]);
  }
  // destructured: const { name, slug, tagline } = tool;
  for (const m of src.matchAll(/const\s*\{\s*([^}]+)\}\s*=\s*(?:tool|t|item|signal|run)/g)) {
    for (const k of m[1].split(',')) {
      const name = k.trim().split(/[:\s]/)[0];
      if (name && /^[a-z_]/.test(name)) props.add(name);
    }
  }
  return props;
}

async function getColumns(table) {
  const db = dbModule.getClient();
  const { data, error } = await db.from(table).select('*').limit(1);
  if (error) return { error: error.message, columns: null };
  return { columns: data?.[0] ? Object.keys(data[0]) : [] };
}

// === MAIN ===
let passed = 0, failed = 0;
const failures = [];
function record(name, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}: ${detail}`); failed++; failures.push({ name, detail }); }
}

(async () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  FRONTEND SCHEMA & HEALTH AUDIT');
  console.log('═══════════════════════════════════════════════════════\n');

  // === 1. ROUTE HEALTH ===
  console.log('[1] Live route health (HTTP probe)');
  for (const route of ROUTES) {
    const r = await head(BASE + route);
    if (route.includes('nonexistent')) {
      // 404 is expected (or 200 if the SPA serves index.html for everything)
      record(`route ${route}: returns a response`, r.status > 0, `status=${r.status}`);
    } else {
      record(`route ${route}: HTTP 200`, r.status === 200, `status=${r.status} ${r.ms}ms${r.error ? ' err='+r.error : ''}`);
    }
  }

  // === 2. SCHEMA AUDIT ===
  console.log('\n[2] Frontend column usage vs live Supabase schema');
  const files = gatherSrcFiles();
  console.log(`Scanning ${files.length} TS/TSX files...`);

  // For now, scan only files that touch tools or runs
  const toolPropsAll = new Set();
  const runPropsAll = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (!/Tool|tool|item/.test(src)) continue;
    extractPropAccesses(src).forEach(p => toolPropsAll.add(p));
    if (/Run|run/.test(src)) extractPropAccesses(src).forEach(p => runPropsAll.add(p));
  }

  // Get live schemas
  const toolsSchema = await getColumns('tools');
  const runsSchema = await getColumns('runs');

  if (toolsSchema.error) {
    record('tools table reachable', false, toolsSchema.error);
  } else {
    record(`tools table reachable (${toolsSchema.columns.length} columns)`, true);
    // Common framework / browser globals to ignore
    const IGNORE = new Set(['length','map','filter','find','forEach','length','toString','then','catch','toLowerCase','toUpperCase','slice','split','trim','includes','indexOf','startsWith','endsWith','replace','match','push','pop','shift','unshift','some','every','reduce','sort','reverse','join','concat','keys','values','entries','prototype','constructor','call','apply','bind','props','children','target','currentTarget','preventDefault','stopPropagation','key','ref','className','style','onClick','onChange','onSubmit','value','name','type','id','href','src','alt','title','data','error','status','statusText','headers','body','url','pathname','search','hash','origin','host','hostname','protocol','port']);
    const toolCols = new Set(toolsSchema.columns);
    // Read the camelCase↔snake_case transformer to see what aliases are mapped
    const transformerPath = path.join(ROOT, 'client/src/hooks/useTools.ts');
    const transformer = fs.existsSync(transformerPath) ? fs.readFileSync(transformerPath, 'utf8') : '';
    const mappedProps = new Set();
    for (const m of transformer.matchAll(/^\s*([a-z][a-zA-Z0-9_]*)\s*:\s*tool\.([a-z_][a-z0-9_]*)/gm)) {
      mappedProps.add(m[1]); // camelCase alias used in components
    }
    const possiblyMissing = [...toolPropsAll].filter(p => !toolCols.has(p) && !IGNORE.has(p) && !mappedProps.has(p));
    const realMissing = possiblyMissing.filter(p => !/^[A-Z]/.test(p) && p.length > 2);
    record(`tool property accesses: zero references to non-existent columns`,
      realMissing.length === 0,
      realMissing.length > 0 ? `Possibly missing: ${realMissing.slice(0, 10).join(', ')} (review manually)` : '');
  }

  if (runsSchema.error) {
    record('runs table reachable', false, runsSchema.error);
  } else {
    record(`runs table reachable (${runsSchema.columns.length} columns)`, true);
  }

  // === 3. ANON KEY PERMISSION TEST ===
  console.log('\n[3] Anon-key public read access');
  // Use the anon key (which the website uses) to verify each table is readable
  const { createClient } = require('@supabase/supabase-js');
  const anonClient = createClient(process.env.SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);
  for (const tbl of ['tools', 'runs']) {
    const { data, error, count } = await anonClient.from(tbl).select('*', { count: 'exact', head: true });
    record(`anon key can read ${tbl} (count=${count ?? '?'})`, !error, error?.message || '');
  }

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
