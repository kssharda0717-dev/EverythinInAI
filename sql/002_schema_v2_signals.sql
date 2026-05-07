-- ═══════════════════════════════════════════════════════════════════════════════
-- EverythinInAI Schema v2 — AI Signals Layer
--
-- Adds:
--   • ai_signals      — non-tool content (news, research, drama, funding, etc.)
--   • avatar_briefs   — content packages for the avatar pipeline
--   • signal_sources  — tracks which collectors fed which signals (analytics)
--   • engine_metrics  — per-run KPIs for observability
--
-- IMPORTANT: This script is purely ADDITIVE. It does not modify any existing
-- table or column. Safe to run on the live database while the engine is running.
-- Run it in Supabase SQL Editor.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── AI_SIGNALS TABLE ────────────────────────────────────────────────────────
-- Stores everything that ISN'T a tool but is still avatar fuel:
-- news, research papers, opinion pieces, drama, funding announcements, model launches.
CREATE TABLE IF NOT EXISTS ai_signals (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug            TEXT UNIQUE NOT NULL,

    -- The headline / title of the signal
    title           TEXT NOT NULL,
    title_lower     TEXT GENERATED ALWAYS AS (LOWER(TRIM(title))) STORED,

    -- One-line summary (AI-generated)
    summary         TEXT DEFAULT '',

    -- Longer narrative version (used by avatar caption generator)
    narrative       TEXT DEFAULT '',

    -- Where the signal points (article, paper, tweet, blog post)
    url             TEXT NOT NULL,
    url_normalized  TEXT GENERATED ALWAYS AS (
        LOWER(REGEXP_REPLACE(REGEXP_REPLACE(url, '/$', ''), '^https?://(www\.)?', ''))
    ) STORED,

    -- The taxonomy: what KIND of signal is this?
    -- tool      = (rare in this table, mostly goes to `tools`)
    -- news      = breaking news, model releases, feature drops
    -- research  = arXiv papers, academic findings
    -- opinion   = hot takes, blog essays, expert commentary
    -- drama     = controversies, lawsuits, public arguments, exits
    -- funding   = VC rounds, IPOs, M&A
    -- release   = official model/product launches by a known lab
    -- tutorial  = high-quality educational content
    -- meme      = AI-related viral moments
    type            TEXT NOT NULL CHECK (type IN
        ('tool', 'news', 'research', 'opinion', 'drama', 'funding', 'release', 'tutorial', 'meme')),

    -- Optional finer-grained subtype (free text, classifier-set)
    subtype         TEXT DEFAULT '',

    -- Companies / models / people mentioned, for filtering
    entities        TEXT[] DEFAULT '{}',

    -- Topics (e.g. "agents", "diffusion", "rag", "multimodal", "open-source")
    topics          TEXT[] DEFAULT '{}',

    -- Avatar-relevance signals
    virality_score        INTEGER DEFAULT 0 CHECK (virality_score BETWEEN 0 AND 10),
    avatar_angles         TEXT[] DEFAULT '{}',  -- e.g. ['hot_take', 'explainer', 'humor']
    is_evergreen          BOOLEAN DEFAULT FALSE,
    newsworthy_until      TIMESTAMPTZ DEFAULT NULL,  -- when this stops being "fresh"

    -- Provenance
    source          TEXT NOT NULL,           -- e.g. 'reddit', 'arxiv', 'openai_blog'
    source_url      TEXT DEFAULT '',
    author          TEXT DEFAULT '',
    upvotes         INTEGER DEFAULT 0,
    comments        INTEGER DEFAULT 0,

    -- Classifier metadata
    classifier_version TEXT DEFAULT 'v2.0',
    confidence         REAL DEFAULT 0.0,

    -- Lifecycle
    is_active       BOOLEAN DEFAULT TRUE,
    archived_at     TIMESTAMPTZ DEFAULT NULL,
    archived_reason TEXT DEFAULT '',

    -- Timestamps
    published_at    TIMESTAMPTZ DEFAULT NOW(),
    added_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),

    -- Tracking
    run_id          TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_signals_type            ON ai_signals (type);
CREATE INDEX IF NOT EXISTS idx_signals_added_at        ON ai_signals (added_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_virality        ON ai_signals (virality_score DESC);
CREATE INDEX IF NOT EXISTS idx_signals_active_recent   ON ai_signals (is_active, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_url_normalized  ON ai_signals (url_normalized);
CREATE INDEX IF NOT EXISTS idx_signals_title_trgm      ON ai_signals USING gin (title_lower gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_signals_entities        ON ai_signals USING gin (entities);
CREATE INDEX IF NOT EXISTS idx_signals_topics          ON ai_signals USING gin (topics);
CREATE INDEX IF NOT EXISTS idx_signals_source          ON ai_signals (source);
CREATE INDEX IF NOT EXISTS idx_signals_evergreen       ON ai_signals (is_evergreen) WHERE is_evergreen = TRUE;

-- Public-read RLS policy (matches the one we set on `tools`)
ALTER TABLE ai_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS signals_public_read ON ai_signals;
CREATE POLICY signals_public_read ON ai_signals
  FOR SELECT
  USING (is_active = TRUE);

-- ─── AVATAR_BRIEFS TABLE ─────────────────────────────────────────────────────
-- One row per "Reel idea" the avatar engine generates.
-- A brief is the FULL content package: signal + script + image prompt + voice line + format.
CREATE TABLE IF NOT EXISTS avatar_briefs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Source linkage (a brief can be from a tool OR a signal OR neither — pure lure content)
    signal_id       UUID REFERENCES ai_signals(id) ON DELETE SET NULL,
    tool_id         UUID REFERENCES tools(id)      ON DELETE SET NULL,

    -- Format taxonomy
    -- ai_drop      = new tool/model launch announcement
    -- hot_take     = opinion-led drama/news reel
    -- tutorial_tease = "I made X with Y, want to learn?" → DM funnel
    -- bts_lure     = behind-the-scenes / GRWM, lure-coded
    -- evergreen_loop = recyclable content not tied to news cycle
    format          TEXT NOT NULL CHECK (format IN
        ('ai_drop', 'hot_take', 'tutorial_tease', 'bts_lure', 'evergreen_loop')),

    -- Lure level: 1 (educational) → 5 (heavy thirst-trap)
    lure_level      INTEGER DEFAULT 2 CHECK (lure_level BETWEEN 1 AND 5),

    -- The actual content package
    hook_caption    TEXT NOT NULL,        -- first 2 seconds, pattern-interrupt
    script          TEXT NOT NULL,        -- full Reel script
    voice_lines     TEXT[] DEFAULT '{}',  -- broken into chunks for ElevenLabs
    image_prompt    TEXT NOT NULL,        -- for SDXL keyframe generation
    video_motion    TEXT DEFAULT '',      -- for Hailuo/Kling animation prompt
    final_caption   TEXT NOT NULL,        -- Instagram caption with CTA + hashtags
    hashtags        TEXT[] DEFAULT '{}',
    cta             TEXT DEFAULT '',      -- "Comment LINK" / "DM ME" / etc.

    -- Generated assets (paths in Supabase Storage)
    keyframe_path   TEXT DEFAULT '',
    video_path      TEXT DEFAULT '',
    audio_path      TEXT DEFAULT '',
    final_reel_path TEXT DEFAULT '',

    -- Quality gate results
    face_similarity REAL DEFAULT 0.0,
    nsfw_score      REAL DEFAULT 0.0,
    aesthetic_score REAL DEFAULT 0.0,

    -- Lifecycle
    -- pending → generating → quality_check → ready_for_review → posted | rejected
    status          TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending', 'generating', 'quality_check',
                                     'ready_for_review', 'posted', 'rejected')),
    rejection_reason TEXT DEFAULT '',

    -- Posting tracking (filled by user when they post manually)
    posted_at       TIMESTAMPTZ DEFAULT NULL,
    posted_url      TEXT DEFAULT '',
    instagram_post_id TEXT DEFAULT '',

    -- Performance (filled by polling Instagram Graph API)
    views           INTEGER DEFAULT 0,
    likes           INTEGER DEFAULT 0,
    comments_count  INTEGER DEFAULT 0,
    saves           INTEGER DEFAULT 0,
    reach           INTEGER DEFAULT 0,
    last_metrics_at TIMESTAMPTZ DEFAULT NULL,

    -- Timestamps
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    scheduled_for   TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_briefs_status     ON avatar_briefs (status);
CREATE INDEX IF NOT EXISTS idx_briefs_format     ON avatar_briefs (format);
CREATE INDEX IF NOT EXISTS idx_briefs_created_at ON avatar_briefs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_briefs_lure       ON avatar_briefs (lure_level);
CREATE INDEX IF NOT EXISTS idx_briefs_signal     ON avatar_briefs (signal_id);
CREATE INDEX IF NOT EXISTS idx_briefs_tool       ON avatar_briefs (tool_id);

-- Avatar briefs are NOT publicly readable — these are operator-only
ALTER TABLE avatar_briefs ENABLE ROW LEVEL SECURITY;
-- (no SELECT policy = no anon access. service_role bypasses RLS.)

-- ─── SIGNAL_SOURCES TABLE ────────────────────────────────────────────────────
-- Lightweight registry of where each signal came from. Useful for analytics
-- ("Reddit gives the most virality_score>=8 signals") and dead-source detection.
CREATE TABLE IF NOT EXISTS signal_sources (
    id              SERIAL PRIMARY KEY,
    name            TEXT UNIQUE NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN
        ('rss', 'api', 'scrape', 'reddit', 'youtube', 'twitter', 'arxiv')),
    url             TEXT NOT NULL,
    is_enabled      BOOLEAN DEFAULT TRUE,
    last_fetched_at TIMESTAMPTZ DEFAULT NULL,
    last_status     TEXT DEFAULT '',  -- 'ok', 'http_404', 'parse_error', etc.
    items_lifetime  INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signal_sources_enabled ON signal_sources (is_enabled);

-- Seed the source registry with the new collectors we'll wire up tonight
INSERT INTO signal_sources (name, kind, url) VALUES
    ('reddit_machinelearning', 'reddit', 'https://www.reddit.com/r/MachineLearning/.json'),
    ('reddit_singularity',     'reddit', 'https://www.reddit.com/r/singularity/.json'),
    ('reddit_localllama',      'reddit', 'https://www.reddit.com/r/LocalLLaMA/.json'),
    ('reddit_openai',          'reddit', 'https://www.reddit.com/r/OpenAI/.json'),
    ('reddit_stablediffusion', 'reddit', 'https://www.reddit.com/r/StableDiffusion/.json'),
    ('arxiv_cs_ai',            'arxiv',  'http://export.arxiv.org/rss/cs.AI'),
    ('arxiv_cs_cl',            'arxiv',  'http://export.arxiv.org/rss/cs.CL'),
    ('arxiv_cs_lg',            'arxiv',  'http://export.arxiv.org/rss/cs.LG'),
    ('huggingface_models',     'api',    'https://huggingface.co/api/models?sort=trending&limit=50'),
    ('huggingface_spaces',     'api',    'https://huggingface.co/api/spaces?sort=trending&limit=50'),
    ('openai_blog',            'rss',    'https://openai.com/blog/rss.xml'),
    ('anthropic_news',         'rss',    'https://www.anthropic.com/news/rss.xml'),
    ('google_research_blog',   'rss',    'https://research.google/blog/rss/'),
    ('deepmind_blog',          'rss',    'https://deepmind.google/blog/rss.xml'),
    ('producthunt_ai',         'rss',    'https://www.producthunt.com/feed?category=artificial-intelligence'),
    ('techcrunch_ai',          'rss',    'https://techcrunch.com/category/artificial-intelligence/feed/'),
    ('github_trending',        'scrape', 'https://github.com/trending?since=daily&spoken_language_code=en')
ON CONFLICT (name) DO NOTHING;

-- ─── ENGINE_METRICS TABLE ────────────────────────────────────────────────────
-- Time-series of run KPIs, used for daily Telegram summary + dashboard.
CREATE TABLE IF NOT EXISTS engine_metrics (
    id              SERIAL PRIMARY KEY,
    run_id          TEXT NOT NULL,
    metric_name     TEXT NOT NULL,
    metric_value    NUMERIC NOT NULL,
    recorded_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metrics_run     ON engine_metrics (run_id);
CREATE INDEX IF NOT EXISTS idx_metrics_name    ON engine_metrics (metric_name, recorded_at DESC);

-- ─── DAILY DIGEST VIEW ───────────────────────────────────────────────────────
-- A pre-computed view the Telegram daily-summary bot will read.
CREATE OR REPLACE VIEW v_daily_digest AS
SELECT
    DATE(NOW()) AS as_of,
    (SELECT COUNT(*) FROM tools WHERE is_active = TRUE)                                   AS total_active_tools,
    (SELECT COUNT(*) FROM tools WHERE added_at > NOW() - INTERVAL '24 hours')             AS tools_added_24h,
    (SELECT COUNT(*) FROM ai_signals WHERE is_active = TRUE)                              AS total_active_signals,
    (SELECT COUNT(*) FROM ai_signals WHERE added_at > NOW() - INTERVAL '24 hours')        AS signals_added_24h,
    (SELECT COUNT(*) FROM ai_signals WHERE added_at > NOW() - INTERVAL '24 hours' AND virality_score >= 7) AS hot_signals_24h,
    (SELECT COUNT(*) FROM avatar_briefs WHERE status = 'ready_for_review')                AS briefs_awaiting_review,
    (SELECT COUNT(*) FROM avatar_briefs WHERE status = 'posted' AND posted_at > NOW() - INTERVAL '24 hours') AS posts_today,
    (SELECT COUNT(*) FROM backfill_progress WHERE status = 'completed')                   AS backfill_months_done,
    (SELECT COUNT(*) FROM backfill_progress WHERE status = 'pending')                     AS backfill_months_pending,
    (SELECT COUNT(*) FROM runs WHERE state = 'failed' AND started_at > NOW() - INTERVAL '24 hours') AS failed_runs_24h,
    (SELECT MAX(completed_at) FROM runs WHERE state = 'done')                             AS last_successful_run_at;

-- ─── HEALTH CHECK FUNCTION ───────────────────────────────────────────────────
-- Used by the VM health endpoint and Telegram alerts.
CREATE OR REPLACE FUNCTION engine_health()
RETURNS TABLE(check_name TEXT, status TEXT, detail TEXT) AS $$
BEGIN
    RETURN QUERY
    SELECT 'recent_run'::TEXT,
           CASE WHEN MAX(completed_at) > NOW() - INTERVAL '2 hours' THEN 'OK' ELSE 'STALE' END,
           COALESCE('Last run: ' || MAX(completed_at)::TEXT, 'No runs ever')
    FROM runs WHERE state = 'done';

    RETURN QUERY
    SELECT 'failed_runs_24h'::TEXT,
           CASE WHEN COUNT(*) > 5 THEN 'WARN' ELSE 'OK' END,
           COUNT(*)::TEXT || ' failed runs in last 24h'
    FROM runs WHERE state = 'failed' AND started_at > NOW() - INTERVAL '24 hours';

    RETURN QUERY
    SELECT 'queue_backlog'::TEXT,
           CASE WHEN COUNT(*) > 5000 THEN 'WARN' ELSE 'OK' END,
           COUNT(*)::TEXT || ' pending items in queue'
    FROM discovery_queue WHERE status = 'pending';

    RETURN QUERY
    SELECT 'backfill_progress'::TEXT, 'INFO'::TEXT,
           COUNT(*) FILTER (WHERE status = 'completed')::TEXT || '/' ||
           COUNT(*)::TEXT || ' months done'
    FROM backfill_progress;
END;
$$ LANGUAGE plpgsql;

-- ─── DONE ─────────────────────────────────────────────────────────────────────
SELECT 'Schema v2 applied successfully' AS status,
       (SELECT COUNT(*) FROM signal_sources WHERE is_enabled) AS active_sources,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public') AS total_tables;
