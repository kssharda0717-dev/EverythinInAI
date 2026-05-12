-- Migration 020: HOTFIX - Add missing content_type column to reel_concepts
-- 
-- The 3-stream refactor (tech/lure/lifestyle) introduced content_type in
-- run_daily.js but never migrated the schema. This blocks all ideation runs
-- with: "Could not find the 'content_type' column of 'reel_concepts'"

ALTER TABLE reel_concepts
  ADD COLUMN IF NOT EXISTS content_type text DEFAULT 'tech_reel'
    CHECK (content_type IN ('tech_reel', 'lure_photo', 'lifestyle_reel'));

CREATE INDEX IF NOT EXISTS idx_reel_concepts_content_type
  ON reel_concepts(content_type, target_date DESC);

-- Backfill historical rows: anything before today defaults to tech_reel
-- (since that's all we were generating before the 3-stream refactor)
UPDATE reel_concepts
SET content_type = 'tech_reel'
WHERE content_type IS NULL;
