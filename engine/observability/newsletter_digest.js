#!/usr/bin/env node
/**
 * EverythinInAI — Daily Newsletter Digest (Phase 16)
 *
 * Sends "The 8 AM AI brief" to every subscribed email.
 * Runs as a systemd timer at 02:30 UTC = 08:00 IST daily.
 *
 * Content per day:
 *   - Top 3 NEW tools added in last 24h (most upvoted)
 *   - Top 2 hot signals (drama / release / news with virality ≥ 7)
 *   - 1 take from Avi (the day's first concept, if drafted)
 *
 * Delivery: Resend API (3000 emails/month free tier)
 *
 * Env vars required:
 *   - RESEND_API_KEY        (https://resend.com/api-keys)
 *   - RESEND_FROM_EMAIL     (e.g. "Avi <avi@everythininai.com>")
 *   - SITE_URL              (default https://everythin-in-ai-iug3.vercel.app)
 *
 * Usage:
 *   node engine/observability/newsletter_digest.js
 *   node engine/observability/newsletter_digest.js --dry-run        # build digest, don't send
 *   node engine/observability/newsletter_digest.js --to=test@x.com  # send only to one address
 */

const axios = require('axios');
const crypto = require('crypto');
const dbModule = require('../core/database');
const { createLogger } = require('../utils/logger');

const log = createLogger('newsletter_digest');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM_EMAIL || 'Avi <avi@everythininai.com>';
const SITE_URL = process.env.SITE_URL || 'https://everythin-in-ai-iug3.vercel.app';
const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || RESEND_API_KEY || 'change-me';

function parseArgs(argv) {
  const args = { dryRun: false, singleTo: null };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--to=')) args.singleTo = a.split('=')[1];
  }
  return args;
}

// ─── Build the digest content ──────────────────────────────────────────────

async function buildDigest() {
  const db = dbModule.getClient();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // 1. Top 3 newest tools (by added_at desc, breaking tie on upvotes)
  const { data: tools } = await db
    .from('tools')
    .select('slug, name, display_name, tagline, url, homepage, category, upvotes')
    .eq('is_active', true)
    .gte('added_at', since)
    .order('upvotes', { ascending: false })
    .limit(3);

  // 2. Top 2 hot signals
  const { data: signals } = await db
    .from('ai_signals')
    .select('title, type, virality_score, url, summary')
    .gte('added_at', since)
    .gte('virality_score', 7)
    .order('virality_score', { ascending: false })
    .limit(2);

  // 3. Today's Avi take (first concept of the day's punchline)
  const today = new Date().toISOString().slice(0, 10);
  const { data: concept } = await db
    .from('reel_concepts')
    .select('title, hook, punchline, caption')
    .eq('target_date', today)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  return { tools: tools || [], signals: signals || [], concept };
}

// ─── Build the HTML email ──────────────────────────────────────────────────

function makeUnsubscribeToken(email) {
  return crypto.createHmac('sha256', UNSUBSCRIBE_SECRET).update(email.toLowerCase()).digest('hex').slice(0, 24);
}

function buildHtml({ tools, signals, concept }, email) {
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const token = makeUnsubscribeToken(email);
  const unsubUrl = `${SITE_URL}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;

  const toolBlocks = tools.map((t, i) => {
    const visitUrl = t.homepage || t.url;
    const name = t.display_name || t.name;
    return `
      <div style="margin: 24px 0; padding: 20px; border-radius: 16px; background: #f8f9fb;">
        <div style="font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">${t.category || 'AI Tool'}</div>
        <div style="font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 6px;">${i + 1}. ${name}</div>
        <div style="font-size: 14px; color: #4b5563; line-height: 1.6; margin-bottom: 12px;">${t.tagline || ''}</div>
        <a href="${visitUrl}" style="display: inline-block; padding: 8px 16px; background: linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%); color: white; text-decoration: none; border-radius: 8px; font-size: 13px; font-weight: 500;">Try ${name} →</a>
      </div>
    `;
  }).join('');

  const signalBlocks = signals.map((s) => `
    <div style="margin: 16px 0; padding: 16px; border-left: 3px solid #f59e0b; background: #fffbeb;">
      <div style="font-size: 11px; font-weight: 600; color: #92400e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">${s.type} · virality ${s.virality_score}/10</div>
      <div style="font-size: 15px; font-weight: 600; color: #111827; margin-bottom: 6px;">
        <a href="${s.url}" style="color: #111827; text-decoration: none;">${s.title}</a>
      </div>
      ${s.summary ? `<div style="font-size: 13px; color: #4b5563; line-height: 1.6;">${s.summary.substring(0, 200)}</div>` : ''}
    </div>
  `).join('');

  const conceptBlock = concept ? `
    <div style="margin: 24px 0; padding: 24px; border-radius: 16px; background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);">
      <div style="font-size: 11px; font-weight: 700; color: #78350f; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px;">🎬 Avi's take today</div>
      <div style="font-size: 16px; color: #451a03; line-height: 1.7; font-style: italic;">"${concept.hook || concept.title || ''}"</div>
      <div style="font-size: 14px; color: #78350f; line-height: 1.6; margin-top: 12px;">${concept.punchline || ''}</div>
    </div>
  ` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>The 8 AM AI brief — ${today}</title>
</head>
<body style="margin: 0; padding: 0; background: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111827;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <div style="text-align: center; margin-bottom: 32px;">
      <div style="font-size: 14px; color: #6b7280; margin-bottom: 8px;">${today}</div>
      <div style="font-size: 28px; font-weight: 800; background: linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%); -webkit-background-clip: text; background-clip: text; color: transparent; margin-bottom: 8px;">The 8 AM AI brief</div>
      <div style="font-size: 13px; color: #9ca3af;">3 tools · 2 stories · 1 take</div>
    </div>

    ${tools.length > 0 ? `
      <div style="margin: 32px 0 16px;">
        <div style="font-size: 13px; font-weight: 700; color: #111827; text-transform: uppercase; letter-spacing: 1px;">📦 New AI tools today</div>
      </div>
      ${toolBlocks}
    ` : ''}

    ${signals.length > 0 ? `
      <div style="margin: 32px 0 16px;">
        <div style="font-size: 13px; font-weight: 700; color: #111827; text-transform: uppercase; letter-spacing: 1px;">📰 What everyone's talking about</div>
      </div>
      ${signalBlocks}
    ` : ''}

    ${conceptBlock}

    <div style="margin: 48px 0 24px; text-align: center;">
      <a href="${SITE_URL}" style="display: inline-block; padding: 12px 24px; background: #111827; color: white; text-decoration: none; border-radius: 12px; font-size: 14px; font-weight: 500;">Browse all 10,000+ AI tools →</a>
    </div>

    <div style="margin-top: 48px; padding-top: 24px; border-top: 1px solid #e5e7eb; text-align: center; font-size: 12px; color: #9ca3af; line-height: 1.6;">
      You're getting this because you signed up at <a href="${SITE_URL}" style="color: #6b7280;">EverythinInAI</a>.<br>
      <a href="${unsubUrl}" style="color: #9ca3af; text-decoration: underline;">Unsubscribe</a> · sent every weekday at 8 AM IST
    </div>

  </div>
</body>
</html>`;
}

// ─── Send via Resend ───────────────────────────────────────────────────────

async function sendOne(toEmail, subject, html) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY missing — get one at https://resend.com/api-keys');

  const r = await axios.post('https://api.resend.com/emails', {
    from: RESEND_FROM,
    to: [toEmail],
    subject,
    html,
  }, {
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
  });
  return r.data?.id || null;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const db = dbModule.getClient();

  log.info(`Building today's digest...`);
  const data = await buildDigest();
  log.info(`  tools: ${data.tools.length}, signals: ${data.signals.length}, concept: ${data.concept ? 'yes' : 'no'}`);

  if (data.tools.length === 0 && data.signals.length === 0 && !data.concept) {
    log.warn(`Nothing to send today (no new tools, signals, or concept). Skipping.`);
    return;
  }

  // Get subscribers
  let subscribers;
  if (args.singleTo) {
    subscribers = [{ email: args.singleTo }];
  } else {
    const { data: subs } = await db
      .from('newsletter_subscribers')
      .select('email')
      .eq('is_unsubscribed', false);
    subscribers = subs || [];
  }
  log.info(`Sending to ${subscribers.length} subscriber(s)`);

  if (subscribers.length === 0) {
    log.info(`No active subscribers. Done.`);
    return;
  }

  if (args.dryRun) {
    const html = buildHtml(data, 'preview@example.com');
    log.info(`DRY RUN — html length: ${html.length}`);
    log.info(html.substring(0, 800) + '...');
    return;
  }

  const subject = `🌅 ${data.tools.length} new AI tools today + 1 take from Avi`;

  let sent = 0;
  let failed = 0;
  for (const sub of subscribers) {
    try {
      const html = buildHtml(data, sub.email);
      const messageId = await sendOne(sub.email, subject, html);
      log.info(`  ✓ ${sub.email}  msg=${messageId || '?'}`);
      sent++;

      // Update last_sent_at
      await db.from('newsletter_subscribers')
        .update({ last_sent_at: new Date().toISOString() })
        .eq('email', sub.email);

      // Resend free tier: 100/sec — be safe with 200ms delay
      await new Promise(r => setTimeout(r, 250));
    } catch (err) {
      failed++;
      log.warn(`  ✗ ${sub.email}: ${err.response?.data?.message || err.message}`);
    }
  }

  log.info(`══════════════════════════════════════════════`);
  log.info(`✓ Digest send complete.`);
  log.info(`   Sent:   ${sent}`);
  log.info(`   Failed: ${failed}`);
  log.info(`══════════════════════════════════════════════`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
