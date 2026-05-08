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

  // ─── B-roll #1: early in the Reel, on first entity mention ────────────────
  if (concept.signal_url && concept.entities && concept.entities.length > 0) {
    const firstEntity = concept.entities[0]?.toLowerCase()?.split(' ')[0];
    if (firstEntity) {
      for (let i = 0; i < words.length; i++) {
        if (words[i].text.toLowerCase().includes(firstEntity)) {
          if (words[i].start >= 3 && words[i].start <= totalDuration - 3) {
            plan.broll_cuts.push({
              at_sec: Math.max(0, words[i].start - 0.2),
              duration: 1.6,
              source_url: concept.signal_url,
              type: 'screenshot',
            });
            plan.sfx_events.push({ at_sec: Math.max(0, words[i].start - 0.2), type: 'cut_transition' });
            break;
          }
        }
      }
    }
  }

  // ─── B-roll #2: mid-Reel screenshot (~55% mark) ───────────────────────────
  if (concept.signal_url && totalDuration > 8) {
    const at = totalDuration * 0.55;
    plan.broll_cuts.push({
      at_sec: at,
      duration: 1.2,
      source_url: concept.signal_url,
      type: 'screenshot',
    });
    plan.sfx_events.push({ at_sec: at, type: 'cut_transition' });
  }

  // ─── End hook punch ──────────────────────────────────────────────────────
  if (totalDuration > 5) {
    const lastStart = Math.max(0, totalDuration - 3);
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
