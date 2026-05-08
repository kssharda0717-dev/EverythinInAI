/**
 * EverythinInAI — Newsletter Signup API (Vercel Serverless Function)
 *
 * POST /api/newsletter
 *   body: { email: string }
 *
 * Writes the email to a `newsletter_subscribers` table in Supabase.
 * Returns 200 even on duplicate (idempotent UX).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!EMAIL_RX.test(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'Supabase env vars missing' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

    // Insert; ignore duplicate-key errors so the user sees success either way
    const { error } = await supabase
      .from('newsletter_subscribers')
      .insert({ email, source: 'website' });

    if (error && !error.message.includes('duplicate')) {
      console.warn('[newsletter] insert error:', error.message);
    }

    return res.status(200).json({ ok: true, message: "You're in. Daily AI digest comes at 8 AM IST." });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
