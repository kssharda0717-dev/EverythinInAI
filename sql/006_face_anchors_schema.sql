-- ═══════════════════════════════════════════════════════════════════════════════
-- EverythinInAI — Face Anchors Schema
--
-- Stores candidate "canonical face" portraits we generate for each persona.
-- One persona may have many candidates; exactly ONE is marked is_chosen=TRUE
-- and that URL becomes the immutable identity reference for every future
-- face-locked render (PuLID-Flux conditioning image).
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS face_anchors (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    persona_id      UUID NOT NULL REFERENCES personas(id) ON DELETE CASCADE,

    -- The actual portrait
    image_url       TEXT NOT NULL,            -- public Supabase Storage URL
    storage_path    TEXT NOT NULL,            -- 'face-anchors/avi/{uuid}.webp'

    -- Generation metadata
    model           TEXT NOT NULL,            -- 'flux-1.1-pro'
    prompt          TEXT NOT NULL,
    seed            BIGINT,
    width           INTEGER,
    height          INTEGER,
    cost_usd        NUMERIC(10, 4) DEFAULT 0,

    -- Selection
    is_chosen       BOOLEAN DEFAULT FALSE,
    chosen_at       TIMESTAMPTZ,
    chosen_by       TEXT,                     -- 'kartik' / 'auto'

    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_face_anchors_persona ON face_anchors (persona_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_face_anchors_one_chosen_per_persona
    ON face_anchors (persona_id) WHERE is_chosen = TRUE;

-- Public read so the frontend "About Avi" can show her portrait
ALTER TABLE face_anchors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS face_anchors_public_read ON face_anchors;
CREATE POLICY face_anchors_public_read ON face_anchors FOR SELECT USING (TRUE);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Reel keyframe outputs — generated images per Reel concept
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS reel_keyframes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    concept_id      UUID NOT NULL REFERENCES reel_concepts(id) ON DELETE CASCADE,
    keyframe_idx    INTEGER NOT NULL,         -- 0-based order in the Reel

    -- Image
    image_url       TEXT NOT NULL,
    storage_path    TEXT NOT NULL,

    -- Source data
    scene_caption   TEXT,                     -- on-screen subtitle for this keyframe
    prompt          TEXT NOT NULL,
    duration_ms     INTEGER DEFAULT 7500,

    -- Generation
    model           TEXT NOT NULL,            -- 'flux-1.1-pro' / 'flux-schnell' / 'flux-pulid'
    is_face_locked  BOOLEAN DEFAULT FALSE,
    seed            BIGINT,
    cost_usd        NUMERIC(10, 4) DEFAULT 0,
    generation_ms   INTEGER DEFAULT 0,

    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_keyframes_concept ON reel_keyframes (concept_id, keyframe_idx);

ALTER TABLE reel_keyframes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reel_keyframes_public_read ON reel_keyframes;
CREATE POLICY reel_keyframes_public_read ON reel_keyframes FOR SELECT USING (TRUE);

-- ─── SECURITY FUTURE-PROOFING (EXPLICIT GRANTS) ──────────────────────────────
-- Required for Supabase Data API changes (May/Oct 2026)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE face_anchors TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reel_keyframes TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- Reload the PostgREST schema cache
NOTIFY pgrst, 'reload schema';

SELECT 'face anchors + keyframes schema applied' AS status,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('face_anchors','reel_keyframes')) AS tables_created;
