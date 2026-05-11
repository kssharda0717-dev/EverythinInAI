/**
 * EverythinInAI — Engagement Planner v2
 *
 * Decides WHERE in the talking-head video to insert cuts and SFX.
 * Removed: stat callouts (looked unprofessional)
 * Added:   2-3 screenshot B-rolls per Reel for visual variety.
 */

const { createLogger } = require('../../engine/utils/logger');
const log = createLogger('engagement');

function planEngagement(cues, concept) {
  const words = cues.flatMap(c => c.text.split(/\s+/).map((w, i, arr) => ({
    text: w,
    start: c.start + (c.end - c.start) * (i / Math.max(arr.length, 1)),
    end:   c.start + (c.end - c.start) * ((i + 1) / Math.max(arr.length, 1)),
  })));

  const plan = {
    broll_cuts: [],
    zoom_punches: [],
    sfx_events: [],
  };

  const totalDuration = words.length > 0 ? words[words.length - 1].end : 0;

  // ─── High-Retention Visual Rhythm (8-15s reels) ─────────────────────────
  // We MUST break the static talking head within the first 3 seconds.

  // 1. First B-roll Cut: The "Proof" (at 2.0s - 2.5s)
  // Cuts away from Rhea to show the tool/signal URL, proving the hook is real.
  if (concept.signal_url && totalDuration > 4) {
    const firstCutSec = Math.min(2.2, totalDuration * 0.25);
    plan.broll_cuts.push({
      at_sec: firstCutSec,
      duration: 1.8,
      source_url: concept.signal_url,
      type: 'screenshot',
    });
    plan.sfx_events.push({ at_sec: firstCutSec, type: 'cut_transition' });
  }

  // 2. The Zoom Punch: The "Wake Up" (at ~60% mark)
  // A sudden slight zoom in on Rhea's face to reset attention before the punchline.
  if (totalDuration > 7) {
    const punchSec = totalDuration * 0.60;
    plan.zoom_punches.push({
      from_sec: punchSec,
      to_sec: punchSec + 2.0,
      zoom_factor: 1.15,
    });
    plan.sfx_events.push({ at_sec: punchSec, type: 'punch' });
  }

  // 3. Second B-roll Cut (Optional, for slightly longer reels > 12s)
  if (concept.signal_url && totalDuration > 12) {
    const secondCutSec = totalDuration * 0.80;
    plan.broll_cuts.push({
      at_sec: secondCutSec,
      duration: 1.5,
      source_url: concept.signal_url,
      type: 'screenshot',
    });
    plan.sfx_events.push({ at_sec: secondCutSec, type: 'cut_transition' });
  }

  // ─── End hook punch ──────────────────────────────────────────────────────
  if (totalDuration > 5) {
    const lastStart = Math.max(0, totalDuration - 2);
    plan.sfx_events.push({ at_sec: lastStart, type: 'punch' });
  }

  // Sort
  plan.broll_cuts.sort((a, b) => a.at_sec - b.at_sec);
  plan.zoom_punches.sort((a, b) => a.from_sec - b.from_sec);
  plan.sfx_events.sort((a, b) => a.at_sec - b.at_sec);

  log.info(`Plan: ${plan.broll_cuts.length} B-roll cuts, ${plan.zoom_punches.length} zoom punches, ${plan.sfx_events.length} SFX events`);
  return plan;
}

module.exports = { planEngagement };
