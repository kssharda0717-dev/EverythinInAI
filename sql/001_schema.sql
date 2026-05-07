-- ═══════════════════════════════════════════════════════════════════════════════
-- EverythinInAI Discovery Engine — Database Schema
-- Run this in Supabase SQL Editor (or any PostgreSQL instance)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- Fuzzy text matching
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- UUID generation

-- ─── TOOLS TABLE ─────────────────────────────────────────────────────────────
-- The core directory. Every confirmed AI tool lives here.
CREATE TABLE IF NOT EXISTS tools (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug            TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    name_lower      TEXT GENERATED ALWAYS AS (LOWER(TRIM(name))) STORED,
    tagline         TEXT DEFAULT '',
    description     TEXT DEFAULT '',
    url             TEXT NOT NULL,
    url_normalized  TEXT GENERATED ALWAYS AS (
        LOWER(REGEXP_REPLACE(REGEXP_REPLACE(url, '/$', ''), '^https?://(www\.)?', ''))
    ) STORED,
    category        TEXT DEFAULT 'Other',
    tags            TEXT[] DEFAULT '{}',
    pricing         TEXT DEFAULT 'unknown',
    source          TEXT NOT NULL,
    source_url      TEXT DEFAULT '',
    confidence      REAL DEFAULT 0.0,
    upvotes         INTEGER DEFAULT 0,
    author          TEXT DEFAULT '',
    homepage        TEXT DEFAULT '',
    language        TEXT DEFAULT '',
    topics          TEXT[] DEFAULT '{}',
    published_at    TIMESTAMPTZ DEFAULT NOW(),
    added_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    run_id          TEXT DEFAULT '',
    is_active       BOOLEAN DEFAULT TRUE
);

-- Indexes for deduplication and search
CREATE INDEX IF NOT EXISTS idx_tools_url_normalized ON tools (url_normalized);
CREATE INDEX IF NOT EXISTS idx_tools_name_lower ON tools (name_lower);
CREATE INDEX IF NOT EXISTS idx_tools_name_trgm ON tools USING gin (name_lower gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_tools_category ON tools (category);
CREATE INDEX IF NOT EXISTS idx_tools_added_at ON tools (added_at DESC);
CREATE INDEX IF NOT EXISTS idx_tools_slug ON tools (slug);

-- ─── DISCOVERY QUEUE TABLE ───────────────────────────────────────────────────
-- Raw items waiting for Gemini classification.
-- State machine: pending → processing → classified → merged | rejected
CREATE TABLE IF NOT EXISTS discovery_queue (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_title       TEXT NOT NULL,
    raw_description TEXT DEFAULT '',
    url             TEXT NOT NULL,
    url_normalized  TEXT GENERATED ALWAYS AS (
        LOWER(REGEXP_REPLACE(REGEXP_REPLACE(url, '/$', ''), '^https?://(www\.)?', ''))
    ) STORED,
    source          TEXT NOT NULL,
    source_url      TEXT DEFAULT '',
    upvotes         INTEGER DEFAULT 0,
    comments        INTEGER DEFAULT 0,
    author          TEXT DEFAULT '',
    homepage        TEXT DEFAULT '',
    language        TEXT DEFAULT '',
    topics          TEXT[] DEFAULT '{}',
    published_at    TIMESTAMPTZ DEFAULT NOW(),
    heuristic_score INTEGER DEFAULT 0,
    score_reasons   TEXT[] DEFAULT '{}',
    status          TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'classified', 'merged', 'rejected', 'error')),
    gemini_response JSONB DEFAULT NULL,
    error_message   TEXT DEFAULT '',
    batch_id        TEXT DEFAULT '',
    run_id          TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    processed_at    TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON discovery_queue (status);
CREATE INDEX IF NOT EXISTS idx_queue_url_normalized ON discovery_queue (url_normalized);
CREATE INDEX IF NOT EXISTS idx_queue_run_id ON discovery_queue (run_id);
CREATE INDEX IF NOT EXISTS idx_queue_score ON discovery_queue (heuristic_score DESC);

-- ─── RUNS TABLE ──────────────────────────────────────────────────────────────
-- Tracks each execution of the discovery engine.
-- Enables checkpointing and crash recovery.
CREATE TABLE IF NOT EXISTS runs (
    id              TEXT PRIMARY KEY,
    mode            TEXT NOT NULL CHECK (mode IN ('incremental', 'backfill')),
    state           TEXT DEFAULT 'init'
                    CHECK (state IN ('init', 'collecting', 'normalizing', 'filtering',
                                     'classifying', 'merging', 'committing', 'done', 'failed')),
    since_timestamp BIGINT DEFAULT 0,
    until_timestamp BIGINT DEFAULT 0,
    items_collected INTEGER DEFAULT 0,
    items_filtered  INTEGER DEFAULT 0,
    items_classified INTEGER DEFAULT 0,
    items_merged    INTEGER DEFAULT 0,
    items_rejected  INTEGER DEFAULT 0,
    error_log       TEXT[] DEFAULT '{}',
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ DEFAULT NULL,
    checkpoint      JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_runs_state ON runs (state);
CREATE INDEX IF NOT EXISTS idx_runs_mode ON runs (mode);

-- ─── BACKFILL PROGRESS TABLE ─────────────────────────────────────────────────
-- Tracks monthly chunks for the 3-year cold start.
CREATE TABLE IF NOT EXISTS backfill_progress (
    id              SERIAL PRIMARY KEY,
    year_month      TEXT UNIQUE NOT NULL,  -- e.g., '2023-01'
    source          TEXT NOT NULL,         -- e.g., 'hacker_news', 'github', 'all'
    status          TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
    items_found     INTEGER DEFAULT 0,
    items_processed INTEGER DEFAULT 0,
    run_id          TEXT DEFAULT '',
    started_at      TIMESTAMPTZ DEFAULT NULL,
    completed_at    TIMESTAMPTZ DEFAULT NULL,
    error_message   TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_backfill_status ON backfill_progress (status);
CREATE INDEX IF NOT EXISTS idx_backfill_yearmonth ON backfill_progress (year_month);

-- ─── DEDUPLICATION FUNCTION ──────────────────────────────────────────────────
-- Server-side fuzzy name matching using trigram similarity.
-- Returns TRUE if a tool with a similar name already exists.
CREATE OR REPLACE FUNCTION check_fuzzy_duplicate(
    p_name TEXT,
    p_url_normalized TEXT,
    p_threshold REAL DEFAULT 0.7
)
RETURNS TABLE(is_duplicate BOOLEAN, matched_id UUID, matched_name TEXT, similarity REAL) AS $$
BEGIN
    -- First: exact URL match (fastest)
    RETURN QUERY
    SELECT TRUE, t.id, t.name, 1.0::REAL
    FROM tools t
    WHERE t.url_normalized = p_url_normalized
    LIMIT 1;

    IF FOUND THEN RETURN; END IF;

    -- Second: trigram similarity on name
    RETURN QUERY
    SELECT TRUE, t.id, t.name, similarity(t.name_lower, LOWER(TRIM(p_name)))::REAL
    FROM tools t
    WHERE similarity(t.name_lower, LOWER(TRIM(p_name))) > p_threshold
    ORDER BY similarity(t.name_lower, LOWER(TRIM(p_name))) DESC
    LIMIT 1;

    IF FOUND THEN RETURN; END IF;

    -- No duplicate found
    RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, 0.0::REAL;
END;
$$ LANGUAGE plpgsql;

-- ─── JSON EXPORT VIEW ────────────────────────────────────────────────────────
-- For backwards compatibility: generates the same JSON structure as data.json
CREATE OR REPLACE VIEW tools_json_export AS
SELECT json_build_object(
    'metadata', json_build_object(
        'lastUpdated', NOW(),
        'totalTools', (SELECT COUNT(*) FROM tools WHERE is_active = TRUE),
        'version', '2.0.0'
    ),
    'tools', COALESCE(
        (SELECT json_agg(
            json_build_object(
                'id', slug,
                'name', name,
                'tagline', tagline,
                'description', description,
                'url', url,
                'category', category,
                'tags', tags,
                'pricing', pricing,
                'source', source,
                'addedAt', added_at,
                'updatedAt', updated_at
            ) ORDER BY added_at DESC
        ) FROM tools WHERE is_active = TRUE),
        '[]'::json
    )
) AS export_json;
