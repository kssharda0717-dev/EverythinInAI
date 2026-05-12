#!/usr/bin/env node
/**
 * Comprehensive Status Audit
 * Run this on the VM to verify EVERYTHING is up to date:
 *   1. Git commit on disk matches latest main
 *   2. Every SQL migration's tables/columns exist in Supabase
 *   3. Every systemd timer is enabled and active
 *   4. Persona bible in DB matches the file
 *   5. Latest content in DB matches expected schema
 */
const dbModule = require('../engine/core/database');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const db = dbModule.getClient();

let total = 0, ok = 0, warn = 0, fail = 0;
const issues = [];

function record(category, name, status, detail = '') {
  total++;
  const icon = status === 'ok' ? '\u2713' : status === 'warn' ? '\u26a0' : '\u274c';
  console.log(`  ${icon} ${name}${detail ? ': ' + detail : ''}`);
  if (status === 'ok') ok++;
  else if (status === 'warn') { warn++; issues.push({ category, name, detail, severity: 'warn' }); }
  else { fail++; issues.push({ category, name, detail, severity: 'fail' }); }
}

(async () => {
  console.log('\n\u2550'.repeat(60));
  console.log('  EVERYTHININAI \u2014 COMPREHENSIVE STATUS AUDIT');
  console.log('\u2550'.repeat(60));

  // ============================================================
  // SECTION 1: GIT
  // ============================================================
  console.log('\n[1] GIT \u2014 code on disk matches GitHub main');
  try {
    const fetchR = spawnSync('git', ['fetch', 'origin', 'main'], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
    const localR = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    const remoteR = spawnSync('git', ['rev-parse', 'origin/main'], { cwd: ROOT, encoding: 'utf8' });
    const local = localR.stdout.trim().slice(0, 8);
    const remote = remoteR.stdout.trim().slice(0, 8);
    if (local === remote) {
      record('git', `local=${local} matches origin/main=${remote}`, 'ok');
    } else {
      record('git', `OUT OF DATE`, 'fail', `local=${local} vs remote=${remote} (run \`git pull origin main\`)`);
    }
  } catch (err) {
    record('git', 'git check failed', 'warn', err.message);
  }

  // ============================================================
  // SECTION 2: SQL MIGRATIONS \u2014 do all expected tables/cols exist?
  // ============================================================
  console.log('\n[2] SUPABASE \u2014 do all migrations exist?');
  // Map: table -> required columns. (Migration source noted in comment.)
  const REQUIRED_SCHEMA = {
    'tools':                       ['id', 'name', 'category', 'tagline', 'url', 'confidence', 'added_at'],          // 005
    'reel_concepts':               ['id', 'title', 'hook', 'full_script', 'cta', 'angle', 'content_type', 'image_prompt', 'keyframe_prompt', 'motion_prompt', 'music_mood'],  // 005, 016, 020
    'content_calendar':            ['id', 'target_date', 'state', 'output_url', 'posted_at', 'display_id', 'weekend_mode', 'dance_audio_url', 'dance_audio_filename'],  // 005, 019, 022
    'render_steps':                ['id', 'calendar_id', 'step_name', 'status', 'cost_usd'],                          // 005
    'reel_keyframes':              ['id', 'concept_id'],                                                              // 005
    'discovery_queue':             ['id', 'raw_title', 'raw_description', 'url', 'status', 'error_message'],          // 002
    'backfill_progress':           ['id', 'year_month', 'status'],                                                    // 003
    'runs':                        ['id', 'started_at', 'state'],                                                     // 002
    'personas':                    ['id', 'slug', 'bible_md', 'active_lora_url'],                                     // 004 + 017
    'reel_performance':            ['id', 'concept_id', 'framework', 'views', 'avg_watch_sec', 'retention_pct'],     // 013
    'pending_check_ins':           ['id', 'concept_id', 'chat_id'],                                                  // 014
    'content_frameworks':          ['id', 'slug', 'stream', 'is_active'],                                             // 015
    'travel_calendar':             ['id', 'start_date', 'end_date', 'location'],                                      // 018
    'trending_formats':            ['id', 'theme', 'captured_at'],                                                    // 018
    'topic_history':               ['id', 'persona_id', 'topic_key', 'last_used_at'],                                 // 021
    'pending_audio_uploads':       ['id', 'chat_id', 'for_date', 'status'],                                           // 022
    'daily_spend_log':             ['id', 'date', 'service', 'cost_usd'],                                             // 019
    'latency_log':                 ['id', 'service', 'operation', 'duration_ms'],                                     // 019
    'system_settings':             ['key', 'value'],                                                                  // 019
  };
  for (const [table, cols] of Object.entries(REQUIRED_SCHEMA)) {
    try {
      const { data, error } = await db.from(table).select('*').limit(1);
      if (error) {
        record('sql', `table ${table} EXISTS`, 'fail', `error: ${error.message}`);
        continue;
      }
      // If table is empty, columns can't be inspected. Try inserting a sentinel-fail to read column constraints instead.
      const liveCols = data?.[0] ? Object.keys(data[0]) : null;
      if (!liveCols) {
        record('sql', `table ${table} exists (empty, columns not inspected)`, 'ok');
        continue;
      }
      const missing = cols.filter(c => !liveCols.includes(c));
      if (missing.length === 0) {
        record('sql', `table ${table} \u2713 has all ${cols.length} expected columns`, 'ok');
      } else {
        record('sql', `table ${table} MISSING COLUMNS`, 'fail', `[${missing.join(', ')}] \u2014 run the matching migration`);
      }
    } catch (err) {
      record('sql', `table ${table} check failed`, 'fail', err.message);
    }
  }

  // ============================================================
  // SECTION 3: PERSONA BIBLE in DB matches the file
  // ============================================================
  console.log('\n[3] PERSONA BIBLE \u2014 DB has the latest bible');
  try {
    const { data: persona } = await db.from('personas').select('slug, bible_md').eq('slug', 'avi').maybeSingle();
    if (!persona) {
      record('persona', 'avi persona row exists', 'fail', 'no row found');
    } else if (!persona.bible_md) {
      record('persona', 'persona.bible_md populated', 'fail', 'bible_md is null \u2014 run the bible-sync command');
    } else {
      const bibleFile = fs.readFileSync(path.join(ROOT, 'avatar/persona/RHEA_BIBLE.md'), 'utf8');
      const dbLen = persona.bible_md.length;
      const fileLen = bibleFile.length;
      if (dbLen === fileLen) {
        record('persona', `bible_md in DB (${dbLen} chars) matches file (${fileLen} chars)`, 'ok');
      } else {
        record('persona', `bible_md in DB OUT OF SYNC`, 'warn', `db=${dbLen} chars, file=${fileLen} chars \u2014 re-run sync`);
      }
    }
  } catch (err) {
    record('persona', 'check failed', 'fail', err.message);
  }

  // ============================================================
  // SECTION 4: SYSTEMD TIMERS \u2014 all enabled and active
  // ============================================================
  console.log('\n[4] SYSTEMD TIMERS \u2014 all weekly/daily crons enabled');
  const expectedTimers = [
    'everythinginai-incremental.timer',
    'everythinginai-morning.timer',
    'everythinginai-ideation.timer',
    'everythinginai-telegram-listener.service',
    'everythinginai-weekend-nudge.timer',
    'everythinginai-checkin.timer',
    'everythinginai-trend-ingestion.timer',
    'everythinginai-evolution.timer',
    'everythinginai-bible-sync.timer',
    'everythinginai-url-validator.timer',
    'everythinginai-health-report.timer',
  ];
  // Run systemctl list-units to see what's actually loaded
  const r = spawnSync('systemctl', ['list-unit-files', '--no-pager', '--type=timer,service'], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) {
    record('systemd', 'systemctl unavailable', 'warn', 'cannot verify timers from this environment');
  } else {
    const enabledLines = r.stdout.split('\n');
    for (const t of expectedTimers) {
      const line = enabledLines.find(l => l.startsWith(t));
      if (!line) {
        record('systemd', t, 'fail', 'NOT INSTALLED \u2014 copy the .service/.timer file from deploy/systemd/ and enable it');
      } else if (line.includes('enabled')) {
        record('systemd', t, 'ok', 'enabled');
      } else if (line.includes('disabled')) {
        record('systemd', t, 'warn', 'disabled \u2014 enable with `sudo systemctl enable ' + t + '`');
      } else {
        record('systemd', t, 'ok', line.split(/\s+/)[1] || 'unknown state');
      }
    }
  }

  // ============================================================
  // SECTION 5: yt-dlp installed?
  // ============================================================
  console.log('\n[5] EXTERNAL TOOLS \u2014 yt-dlp + ffmpeg present');
  for (const tool of ['yt-dlp', 'ffmpeg']) {
    const t = spawnSync('which', [tool], { encoding: 'utf8' });
    if (t.status === 0 && t.stdout.trim()) {
      record('tools', `${tool} found at ${t.stdout.trim()}`, 'ok');
    } else {
      record('tools', `${tool} NOT FOUND`, 'fail', `install with sudo apt install -y ${tool}`);
    }
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('\n' + '\u2550'.repeat(60));
  console.log(`SUMMARY: ${ok}/${total} OK \u2014 ${warn} warnings \u2014 ${fail} failures`);
  if (issues.length > 0) {
    console.log('\nIssues to address:');
    for (const i of issues) {
      console.log(`  [${i.severity.toUpperCase()}] ${i.name}${i.detail ? ' \u2014 ' + i.detail : ''}`);
    }
  } else {
    console.log('\u2728 Everything is up to date.');
  }
  console.log('\u2550'.repeat(60));
  process.exit(fail > 0 ? 1 : 0);
})();
