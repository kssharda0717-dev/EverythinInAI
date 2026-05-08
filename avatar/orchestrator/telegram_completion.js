/**
 * EverythinInAI — Telegram Completion Notifier
 *
 * Sends the final ready-to-post Reel/photo to your Telegram with:
 *   - The MP4/JPG URL (you'll click & download)
 *   - The caption (formatted, ready to copy-paste into IG)
 *   - The hashtags (separately, easy to copy)
 *   - DM funnel keyword reminder
 */

const axios = require('axios');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('telegram_completion');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function emojiFor(contentType) {
  return {
    tech_reel: '🎬',
    lure_photo: '📸',
    lifestyle_reel: '🌅',
  }[contentType] || '✨';
}

function labelFor(contentType) {
  return {
    tech_reel: 'TECH REEL',
    lure_photo: 'LURE PHOTO',
    lifestyle_reel: 'LIFESTYLE REEL',
  }[contentType] || contentType.toUpperCase();
}

async function sendCompletionMessage({ contentType, targetDate, url, caption, hashtags, type, costUsd }) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log.warn('Telegram not configured; skipping completion message');
    return;
  }

  const emoji = emojiFor(contentType);
  const label = labelFor(contentType);

  // Compose two messages: one with URL + meta, one with caption + hashtags ready to copy
  const headerLines = [
    `${emoji} *${label} READY*  —  ${targetDate}`,
    ``,
    `📥 Download: ${url}`,
    `💵 Cost: $${costUsd.toFixed(3)}`,
    ``,
    `Steps to post:`,
    `1. Click the link above → Save the file`,
    `2. Open Instagram → New Reel/Post`,
    `3. Upload + paste caption + hashtags below`,
    `4. Watch comments for the DM funnel keyword`,
  ];

  const captionLines = [
    `📝 *CAPTION* (copy this):`,
    ``,
    '```',
    caption || '(no caption generated)',
    '```',
  ];

  const hashtagsLines = [
    `🏷 *HASHTAGS* (copy this):`,
    ``,
    '```',
    hashtags || '#avi #ai #aitoolsdaily',
    '```',
  ];

  const fullMessage = [
    ...headerLines,
    ``,
    ...captionLines,
    ``,
    ...hashtagsLines,
  ].join('\n');

  try {
    const r = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: fullMessage,
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      },
      { timeout: 10_000 }
    );
    log.info(`✓ Completion message sent to Telegram (msg ${r.data?.result?.message_id})`);
  } catch (err) {
    log.warn(`Telegram completion send failed: ${err.message}`);
  }
}

module.exports = { sendCompletionMessage };
