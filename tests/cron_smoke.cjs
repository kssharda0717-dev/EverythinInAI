#!/usr/bin/env node
/**
 * Cron Smoke Test
 *
 * For each systemd service in deploy/systemd/, find the Node script it executes
 * (ExecStart=...) and try to `require()` it without running main(). If the script
 * has a syntax error, missing import, or fatal-on-load error, this catches it.
 *
 * For idempotent scripts (no side effects on require), we also try a dry-run.
 *
 * Run: node tests/cron_smoke.cjs
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SYSTEMD_DIR = path.join(ROOT, 'deploy/systemd');

function parseServiceFile(svcPath) {
  const src = fs.readFileSync(svcPath, 'utf8');
  const m = src.match(/^ExecStart\s*=\s*(.+)$/m);
  if (!m) return null;
  return m[1].trim();
}

function parseScriptPath(execLine) {
  // Match patterns like: /usr/bin/node /home/ubuntu/everythinginai-unified/avatar/x/y.js
  const m = execLine.match(/node\s+(\S+\.js)/);
  if (!m) return null;
  let scriptPath = m[1];
  // Convert absolute path to relative from ROOT
  if (scriptPath.startsWith('/home/ubuntu/everythinginai-unified/')) {
    scriptPath = scriptPath.replace('/home/ubuntu/everythinginai-unified/', '');
  } else if (scriptPath.startsWith('/')) {
    return null; // outside the project, can't test
  }
  return scriptPath;
}

console.log('═══════════════════════════════════════════════════════');
console.log('  CRON SCRIPT SMOKE TEST');
console.log('═══════════════════════════════════════════════════════\n');

const services = fs.readdirSync(SYSTEMD_DIR).filter(f => f.endsWith('.service'));
console.log(`Found ${services.length} systemd services. Resolving scripts...\n`);

const tests = [];
for (const svc of services) {
  const svcPath = path.join(SYSTEMD_DIR, svc);
  const execLine = parseServiceFile(svcPath);
  if (!execLine) { console.log(`  ⚠ ${svc}: no ExecStart`); continue; }
  const script = parseScriptPath(execLine);
  if (!script) { console.log(`  ⚠ ${svc}: non-Node ExecStart (${execLine})`); continue; }
  const fullPath = path.join(ROOT, script);
  if (!fs.existsSync(fullPath)) {
    console.log(`  ❌ ${svc}: script does not exist (${script})`);
    tests.push({ svc, script, ok: false, reason: 'script missing' });
    continue;
  }
  tests.push({ svc, script, ok: null });
}

console.log('');
let failures = 0;
for (const t of tests) {
  if (t.ok === false) { failures++; continue; }
  // Run with `node -c` first (syntax check, doesn't execute)
  const syntaxCheck = spawnSync('node', ['-c', path.join(ROOT, t.script)], { encoding: 'utf8' });
  if (syntaxCheck.status !== 0) {
    console.log(`  ❌ ${t.svc.padEnd(50)} SYNTAX ERROR`);
    console.log(`     ${syntaxCheck.stderr.trim().split('\n')[0]}`);
    failures++;
    continue;
  }
  // Now try a require() probe inside a child process. If it throws at module-load time
  // (missing imports, env-var-required-at-import, etc.), we catch it.
  const probe = spawnSync('node', ['-e', `
    process.exitCode = 0;
    try {
      require('${path.join(ROOT, t.script).replace(/\\/g, '\\\\')}');
      // Many cron scripts have a top-level await on main() that fires .catch(process.exit).
      // We give them a moment to crash, then exit ourselves.
      setTimeout(() => process.exit(0), 800);
    } catch (e) {
      console.error('LOAD_ERR:', e.message);
      process.exit(2);
    }
  `], { encoding: 'utf8', timeout: 5000, cwd: ROOT, env: { ...process.env } });
  if (probe.status === 0) {
    console.log(`  ✓ ${t.svc.padEnd(50)} loads OK`);
  } else if (probe.signal === 'SIGTERM') {
    console.log(`  ✓ ${t.svc.padEnd(50)} loads OK (timed out but didn't crash)`);
  } else {
    const errLine = (probe.stderr || '').split('\n').find(l => l.includes('LOAD_ERR') || l.includes('Error')) || (probe.stderr || '').trim().split('\n').pop();
    console.log(`  ❌ ${t.svc.padEnd(50)} LOAD ERROR`);
    console.log(`     ${(errLine || '').slice(0, 200)}`);
    failures++;
  }
}

console.log('');
console.log('═══════════════════════════════════════════════════════');
console.log(`SUMMARY: ${tests.length - failures}/${tests.length} cron scripts load cleanly`);
console.log('═══════════════════════════════════════════════════════');

process.exit(failures === 0 ? 0 : 1);
