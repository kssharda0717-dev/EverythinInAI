-- Migration 022: Weekend Mode + Dance Audio
-- Adds support for the Friday weekend nudge that lets the user pick:
--   home    : both Sat and Sun lifestyle reels are set in Bandra/Mumbai
--   travel  : both reels are set in the destination chosen via /travel
--   dance   : both reels are lip-synced dance reels with user-supplied audio
--
-- The user forwards an audio (Reel/video) to the bot, the bot extracts and
-- stores the audio, then the lifestyle worker uses Pruna to lip-sync Rhea's
-- mouth and movements to that audio.

ALTER TABLE content_calendar
  ADD COLUMN IF NOT EXISTS weekend_mode text
    CHECK (weekend_mode IN ('home', 'travel', 'dance')),
  ADD COLUMN IF NOT EXISTS dance_audio_url text,
  ADD COLUMN IF NOT EXISTS dance_audio_filename text;

CREATE INDEX IF NOT EXISTS idx_calendar_weekend_mode
  ON content_calendar(weekend_mode) WHERE weekend_mode IS NOT NULL;

-- Tracks pending audio uploads from the user. When user replies /dance, we
-- create a pending row with target_date set to the next Sat (or Sun for the
-- second audio). When they forward an audio, we resolve the next pending row.
CREATE TABLE IF NOT EXISTS pending_audio_uploads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id       bigint NOT NULL,
  for_date      date NOT NULL,
  weekend_mode  text NOT NULL DEFAULT 'dance',
  status        text NOT NULL DEFAULT 'awaiting' CHECK (status IN ('awaiting', 'received', 'cancelled')),
  audio_url     text,
  audio_filename text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_pending_audio_chat
  ON pending_audio_uploads(chat_id, status, created_at DESC);
