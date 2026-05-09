/**
 * EverythinInAI — Unsubscribe Endpoint (Phase 16)
 *
 * GET /api/unsubscribe?email=foo@bar.com&token=<24-char-hmac>
 *
 * Verifies the HMAC token, marks the subscriber as unsubscribed in Supabase,
 * and returns a tiny HTML confirmation page.
 *
 * Token format: first 24 chars of HMAC-SHA256(UNSUBSCRIBE_SECRET, email.toLowerCase())
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

function makeToken(email: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(email.toLowerCase()).digest('hex').slice(0, 24);
}

function html(message: string, ok: boolean): string {
  const color = ok ? '#10b981' : '#ef4444';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Unsubscribe</title>
<style>
  body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f9fafb; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { max-width: 480px; padding: 40px 32px; background: white; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.06); text-align: center; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: ${color}; margin: 0 auto 16px; }
  h1 { font-size: 22px; margin: 0 0 12px; color: #111827; }
  p { font-size: 14px; color: #4b5563; line-height: 1.7; margin: 0; }
  a { color: #3b82f6; text-decoration: none; }
</style>
</head><body>
<div class="card">
  <div class="dot"></div>
  <h1>${ok ? "You're unsubscribed" : "Couldn't unsubscribe"}</h1>
  <p>${message}</p>
  <p style="margin-top: 24px;"><a href="https://everythin-in-ai-iug3.vercel.app">← Back to EverythinInAI</a></p>
</div>
</body></html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).send('GET only');

  const email = String(req.query.email || '').trim().toLowerCase();
  const token = String(req.query.token || '').trim();

  if (!email || !token) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(html('Missing email or token in the link.', false));
  }

  const secret = process.env.UNSUBSCRIBE_SECRET || process.env.RESEND_API_KEY || 'change-me';
  const expected = makeToken(email, secret);
  if (token !== expected) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(html('That unsubscribe link looks tampered with. Please contact support.', false));
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(html('Server is misconfigured. Try again later.', false));
  }

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
  const { error } = await supabase
    .from('newsletter_subscribers')
    .update({ is_unsubscribed: true })
    .eq('email', email);

  res.setHeader('Content-Type', 'text/html');
  if (error) {
    return res.status(500).send(html(`Couldn't unsubscribe: ${error.message}`, false));
  }
  return res.status(200).send(html(`You won't receive any more digests at ${email}. Take care.`, true));
}
