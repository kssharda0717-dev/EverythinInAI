-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 018: Trending Formats + Travel Calendar
-- ═══════════════════════════════════════════════════════════════════════════
-- trending_formats: stores distilled format patterns (NOT topics) from viral
-- Instagram content per stream. The drafter injects these into prompts.
-- travel_calendar: stores Rhea's planned weekend adventures so lifestyle reels
-- can be set in the right location and reference the right activity.

CREATE TABLE IF NOT EXISTS trending_formats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream          text NOT NULL,                 -- 'tech' | 'lure' | 'lifestyle'
  pattern_type    text NOT NULL,                 -- 'hook_format' | 'edit_style' | 'aesthetic' | 'audio' | 'caption_style'
  pattern         text NOT NULL,                 -- the distilled pattern itself
  example         text,                          -- a concrete example
  source_count    integer DEFAULT 1,             -- how many viral posts this was derived from
  ingested_at     timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz                    -- patterns get stale; auto-prune after 14 days
);

CREATE INDEX IF NOT EXISTS idx_trending_formats_stream ON trending_formats(stream);
CREATE INDEX IF NOT EXISTS idx_trending_formats_recent ON trending_formats(ingested_at DESC);

CREATE TABLE IF NOT EXISTS travel_calendar (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  location        text NOT NULL,                 -- 'Goa', 'Lisbon', 'Coorg', 'Manali'
  vibe            text,                          -- 'beach', 'mountain', 'european_city', 'tropical_resort'
  planned_activities text[],                     -- ['surfing', 'beach yoga', 'sunset drive', 'cafe hopping']
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_travel_calendar_dates ON travel_calendar(start_date, end_date);
