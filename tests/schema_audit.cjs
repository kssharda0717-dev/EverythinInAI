#!/usr/bin/env node
/**
 * Hostile Schema Audit (v2 — stateful parser)
 *
 * For every `.from('TABLE')` call, walk forward and capture all chained
 * methods (.select, .update, .insert, .eq, .gte, etc.) until we hit a
 * statement terminator or another .from(). This avoids misattributing
 * columns when two queries are close together.
 *
 * Then we cross-check every column reference against the live Supabase
 * schema and flag mismatches.
 *
 * Run: node tests/schema_audit.cjs
 * Exit: 0 = clean, 1 = mismatches found.
 */

const fs = require('fs');
const path = require('path');
const dbModule = require('../engine/core/database');

const ROOT = path.resolve(__dirname, '..');

function gatherFiles(dir, out = []) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    const p = path.join(full, e.name);
    const rel = path.relative(ROOT, p);
    if (e.isDirectory()) gatherFiles(rel, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

/**
 * Stateful query-chain extractor.
 *
 * A Supabase query chain looks like:
 *   db.from('table').select('a,b').eq('col', x).gte('col2', y)
 *
 * Or split across lines:
 *   db.from('table')
 *     .select('a,b')
 *     .eq('col', x)
 *
 * The chain terminates at:
 *   - A semicolon or statement end
 *   - Another `.from('...')` (new chain)
 *   - `.maybeSingle()` / `.single()` / `.then(`
 *
 * Returns: [{ table, columns: Set<string>, file, startLine }]
 */
function extractChains(src, file) {
  const chains = [];
  // Find each .from('...') occurrence by character index
  const fromRegex = /\.from\(['"]([a-z_][a-z0-9_]*)['"]\)/g;
  const matches = [];
  let m;
  while ((m = fromRegex.exec(src)) !== null) {
    matches.push({ table: m[1], start: m.index, end: m.index + m[0].length });
  }

  // For each match, the chain spans until the next .from() or a `;` not inside a string/object
  for (let i = 0; i < matches.length; i++) {
    const { table, start, end } = matches[i];
    const chainStart = end;
    const chainEnd = i + 1 < matches.length ? matches[i + 1].start : src.length;
    const chainSrc = src.slice(chainStart, chainEnd);

    // Now parse chain method calls
    const columns = new Set();

    // Pattern: .select('col1, col2, col3')
    for (const sm of chainSrc.matchAll(/\.select\(\s*['"`]([^'"`]+)['"`]/g)) {
      const cols = sm[1].split(',').map(c => c.trim().split(/[\s(:]/)[0]).filter(c => c && c !== '*');
      cols.forEach(c => columns.add(c));
    }

    // Pattern: .eq/.gte/.gt/.lte/.lt/.in/.is/.ilike/.like/.neq('col', ...)
    for (const sm of chainSrc.matchAll(/\.(eq|gte|gt|lte|lt|in|is|ilike|like|neq|filter|contains|containedBy|rangeGt|rangeGte|rangeLt|rangeLte)\(\s*['"]([a-z_][a-z0-9_]*)['"]/g)) {
      columns.add(sm[2]);
    }

    // Pattern: .order('col', ...)
    for (const sm of chainSrc.matchAll(/\.order\(\s*['"]([a-z_][a-z0-9_]*)['"]/g)) {
      columns.add(sm[1]);
    }

    // Pattern: .update({ col: ..., col2: ... }) — object keys
    // We use a more careful regex that requires the identifier to be at the START
    // of a property declaration (preceded by `{` or `,` after whitespace), to avoid
    // matching `null` or `true` inside ternary values.
    for (const sm of chainSrc.matchAll(/\.update\(\s*\{([\s\S]*?)\}\s*\)/g)) {
      extractObjectKeys(sm[1], columns);
    }

    for (const sm of chainSrc.matchAll(/\.insert\(\s*\{([\s\S]*?)\}\s*\)/g)) {
      extractObjectKeys(sm[1], columns);
    }

    for (const sm of chainSrc.matchAll(/\.upsert\(\s*\{([\s\S]*?)\}\s*[,)]/g)) {
      extractObjectKeys(sm[1], columns);
    }

    // Find the start line of this chain in the source
    const startLine = src.slice(0, start).split('\n').length;

    chains.push({ table, columns: [...columns], file, startLine });
  }

  return chains;
}

function extractObjectKeys(objBody, columns) {
  // Walk the object body and extract identifiers that appear as object KEYS only.
  // A key is an identifier followed by `:` at the start of a property, preceded
  // by `{`, `,`, or newline+whitespace. We strip string literals and nested
  // objects/arrays first so values can't confuse us.
  //
  // Reserved words that are NEVER column names (these are JS literals/keywords)
  const RESERVED = new Set(['null', 'true', 'false', 'undefined', 'NaN', 'Infinity', 'return', 'await', 'new']);

  // Strip strings (both single and double quoted, accounting for escapes)
  let cleaned = objBody.replace(/'(?:[^'\\]|\\.)*'/g, "''")
                       .replace(/"(?:[^"\\]|\\.)*"/g, '""')
                       .replace(/`(?:[^`\\]|\\.)*`/g, '``');

  // Match identifier followed by `:` where the identifier is preceded by `{`, `,`, or whitespace at line start
  for (const km of cleaned.matchAll(/(?:^|[{,]|\n\s+)([a-z_][a-z0-9_]*)\s*:/g)) {
    const key = km[1];
    if (!RESERVED.has(key)) columns.add(key);
  }
}

function extractFromFile(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  try {
    return extractChains(src, file);
  } catch (err) {
    console.log(`  ⚠ parse error ${file}: ${err.message}`);
    return [];
  }
}

async function getLiveSchemas(tables) {
  const db = dbModule.getClient();
  const schemas = {};
  for (const t of tables) {
    try {
      const { data, error } = await db.from(t).select('*').limit(1);
      if (error) { schemas[t] = { error: error.message, columns: null }; continue; }
      if (data && data.length > 0) {
        schemas[t] = { columns: Object.keys(data[0]), error: null };
      } else {
        // Empty table — try to discover columns via a deliberate bad insert.
        // PostgREST returns the row's column list when you try to insert columns
        // that don't match (well, kind of: it complains about each unknown col one
        // by one). Instead, we use a different trick: use information_schema via
        // a SELECT against an RPC if available, otherwise leave columns=[] but mark.
        // 
        // Simpler trick: try inserting NOTHING (empty object) and parse error;
        // PostgREST will list required NOT-NULL columns. That's enough.
        const probe = await db.from(t).insert({}).select();
        if (probe.error) {
          // Try parsing column names out of the error message
          // Format: 'null value in column "xxx" of relation "yyy" violates not-null constraint'
          const colsFromErr = [...(probe.error.message || '').matchAll(/column "([a-z_][a-z0-9_]*)"/gi)].map(m => m[1]);
          if (colsFromErr.length > 0) {
            // We only got NOT-NULL columns this way. Still useful but incomplete.
            schemas[t] = { columns: colsFromErr, error: 'empty (partial column list from NOT NULL constraints)', partial: true };
            continue;
          }
        }
        schemas[t] = { columns: [], error: 'empty (could not introspect)' };
      }
    } catch (err) {
      schemas[t] = { error: err.message, columns: null };
    }
  }
  return schemas;
}

(async () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  HOSTILE SCHEMA AUDIT v2 (stateful parser)');
  console.log('═══════════════════════════════════════════════════════\n');

  const files = gatherFiles('avatar').concat(gatherFiles('engine'));
  console.log(`Scanning ${files.length} JS files...`);

  let allChains = [];
  for (const f of files) allChains = allChains.concat(extractFromFile(f));
  console.log(`Extracted ${allChains.length} DB query chains.\n`);

  const tables = [...new Set(allChains.map(c => c.table))];
  console.log(`Fetching live schemas for ${tables.length} tables...`);
  const schemas = await getLiveSchemas(tables);

  console.log('\n─── Schema status ─────────────────────────────────────');
  for (const t of tables.sort()) {
    const s = schemas[t];
    if (s.error && !s.columns) console.log(`  ❌ ${t.padEnd(28)} ${s.error}`);
    else if (s.columns && s.columns.length === 0) console.log(`  ⚠  ${t.padEnd(28)} (empty — can't audit)`);
    else if (s.partial) console.log(`  ~  ${t.padEnd(28)} ${s.columns.length} columns (partial — NOT NULL only)`);
    else console.log(`  ✓  ${t.padEnd(28)} ${s.columns.length} columns`);
  }

  console.log('\n─── Hostile column audit ──────────────────────────────');
  const issues = [];
  for (const chain of allChains) {
    const s = schemas[chain.table];
    if (!s || !s.columns || s.columns.length === 0) continue;
    // For partial column lists, skip the check (we can't be sure what's actually missing)
    if (s.partial) continue;
    for (const col of chain.columns) {
      if (col === '*') continue;
      if (!s.columns.includes(col)) {
        issues.push({ ...chain, missing: col });
      }
    }
  }

  if (issues.length === 0) {
    console.log('  ✅ No column mismatches found.');
  } else {
    console.log(`  ❌ Found ${issues.length} column reference(s) that don't exist:\n`);
    const grouped = {};
    for (const i of issues) {
      const key = `${i.table}.${i.missing}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(`${i.file}:${i.startLine}`);
    }
    for (const [key, locs] of Object.entries(grouped)) {
      const [tbl, col] = key.split('.');
      const validCols = schemas[tbl]?.columns || [];
      const suggestion = validCols.find(c => c.replace(/_/g, '') === col.replace(/_/g, '')) ||
                          validCols.find(c => c.includes(col) || col.includes(c));
      console.log(`  ❌ ${key}`);
      console.log(`     At: ${locs.slice(0, 3).join(', ')}${locs.length > 3 ? ` (+${locs.length - 3} more)` : ''}`);
      if (suggestion) console.log(`     Did you mean: '${suggestion}'?`);
      console.log('');
    }
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log(`SUMMARY: ${issues.length} schema issues across ${[...new Set(issues.map(i => `${i.table}.${i.missing}`))].length} unique mismatches`);
  console.log('═══════════════════════════════════════════════════════');

  process.exit(issues.length === 0 ? 0 : 1);
})();
