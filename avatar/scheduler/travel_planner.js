#!/usr/bin/env node
/**
 * EverythinInAI — Travel Planner CLI
 *
 * Used to manually add weekend travel plans to the travel_calendar table.
 * The lifestyle worker reads from this to set the weekend reel in the right location.
 *
 * Usage:
 *   node avatar/scheduler/travel_planner.js add 2026-05-17 2026-05-18 "Goa" "beach" "surfing,beach yoga,sunset drive"
 *   node avatar/scheduler/travel_planner.js list
 *   node avatar/scheduler/travel_planner.js delete <id>
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('travel_planner');

async function add(args) {
  const [start, end, location, vibe, activitiesCsv, notes = ''] = args;
  if (!start || !end || !location) {
    log.error('Usage: add <start_date> <end_date> <location> [vibe] [activities,csv] [notes]');
    process.exit(1);
  }
  const db = dbModule.getClient();
  const planned_activities = activitiesCsv ? activitiesCsv.split(',').map(s => s.trim()) : [];
  const { data, error } = await db.from('travel_calendar').insert({
    start_date: start, end_date: end, location, vibe: vibe || null, planned_activities, notes,
  }).select().single();
  if (error) { log.error(`DB error: ${error.message}`); process.exit(1); }
  log.info(`✓ Added travel: ${data.start_date} to ${data.end_date} → ${data.location} (${data.vibe})`);
}

async function list() {
  const db = dbModule.getClient();
  const { data } = await db.from('travel_calendar').select('*').order('start_date', { ascending: true });
  if (!data || data.length === 0) { log.info('No travel plans.'); return; }
  for (const t of data) {
    log.info(`${t.start_date} → ${t.end_date}  ${t.location} (${t.vibe || 'no-vibe'})  activities: ${(t.planned_activities || []).join(', ')}`);
  }
}

async function del(args) {
  const [id] = args;
  if (!id) { log.error('Usage: delete <id>'); process.exit(1); }
  const db = dbModule.getClient();
  await db.from('travel_calendar').delete().eq('id', id);
  log.info(`✓ Deleted ${id}`);
}

const cmd = process.argv[2];
const args = process.argv.slice(3);

const handlers = { add, list, delete: del, del };
const handler = handlers[cmd];
if (!handler) {
  log.error('Unknown command. Use: add | list | delete');
  process.exit(1);
}
handler(args).catch(err => { log.error(err.message); process.exit(1); });
