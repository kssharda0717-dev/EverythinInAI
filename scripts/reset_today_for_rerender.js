#!/usr/bin/env node
/**
 * EverythinInAI — Force re-render of today's content
 *
 * Resets today's content_calendar row + reel_concepts so the user can
 * /pick again and get a fresh render with the latest prompt code.
 *
 * Use case: prompt code was updated AFTER today's render had already
 * completed. Without this, /pick returns the cached output_url and the
 * new prompts never run.
 *
 * Usage: node scripts/reset_today_for_rerender.js
 */

const db = require('../engine/core/database').getClient();

async function safeUpdate(table, payload, where) {
  // Try the update; if a column doesn't exist, drop it and retry.
  try {
    const { error } = await db.from(table).update(payload).match(where);
    if (error) throw error;
    return true;
  } catch (err) {
    const msg = err.message || String(err);
    const colMatch = msg.match(/'([a-z_]+)' column/i) || msg.match(/column "([a-z_]+)"/i);
    if (colMatch && payload[colMatch[1]] !== undefined) {
      console.warn(`  - column "${colMatch[1]}" missing on ${table}, dropping and retrying`);
      const { [colMatch[1]]: _, ...rest } = payload;
      return safeUpdate(table, rest, where);
    }
    console.error(`  ✗ update failed on ${table}: ${msg}`);
    return false;
  }
}

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n=== Reset today (${today}) for re-render ===\n`);

  // 1. Find today's calendar row
  const { data: cal } = await db
    .from('content_calendar')
    .select('id, state, output_url, content_type, concept_id')
    .eq('target_date', today)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!cal) {
    console.log(`No calendar row for ${today}. Nothing to reset.`);
    process.exit(0);
  }
  console.log('BEFORE:', {
    id: cal.id.slice(0, 8),
    state: cal.state,
    type: cal.content_type,
    had_output: !!cal.output_url,
  });

  // 2. Reset calendar row so /pick will accept it again
  console.log('\n[1/4] Resetting content_calendar row...');
  await safeUpdate(
    'content_calendar',
    {
      state: 'ready',
      output_url: null,
      completed_at: null,
      concept_id: null,
      picked_at: null,
      updated_at: new Date().toISOString(),
    },
    { id: cal.id }
  );

  // 3. Reset all of today's concepts
  console.log('[2/4] Resetting reel_concepts for today...');
  await safeUpdate(
    'reel_concepts',
    {
      is_winner: false,
      state: 'drafted',
      image_urls: null,
      final_url: null,
      talking_head_url: null,
      updated_at: new Date().toISOString(),
    },
    { target_date: today }
  );

  // 4. Wipe keyframes so hero_worker re-renders fresh
  console.log('[3/4] Wiping reel_keyframes for today\'s concepts...');
  const { data: concepts } = await db
    .from('reel_concepts')
    .select('id')
    .eq('target_date', today);

  let wiped = 0;
  for (const c of concepts || []) {
    const { error } = await db.from('reel_keyframes').delete().eq('concept_id', c.id);
    if (!error) wiped++;
  }
  console.log(`  wiped keyframes for ${wiped} concept(s)`);

  // 5. Verify
  console.log('[4/4] Verifying...');
  const { data: after } = await db
    .from('content_calendar')
    .select('id, state, output_url')
    .eq('id', cal.id)
    .maybeSingle();
  console.log('AFTER: ', { id: after.id.slice(0, 8), state: after.state, had_output: !!after.output_url });

  console.log(`\n✓ RESET COMPLETE.`);
  console.log(`Now go to Telegram and run /pick_<id> for any of today's ${(concepts || []).length} concepts.`);
  console.log(`The render will spawn fresh with the new canonical-look prompts.`);
  process.exit(0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
