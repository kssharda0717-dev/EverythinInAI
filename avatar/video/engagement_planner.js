/**
 * EverythinInAI — Engagement Planner
 *
 * Decides WHERE in the talking-head video to insert cuts, zoom punches,
 * and SFX. Pure logic — no ffmpeg here.
 *
 * Inputs:  word-level cues + concept metadata (signal URL, entities, topics)
 * Outputs: structured plan:
 *   {
 *     broll_cuts:   [{at_sec, duration, source_url}],
 *     zoom_punches: [{from_sec, to_sec, scale}],
 *     sfx_events:   [{at_sec, type}],
 *   }
 */

const { createLogger } = require('../../engine/utils/logger');
const log = createLogger('engagement');

// Words that signal "show me something" → schedule B-roll
const TRIGGER_PATTERNS = [
  { pattern: /\b(yayi|github|repo)\b/i, type: 'screenshot', source: 'signal_url' },
  { pattern: /\b(open[- ]source|trillion|tokens?)\b/i, type: 'stat_callout' },
  { pattern: /\b(here'?s|nobody|wild|unhinged|crazy)\b/i, type: 'zoom_punch' },
];

function findWordHits(words, pattern) {
  const hits = [];
  for (let i = 0; i < words.length; i++) {
    if (pattern.test(words[i].text)) hits.push(i);
  }
  return hits;
}

function planEngagement(cues, concept) {
  // First, flatten cues back into words (or accept words directly)
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

  // 1. B-roll: detect entity mentions → screenshot the signal URL
  if (concept.signal_id && concept.entities && concept.entities.length > 0) {
    // Prefer first entity mention near second 4-8 (after hook)
    const firstEntity = concept.entities[0]?.toLowerCase();
    if (firstEntity) {
      for (let i = 0; i < words.length; i++) {
        if (words[i].text.toLowerCase().includes(firstEntity.split(' ')[0])) {
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

  // 2. Stat callouts: detect numbers
  for (let i = 0; i < words.length; i++) {
    const m = words[i].text.match(/^(\d+|two|three|four|five|six|seven|eight|nine|ten)$/i);
    if (m && words[i + 1]) {
      const nextWord = words[i + 1].text.toLowerCase();
      if (['trillion', 'billion', 'million', 'thousand', 'tokens', 'parameters', 'languages', 'percent', 'years'].includes(nextWord)) {
        if (words[i].start >= 5 && words[i].start <= totalDuration - 3) {
          plan.broll_cuts.push({
            at_sec: words[i].start - 0.1,
            duration: 1.2,
            type: 'stat_callout',
            stat_text: words[i].text.toUpperCase(),
            stat_subtext: nextWord.toUpperCase(),
          });
          plan.sfx_events.push({ at_sec: words[i].start - 0.1, type: 'callout' });
          break;            // only one callout per Reel to avoid overload
        }
      }
    }
  }

  // 3. Zoom punches: detect emphasis words
  for (let i = 0; i < words.length; i++) {
    if (/\b(wild|unhinged|crazy|literally|honestly|huge|massive)\b/i.test(words[i].text)) {
      const start = Math.max(0, words[i].start - 0.1);
      const end = Math.min(totalDuration, words[i].end + 0.5);
      if (end - start >= 0.4) {
        plan.zoom_punches.push({ from_sec: start, to_sec: end, scale: 1.15 });
      }
    }
  }
  // Cap zoom punches to 3 max so it doesn't feel hyperactive
  plan.zoom_punches = plan.zoom_punches.slice(0, 3);

  // 4. End hook: punchline emphasis (last 3 sec)
  if (totalDuration > 5) {
    const lastStart = Math.max(0, totalDuration - 3);
    plan.zoom_punches.push({ from_sec: lastStart, to_sec: totalDuration, scale: 1.10 });
    plan.sfx_events.push({ at_sec: lastStart, type: 'punch' });
  }

  // Sort everything by time
  plan.broll_cuts.sort((a, b) => a.at_sec - b.at_sec);
  plan.zoom_punches.sort((a, b) => a.from_sec - b.from_sec);
  plan.sfx_events.sort((a, b) => a.at_sec - b.at_sec);

  log.info(`Plan: ${plan.broll_cuts.length} B-roll cuts, ${plan.zoom_punches.length} zoom punches, ${plan.sfx_events.length} SFX events`);
  return plan;
}

module.exports = { planEngagement };
