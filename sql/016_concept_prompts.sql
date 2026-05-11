-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 016: Add dynamic prompt columns to reel_concepts
-- ═══════════════════════════════════════════════════════════════════════════
-- These columns store the LLM-generated visual prompts so the lure_photo and
-- lifestyle workers don't need to hardcode scenes anymore. The drafter now
-- generates the entire prompt and the workers just execute it.

ALTER TABLE reel_concepts
  ADD COLUMN IF NOT EXISTS image_prompt    text,    -- for lure photo posts
  ADD COLUMN IF NOT EXISTS keyframe_prompt text,    -- for lifestyle action videos (starting frame)
  ADD COLUMN IF NOT EXISTS motion_prompt   text,    -- for lifestyle action videos (Kling animation prompt)
  ADD COLUMN IF NOT EXISTS music_mood      text;    -- 'upbeat' | 'calm' | 'energetic'
