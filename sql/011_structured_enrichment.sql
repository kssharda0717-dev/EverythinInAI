-- ═══════════════════════════════════════════════════════════════════════════════
-- EverythinInAI — Structured Enrichment Columns
--
-- Adds rich, structured product info so the drawer can render Pros / Cons /
-- Use Cases sections instead of a wall of text.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE tools
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS search_aliases TEXT[] DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS use_cases TEXT[] DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS key_features TEXT[] DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS pros TEXT[] DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS cons TEXT[] DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS best_for TEXT;

-- Trigram extension for fuzzy + alias search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_tools_aliases_gin ON tools USING GIN (search_aliases);

SELECT 'structured enrichment schema applied' AS status;
