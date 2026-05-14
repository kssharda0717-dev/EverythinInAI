-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 008: reel_performance table
-- ═══════════════════════════════════════════════════════════════════════════
-- Tracks per-reel Instagram performance so the LLM can learn which viral
-- frameworks deliver the highest retention and reach.
--
-- The user submits these metrics via the /stats Telegram command.
-- concept_drafter.js queries this table to inject framework success rates
-- into the Gemini prompt, creating a self-improving content loop.

CREATE TABLE IF NOT EXISTS reel_performance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id      uuid NOT NULL REFERENCES reel_concepts(id) ON DELETE CASCADE,
  framework       text NOT NULL,    -- e.g. 'secret_weapon', 'industry_killer', 'i_tested_it', 'contrarian_truth', 'seamless_loop'
  views           integer NOT NULL DEFAULT 0,
  avg_watch_sec   numeric(6, 2) NOT NULL DEFAULT 0,   -- average watch time in seconds
  reel_duration   numeric(6, 2),                       -- duration of the reel itself, for retention % calculation
  likes           integer DEFAULT 0,
  comments        integer DEFAULT 0,
  shares          integer DEFAULT 0,
  saves           integer DEFAULT 0,
  followers_gained integer DEFAULT 0,
  notes           text,                                 -- optional free-text notes from user
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reel_performance_framework ON reel_performance(framework);
CREATE INDEX IF NOT EXISTS idx_reel_performance_concept   ON reel_performance(concept_id);
CREATE INDEX IF NOT EXISTS idx_reel_performance_recorded  ON reel_performance(recorded_at DESC);

-- Computed retention rate as a percentage
ALTER TABLE reel_performance
  ADD COLUMN IF NOT EXISTS retention_pct numeric(5, 2)
  GENERATED ALWAYS AS (
    CASE
      WHEN reel_duration > 0 THEN LEAST(100, (avg_watch_sec / reel_duration) * 100)
      ELSE 0
    END
  ) STORED;

-- ─── SECURITY FUTURE-PROOFING (EXPLICIT GRANTS) ──────────────────────────────
-- Required for Supabase Data API changes (May/Oct 2026)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reel_performance TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- Reload the PostgREST schema cache
NOTIFY pgrst, 'reload schema';
