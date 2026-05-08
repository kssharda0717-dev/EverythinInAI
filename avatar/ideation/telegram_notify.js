/**
 * EverythinInAI — Ideation Telegram Notifier
 *
 * Sends today's drafted concepts to the operator's Telegram so they can
 * pick a winner. If no reply within AUTO_PICK_HOURS, the orchestrator
 * auto-picks Concept A.
 *
 * Uses the same TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID as the existing
 * digest bot (no new credentials needed).
 */

const axios = require('axios');
const { createLogger } = require('../../engine/utils/logger');

const log = createLogger('telegram_ideation');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.substring(0, n - 1) + '…' : str;
}

function formatConceptsMessage(signal, concepts, conceptIds) {
  const lines = [];
  lines.push(`🎬 IDEATION — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`📡 SIGNAL: ${truncate(signal.title, 80)}`);
  lines.push(`   ${signal.type.toUpperCase()} · virality ${signal.virality_score}/10 · ${signal.source}`);
  lines.push(`   ${signal.url}`);
  lines.push('');

  concepts.forEach((c, i) => {
    const letter = String.fromCharCode(65 + i); // A, B, C
    lines.push(`▶ Concept ${letter} — ${c.angle?.toUpperCase() || 'IDEA'} · lure ${c.lure_level}/4`);
    lines.push(`  Hook: ${truncate(c.hook, 90)}`);
    lines.push(`  Body: ${truncate(c.body_script, 200)}`);
    lines.push(`  Punch: ${truncate(c.punchline, 90)}`);
    lines.push(`  Caption: ${truncate(c.caption, 120)}`);
    lines.push(`  Pick: /pick_${conceptIds[i].slice(0, 8)}`);
    lines.push('');
  });

  lines.push('⚠️ You MUST reply /pick_<id> for one to render.');
  lines.push('NO auto-pick — if you don\'t reply, today\'s tech reel does NOT get rendered (cost-control).');
  return lines.join('\n');
}

async function sendConcepts(signal, concepts, conceptIds) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log.warn('Telegram credentials missing — printing concepts to stdout instead.');
    console.log(formatConceptsMessage(signal, concepts, conceptIds));
    return { sent: false };
  }

  const text = formatConceptsMessage(signal, concepts, conceptIds);
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  // Telegram messages cap at 4096 chars — split if needed
  const chunks = [];
  let buf = text;
  while (buf.length > 4000) {
    let split = buf.lastIndexOf('\n', 4000);
    if (split < 1000) split = 4000;
    chunks.push(buf.slice(0, split));
    buf = buf.slice(split + 1);
  }
  chunks.push(buf);

  for (const chunk of chunks) {
    try {
      await axios.post(url, {
        chat_id: TELEGRAM_CHAT_ID,
        text: chunk,
        disable_web_page_preview: true,
      }, { timeout: 15000 });
    } catch (err) {
      log.error(`Telegram send failed: ${err.response?.data?.description || err.message}`);
      throw err;
    }
  }

  log.info(`✓ Sent ${concepts.length} concepts to Telegram (${chunks.length} chunks)`);
  return { sent: true };
}

async function sendStatus(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[telegram-fallback]', text);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }, { timeout: 10000 });
  } catch (err) {
    log.warn(`Telegram status failed: ${err.message}`);
  }
}

module.exports = { sendConcepts, sendStatus, formatConceptsMessage };
