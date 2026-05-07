/**
 * EverythinInAI — Frontend Supabase Client
 *
 * Direct browser → Supabase reads using the anon (public) key.
 * Row Level Security (RLS) policy `tools_public_read` on the `tools`
 * table restricts access to `is_active = true` rows only.
 *
 * Writes (e.g. /api/submit) still go through the Node API server
 * because they require the service_role key which must never be in the browser.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let _client: SupabaseClient | null = null;

/**
 * Singleton Supabase client. Returns null if env vars are missing,
 * which lets the hooks fall back to mock data gracefully.
 */
export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (!_client) {
    _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _client;
}

/**
 * Generic fetch helper for the legacy /api routes.
 * Used only by submitTool() — all reads now go through Supabase directly.
 */
export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}
