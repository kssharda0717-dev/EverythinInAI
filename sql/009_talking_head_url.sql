-- ═══════════════════════════════════════════════════════════════════════════════
-- EverythinInAI — Add talking_head_url column to reel_concepts
--
-- Stores the raw OmniHuman lip-synced MP4 (pre-engagement-edit), separate from
-- video_url which holds the final captioned/edited MP4. This lets the
-- engagement editor re-run without double-processing.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE reel_concepts
    ADD COLUMN IF NOT EXISTS talking_head_url TEXT;

-- Migrate existing data: if video_url is set but talking_head_url isn't,
-- assume the existing video_url IS the raw talking-head (this isn't quite right
-- since we already added captions, but we'll re-render anyway). Skip migration.

SELECT 'talking_head_url column added' AS status;
