-- ═══════════════════════════════════════════════════════════════════════════════
-- EverythinInAI — Content Calendar + Render Runs
--
-- Tracks: what was scheduled to render each day, what got picked, and the final
-- output URL. Hard daily-cap is enforced via a UNIQUE index on (day, content_type).
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS content_calendar (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    target_date     DATE NOT NULL,
    weekday         INT  NOT NULL,                       -- 0 = Sunday … 6 = Saturday
    content_type    TEXT NOT NULL,                       -- 'tech_reel' | 'lure_photo' | 'lifestyle_reel'
    state           TEXT NOT NULL DEFAULT 'pending',     -- pending | picked | rendering | done | failed
    concept_id      UUID,                                -- references reel_concepts.id (for tech reels)
    picked_at       TIMESTAMPTZ,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    output_url      TEXT,                                -- final MP4 or JPG URL
    caption         TEXT,                                -- caption to copy-paste to IG
    hashtags        TEXT,                                -- hashtags to copy-paste
    cost_usd        NUMERIC(10, 4) DEFAULT 0,
    error_message   TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (target_date, content_type)                   -- HARD CAP: max 1 of each type per day
);

CREATE INDEX IF NOT EXISTS idx_calendar_state ON content_calendar (state);
CREATE INDEX IF NOT EXISTS idx_calendar_date  ON content_calendar (target_date DESC);

-- Track render runs (each step in the pipeline)
CREATE TABLE IF NOT EXISTS render_steps (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    calendar_id     UUID REFERENCES content_calendar(id) ON DELETE CASCADE,
    step_name       TEXT NOT NULL,                       -- hero | voice | lipsync | engagement | done
    status          TEXT NOT NULL DEFAULT 'running',     -- running | done | failed
    output          JSONB,
    cost_usd        NUMERIC(10, 4) DEFAULT 0,
    duration_ms     INT,
    error_message   TEXT,
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_steps_calendar ON render_steps (calendar_id);

-- ─── SECURITY FUTURE-PROOFING (EXPLICIT GRANTS) ──────────────────────────────
-- Required for Supabase Data API changes (May/Oct 2026)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE content_calendar TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE render_steps TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- Reload the PostgREST schema cache
NOTIFY pgrst, 'reload schema';

SELECT 'content calendar schema applied' AS status,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('content_calendar','render_steps')) AS tables_created;
