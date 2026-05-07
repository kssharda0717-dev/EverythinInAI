-- ═══════════════════════════════════════════════════════════════════════════════
-- EverythinInAI — Reel Concepts Schema
--
-- The "ideation engine" produces multiple draft Reel concepts per day. The user
-- (or auto-picker) selects one, which then flows downstream:
--   draft → approved → image_generating → voicing → assembling → ready → posted
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS reel_concepts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Which persona this concept belongs to
    persona_id      UUID NOT NULL REFERENCES personas(id) ON DELETE CASCADE,

    -- Which signal seeded this concept (NULL allowed for evergreen / topic-driven)
    signal_id       UUID REFERENCES ai_signals(id) ON DELETE SET NULL,

    -- Day the concept was generated for (one "winner" per day, but we keep all drafts)
    target_date     DATE NOT NULL,

    -- Lifecycle state
    state           TEXT NOT NULL DEFAULT 'draft' CHECK (state IN
        ('draft', 'approved', 'rejected',
         'image_generating', 'voicing', 'assembling',
         'ready', 'posted', 'failed')),

    -- Was this the chosen winner for this date?
    is_winner       BOOLEAN DEFAULT FALSE,

    -- Concept content (what Gemini drafted)
    title           TEXT NOT NULL,            -- working title for review
    hook            TEXT NOT NULL,            -- first 2 seconds spoken
    body_script     TEXT NOT NULL,            -- 15-20 sec spoken body
    punchline       TEXT NOT NULL,            -- closing 5-8 sec + CTA
    full_script     TEXT NOT NULL,            -- concatenation for TTS
    estimated_seconds INTEGER DEFAULT 30,

    -- Visual plan (3-5 keyframes)
    keyframes       JSONB DEFAULT '[]',       -- [{idx, prompt, scene_caption, duration_ms}]

    -- Caption + meta
    caption         TEXT NOT NULL,
    hashtags        TEXT[] DEFAULT '{}',
    cta             TEXT,                     -- 'comment LINK', 'follow for more', etc.

    -- Lure level chosen for this concept (1-4 max)
    lure_level      INTEGER DEFAULT 2 CHECK (lure_level BETWEEN 1 AND 5),
    angle           TEXT,                     -- 'hot_take' / 'explainer' / 'humor' / 'reaction'

    -- Generation metadata
    model           TEXT DEFAULT '',          -- gemini-2.5-flash
    prompt_tokens   INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,

    -- Downstream artifact references (filled in later phases)
    image_urls      TEXT[] DEFAULT '{}',
    voice_url       TEXT,
    video_url       TEXT,

    -- Posting outcome (filled when posted)
    posted_at       TIMESTAMPTZ,
    posted_url      TEXT,
    instagram_post_id TEXT,
    metrics_24h     JSONB DEFAULT '{}',       -- {views, likes, comments, shares, saves}

    -- Failure / rejection notes
    error_reason    TEXT,

    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reel_concepts_persona_date ON reel_concepts (persona_id, target_date DESC);
CREATE INDEX IF NOT EXISTS idx_reel_concepts_state ON reel_concepts (state) WHERE state NOT IN ('posted', 'failed', 'rejected');
CREATE INDEX IF NOT EXISTS idx_reel_concepts_winner ON reel_concepts (target_date, is_winner) WHERE is_winner = TRUE;
CREATE INDEX IF NOT EXISTS idx_reel_concepts_signal ON reel_concepts (signal_id) WHERE signal_id IS NOT NULL;

-- One winner per persona per day
CREATE UNIQUE INDEX IF NOT EXISTS uq_reel_concepts_one_winner_per_day
    ON reel_concepts (persona_id, target_date)
    WHERE is_winner = TRUE;

-- RLS: read-only for anon (so the frontend can show "today's concepts")
ALTER TABLE reel_concepts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reel_concepts_public_read ON reel_concepts;
CREATE POLICY reel_concepts_public_read ON reel_concepts FOR SELECT USING (TRUE);

SELECT 'reel_concepts schema applied' AS status,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'reel_concepts') AS exists;
