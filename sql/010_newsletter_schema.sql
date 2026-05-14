-- ═══════════════════════════════════════════════════════════════════════════════
-- EverythinInAI — Newsletter Subscribers Schema
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           TEXT UNIQUE NOT NULL,
    source          TEXT DEFAULT 'website',
    is_verified     BOOLEAN DEFAULT FALSE,
    is_unsubscribed BOOLEAN DEFAULT FALSE,
    subscribed_at   TIMESTAMPTZ DEFAULT NOW(),
    last_sent_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_newsletter_active ON newsletter_subscribers (subscribed_at DESC) WHERE is_unsubscribed = FALSE;

-- RLS: writes are server-only (service key); no public read.
ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;

-- ─── SECURITY FUTURE-PROOFING (EXPLICIT GRANTS) ──────────────────────────────
-- Required for Supabase Data API changes (May/Oct 2026)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE newsletter_subscribers TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- Reload the PostgREST schema cache
NOTIFY pgrst, 'reload schema';

SELECT 'newsletter schema applied' AS status,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'newsletter_subscribers') AS exists;
