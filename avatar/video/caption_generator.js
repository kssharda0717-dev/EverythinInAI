/**
 * EverythinInAI — Caption Generator
 *
 * Takes a voice track URL → runs incredibly-fast-whisper → returns word-level
 * SRT (one or two words per cue, suitable for TikTok-style burned-in captions).
 */

const { runModel } = require('../imagery/replicate_client');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('captions');

/**
 * Format seconds as SRT timecode HH:MM:SS,mmm
 */
function srtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * Group words into 1-2 word cues for snappy TikTok style.
 */
function buildCues(words) {
  const cues = [];
  let i = 0;
  while (i < words.length) {
    const w1 = words[i];
    const w2 = words[i + 1];
    // Group 2 words if they're both short (≤4 chars), otherwise 1 word
    if (w2 && w1.text.length <= 4 && w2.text.length <= 4) {
      cues.push({
        start: w1.start,
        end: w2.end,
        text: `${w1.text} ${w2.text}`.toUpperCase().trim(),
      });
      i += 2;
    } else {
      cues.push({
        start: w1.start,
        end: w1.end,
        text: w1.text.toUpperCase().trim(),
      });
      i += 1;
    }
  }
  return cues;
}

function cuesToSrt(cues) {
  return cues.map((c, i) =>
    `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`
  ).join('\n');
}

/**
 * Generate word-level captions for a voice track.
 * @param {string} audioUrl - public URL of the voice WAV
 * @returns {Promise<{srt: string, cues: Array, duration: number, cost_usd: number}>}
 */
async function generateCaptions(audioUrl) {
  log.info(`Transcribing ${audioUrl}...`);

  const result = await runModel('whisper_fast', {
    audio: audioUrl,
    task: 'transcribe',
    language: 'english',
    timestamp: 'word',           // word-level for animated captions
    batch_size: 24,
    diarise_audio: false,
  }, { timeoutMs: 180_000 });

  // Output structure: { text: "...", chunks: [{text, timestamp: [start, end]}, ...] }
  const out = Array.isArray(result.output) ? result.output[0] : result.output;
  const chunks = out?.chunks || [];

  const words = chunks
    .filter(c => c.timestamp && c.timestamp.length === 2 && c.text)
    .map(c => ({
      text: c.text.replace(/^\s+|\s+$/g, ''),
      start: Number(c.timestamp[0]) || 0,
      end: Number(c.timestamp[1]) || 0,
    }))
    .filter(w => w.end > w.start);

  if (words.length === 0) {
    throw new Error(`Whisper returned no word-level timestamps. Raw output: ${JSON.stringify(out).substring(0, 300)}`);
  }

  const cues = buildCues(words);
  const srt = cuesToSrt(cues);
  const duration = words[words.length - 1].end;

  log.info(`✓ ${words.length} words → ${cues.length} cues, ${duration.toFixed(2)}s total`);

  return {
    srt,
    cues,
    duration,
    cost_usd: result.cost_usd,
    raw_text: out?.text || '',
  };
}

module.exports = { generateCaptions, srtTime, buildCues, cuesToSrt };
