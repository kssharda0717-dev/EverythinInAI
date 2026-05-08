/**
 * EverythinInAI — B-roll Generator
 *
 * Produces B-roll image assets for engagement cuts. Sources:
 *   1. Microlink screenshot API (free, no auth) for product/website B-roll
 *   2. Animated text-overlay PNGs for stats/numbers (rendered with sharp)
 *
 * Returns local file paths ready for ffmpeg.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('broll');

/**
 * Microlink screenshot API. Free tier: 50 req/day, no auth.
 * Docs: https://microlink.io/docs/api/parameters/screenshot
 *
 * @param {string} url - target page
 * @param {string} destPath - local destination
 * @returns {Promise<string>} local path
 */
async function screenshotUrl(url, destPath, opts = {}) {
  log.info(`Screenshotting ${url}...`);
  const microlinkUrl = `https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=false&embed=screenshot.url&viewport.width=${opts.width || 1080}&viewport.height=${opts.height || 1350}&viewport.deviceScaleFactor=1&waitUntil=networkidle2&fullPage=false`;

  // Microlink returns the actual PNG URL; we follow it.
  const r1 = await axios.get(microlinkUrl, { timeout: 60_000, maxRedirects: 5, responseType: 'arraybuffer' });
  fs.writeFileSync(destPath, Buffer.from(r1.data));

  if (fs.statSync(destPath).size < 1000) {
    throw new Error('Microlink returned an empty/invalid screenshot');
  }
  log.info(`✓ Screenshot saved: ${destPath}`);
  return destPath;
}

/**
 * Generate a stat callout PNG: large number + label, on a clean background.
 * Uses ffmpeg's drawtext for simplicity (no extra deps).
 */
function generateStatCallout(text, subtext, destPath, opts = {}) {
  const { spawnSync } = require('child_process');
  const W = opts.width || 1080;
  const H = opts.height || 1350;
  const fontFile = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

  // Render: gradient background + huge centered text + smaller subtext below
  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=#1a1a2e:s=${W}x${H}`,    // dark navy background
    '-vframes', '1',
    '-vf', `drawtext=fontfile=${fontFile}:text='${text.replace(/'/g, "\\'")}':fontcolor=white:fontsize=240:x=(w-text_w)/2:y=(h-text_h)/2-100,drawtext=fontfile=${fontFile}:text='${subtext.replace(/'/g, "\\'")}':fontcolor=#aaaaaa:fontsize=60:x=(w-text_w)/2:y=(h-text_h)/2+100`,
    destPath,
  ];
  const r = spawnSync('ffmpeg', args, { stdio: 'ignore' });
  if (r.status !== 0) throw new Error('ffmpeg drawtext failed');
  return destPath;
}

module.exports = { screenshotUrl, generateStatCallout };
