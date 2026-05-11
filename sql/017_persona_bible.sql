-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 017: Add bible_md to personas
-- ═══════════════════════════════════════════════════════════════════════════
-- Stores the rich markdown persona bible (backstory, aesthetic, goals) directly
-- on the persona record so it can be injected into the concept_drafter LLM prompt.

ALTER TABLE personas
  ADD COLUMN IF NOT EXISTS bible_md text;
