-- Migration 021: Topic History
--
-- Persists which TOPICS have been used in reels, surviving even when
-- the underlying reel_concepts row is deleted. Solves the bug where
-- the same paper (e.g. LightRAG) gets resuggested because:
--   1. The discovery scraper created multiple ai_signals rows for it (different IDs)
--   2. The original reel_concepts rows got wiped during debugging
--
-- Key fields:
--   - topic_key: a normalized identifier (lowercased, deduped slug or title)
--   - first_used_at / last_used_at: when this topic appeared in any reel
--   - usage_count: how many reels referenced this topic
--   - signal_ids: every ai_signals.id we've ever used for this topic
--                 (because the same topic can have many duplicate signals)

CREATE TABLE IF NOT EXISTS topic_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id      UUID NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  topic_key       text NOT NULL,                 -- normalized title or canonical slug
  display_title   text,                          -- human-readable
  signal_ids      uuid[] DEFAULT '{}',
  entities        text[] DEFAULT '{}',
  first_used_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz NOT NULL DEFAULT now(),
  usage_count     integer NOT NULL DEFAULT 1,
  UNIQUE (persona_id, topic_key)
);

CREATE INDEX IF NOT EXISTS idx_topic_history_persona ON topic_history(persona_id, last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_topic_history_signals ON topic_history USING gin(signal_ids);
