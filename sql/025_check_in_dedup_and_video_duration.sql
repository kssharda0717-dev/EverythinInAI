-- Migration 025: Two analytics-pipeline columns
--
-- (A) content_calendar.check_in_alerted_at
--     Marks when the 48h check-in cron sent a Telegram message for this row,
--     so the same reel doesn't get re-pinged every hour for 4 hours straight
--     while the user hasn't replied with stats yet.
--
-- (B) reel_concepts.video_duration
--     The ACTUAL rendered duration of the final mp4 (in seconds), populated
--     by video_worker after the engagement edit completes. Replaces the
--     old fallback to estimated_seconds (LLM guess), which made the
--     reel_performance.retention_pct calculation wrong (it would cap at 100%
--     because LLM always estimated 12s but real renders ran 14-22s).

ALTER TABLE content_calendar
  ADD COLUMN IF NOT EXISTS check_in_alerted_at timestamptz;

ALTER TABLE reel_concepts
  ADD COLUMN IF NOT EXISTS video_duration numeric;

-- Index so the check-in cron can quickly filter on alerted_at IS NULL.
CREATE INDEX IF NOT EXISTS idx_content_calendar_check_in_pending
  ON content_calendar(posted_at)
  WHERE check_in_alerted_at IS NULL AND posted_at IS NOT NULL;

NOTIFY pgrst, 'reload schema';
