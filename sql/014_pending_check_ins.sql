-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 014: pending_check_ins
-- ═══════════════════════════════════════════════════════════════════════════
-- Stores the list of reels the weekly_stats_announcer is currently waiting
-- on. The /weekly_stats parser reads this to match position numbers back
-- to concept_ids without forcing the user to type UUIDs.

CREATE TABLE IF NOT EXISTS pending_check_ins (
  key         text PRIMARY KEY,         -- e.g., 'weekly_stats_2026-05-18'
  items       jsonb NOT NULL,            -- array of { calendar_id, concept_id, title, framework, duration }
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_check_ins_created
  ON pending_check_ins(created_at DESC);

-- ─── SECURITY FUTURE-PROOFING (EXPLICIT GRANTS) ──────────────────────────────
-- Required for Supabase Data API changes (May/Oct 2026)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pending_check_ins TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- Reload the PostgREST schema cache
NOTIFY pgrst, 'reload schema';
