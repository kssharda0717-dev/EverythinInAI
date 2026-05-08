/**
 * EverythinInAI — Weekly Content Planner
 *
 * Defines what content type runs on which weekday, and creates the daily
 * content_calendar row. Hard-capped to 1 entry per day via UNIQUE constraint.
 *
 *   Mon-Thu  →  tech_reel
 *   Fri      →  lure_photo
 *   Sat-Sun  →  lifestyle_reel
 *
 * No content fires unless this row exists; the user's /pick command then sets
 * state='picked' and triggers the render chain.
 */

const dbModule = require('../../engine/core/database');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('weekly_planner');

// 0 = Sunday, 1 = Monday, ... 6 = Saturday
const WEEKDAY_PLAN = {
  0: 'lifestyle_reel',  // Sunday
  1: 'tech_reel',       // Monday
  2: 'tech_reel',       // Tuesday
  3: 'tech_reel',       // Wednesday
  4: 'tech_reel',       // Thursday
  5: 'lure_photo',      // Friday
  6: 'lifestyle_reel',  // Saturday
};

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getContentTypeForDate(date = new Date()) {
  const dow = date.getDay();
  return {
    weekday: dow,
    weekdayName: WEEKDAY_NAMES[dow],
    contentType: WEEKDAY_PLAN[dow],
  };
}

/**
 * Create today's content_calendar row if it doesn't exist.
 * Returns the row (existing or new).
 */
async function ensureTodaysCalendarRow() {
  const db = dbModule.getClient();
  const today = new Date();
  const targetDate = today.toISOString().slice(0, 10);
  const { weekday, weekdayName, contentType } = getContentTypeForDate(today);

  // Check if exists
  const { data: existing } = await db
    .from('content_calendar')
    .select('*')
    .eq('target_date', targetDate)
    .eq('content_type', contentType)
    .maybeSingle();

  if (existing) {
    log.info(`Calendar row exists: ${targetDate} (${weekdayName}) → ${contentType} [state=${existing.state}]`);
    return existing;
  }

  const { data, error } = await db
    .from('content_calendar')
    .insert({
      target_date: targetDate,
      weekday,
      content_type: contentType,
      state: 'pending',
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create calendar row: ${error.message}`);
  log.info(`✓ New calendar row: ${targetDate} (${weekdayName}) → ${contentType}`);
  return data;
}

module.exports = { getContentTypeForDate, ensureTodaysCalendarRow, WEEKDAY_PLAN, WEEKDAY_NAMES };
