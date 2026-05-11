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

/**
 * Build a punchy ASS subtitle file with bouncy per-word animations.
 * Style: huge bold white text, black outline, drop shadow, scale-bounce on entry,
 * yellow highlight on emphasis words.
 */
function buildBouncyAss(cues, totalSeconds, opts = {}) {
  const W = opts.width || 1080;
  const H = opts.height || 1350;

  // Three styles:
  //   Default     — word-by-word captions
  //   Highlight   — emphasis words in yellow
  //   Watermark   — small "@avi.in.ai" in top-right, persistent through the whole Reel
  //   Outro       — large "EVERYTHININAI.COM" at bottom-center for last 2.5s
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Montserrat,110,&H00FFFFFF,&H000000FF,&H00000000,&HC8000000,1,0,0,0,100,100,0,0,1,8,4,2,80,80,250,1
Style: Highlight,Montserrat,110,&H0000FFFF,&H000000FF,&H00000000,&HC8000000,1,0,0,0,100,100,0,0,1,8,4,2,80,80,250,1
Style: Watermark,Montserrat,32,&HB0FFFFFF,&H000000FF,&H80000000,&H00000000,1,0,0,0,100,100,0,0,1,2,2,9,30,30,30,1
Style: Outro,Montserrat,72,&H00FFFFFF,&H000000FF,&H00000000,&HC8000000,1,0,0,0,100,100,0,0,1,6,3,2,80,80,180,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const HIGHLIGHT_WORDS = /^(WILD|UNHINGED|CRAZY|HUGE|MASSIVE|HONESTLY|LITERALLY|YAAR|MATLAB|OKAY)$/i;

  const wordEvents = cues.map(c => {
    const start = assTime2(c.start);
    const end = assTime2(c.end);
    const isHighlight = HIGHLIGHT_WORDS.test(c.text.replace(/[^a-z]/gi, ''));
    const style = isHighlight ? 'Highlight' : 'Default';
    const text = `{\\fad(60,60)\\fscx140\\fscy140\\t(0,150,\\fscx100\\fscy100)}${c.text}`;
    return `Dialogue: 0,${start},${end},${style},,0,0,0,,${text}`;
  });

  return header + wordEvents.join('\n');
}

function assTime2(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(2);
  const [sec, cs] = s.split('.');
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${cs}`;
}

module.exports = { generateCaptions, srtTime, buildCues, cuesToSrt, buildBouncyAss };
