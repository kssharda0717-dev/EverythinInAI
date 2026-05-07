-- ═══════════════════════════════════════════════════════════════════════════════
-- EverythinInAI — Persona Schema
--
-- Stores avatar identity (DNA) used by every downstream content component:
-- ideation, image generation, face-swap, voice TTS, caption writing, etc.
--
-- One row per persona. Currently we have ONE persona ("Avi"), but the schema
-- supports multiple if you ever launch a second avatar.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS personas (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug            TEXT UNIQUE NOT NULL,        -- 'avi'
    is_active       BOOLEAN DEFAULT TRUE,

    -- Identity
    display_name    TEXT NOT NULL,               -- 'Avi'
    full_name       TEXT NOT NULL,               -- 'Avi Sharma'
    handle          TEXT NOT NULL,               -- '@avi.in.ai'
    age             INTEGER,
    location        TEXT,
    bio_short       TEXT NOT NULL,               -- IG bio
    bio_long        TEXT,                        -- backstory for prompt context

    -- Visual DNA
    visual_descriptor    TEXT NOT NULL,          -- detailed physical description (used in every image prompt)
    canonical_face_url   TEXT,                   -- Supabase Storage URL of locked face
    face_seed_id         TEXT,                   -- InsightFace embedding ID
    aesthetic_anchors    TEXT[] DEFAULT '{}',    -- ['beige', 'forest green', 'ribbed', 'studio lighting']
    signature_gestures   TEXT[] DEFAULT '{}',    -- ['adjusts glasses', 'tilts head', 'sips matcha']
    forbidden_visuals    TEXT[] DEFAULT '{}',    -- ['party scene', 'religious imagery', 'children']

    -- Voice DNA
    voice_descriptor     TEXT,                   -- 'warm, dryly funny, slight Hindi inflection'
    voice_provider       TEXT DEFAULT 'elevenlabs',
    voice_id             TEXT,                   -- ElevenLabs voice_id
    voice_settings       JSONB DEFAULT '{}',     -- stability, style, etc.

    -- Narrative voice
    tone                 TEXT NOT NULL,          -- 'calm, confident, dryly funny, intellectually warm'
    catchphrases         TEXT[] DEFAULT '{}',    -- ['yaar this is unhinged', 'okay but actually']
    forbidden_phrases    TEXT[] DEFAULT '{}',    -- ['hey guys', 'OMG', 'literally', 'bestie']
    code_switch_rules    TEXT,                   -- 'Hindi-English mix, ~20% Hindi loanwords used naturally'

    -- Content strategy
    primary_topics       TEXT[] DEFAULT '{}',    -- ['ai_tools', 'ai_news', 'research', 'industry_drama']
    avoid_topics         TEXT[] DEFAULT '{}',    -- ['politics', 'religion', 'crypto_promotion']
    target_audience      TEXT,                   -- 'devs, founders, AI-curious 22-40'
    posting_cadence      JSONB DEFAULT '{}',     -- {reels_per_week, lure_ratio, etc.}

    -- Lure-mix policy
    -- 1 = pure educational, 5 = full thirst-trap (we cap Avi at 3)
    max_lure_level       INTEGER DEFAULT 3 CHECK (max_lure_level BETWEEN 1 AND 5),
    weekly_lure_quota    INTEGER DEFAULT 2,      -- max # of lure>=3 reels per 7 days

    -- Disclosure (legal)
    is_synthetic         BOOLEAN DEFAULT TRUE,
    disclosure_text      TEXT DEFAULT 'AI Creator',
    watermark_text       TEXT DEFAULT '© AI-generated · everythinginai.com',

    -- System prompt block — injected into every Gemini call about this persona
    system_prompt        TEXT NOT NULL,

    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_personas_active ON personas (is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_personas_slug ON personas (slug);

-- RLS: persona profiles are readable by anon (public) so the frontend can show "About Avi"
ALTER TABLE personas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS personas_public_read ON personas;
CREATE POLICY personas_public_read ON personas FOR SELECT USING (is_active = TRUE);

SELECT 'persona schema applied' AS status,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'personas') AS exists;
