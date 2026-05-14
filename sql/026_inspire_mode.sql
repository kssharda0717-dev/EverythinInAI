-- Migration 026: Inspire Mode
--
-- Adds support for /inspire — a weekend mode where the user forwards a
-- reference Instagram reel (URL or video) and the system renders a Rhea
-- version of the same vibe with Pruna lipsync to the original audio.
--
-- Steps:
--   1. Widen the weekend_mode CHECK constraint to allow 'inspire'.
--   2. Add inspire-specific columns on content_calendar.
--   3. Add a partial index for the lifestyle worker query.
--   4. Reuse the existing pending_audio_uploads table — its weekend_mode
--      column is plain text (no CHECK), so 'inspire' is supported as-is.

-- 1. Widen the weekend_mode CHECK to allow 'inspire'
ALTER TABLE content_calendar
  DROP CONSTRAINT IF EXISTS content_calendar_weekend_mode_check;

ALTER TABLE content_calendar
  ADD CONSTRAINT content_calendar_weekend_mode_check
    CHECK (weekend_mode IS NULL OR weekend_mode IN ('home', 'travel', 'dance', 'inspire'));

-- 2. Add inspire-specific columns
ALTER TABLE content_calendar
  ADD COLUMN IF NOT EXISTS inspire_video_url     text,
  ADD COLUMN IF NOT EXISTS inspire_audio_url     text,
  ADD COLUMN IF NOT EXISTS inspire_analysis_json jsonb,
  ADD COLUMN IF NOT EXISTS inspire_source_label  text;

-- 3. Partial index so the lifestyle worker can quickly filter inspire rows
CREATE INDEX IF NOT EXISTS idx_content_calendar_inspire
  ON content_calendar(weekend_mode)
  WHERE weekend_mode = 'inspire';

-- ─── SECURITY FUTURE-PROOFING (EXPLICIT GRANTS) ──────────────────────────────
-- Required for Supabase Data API changes (May/Oct 2026)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE content_calendar TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- Reload the PostgREST schema cache
NOTIFY pgrst, 'reload schema';
