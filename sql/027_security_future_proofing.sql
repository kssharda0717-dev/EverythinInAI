-- EverythinInAI — Security Future-Proofing Patch
--
-- This script explicitly grants access to the Data API for all existing tables.
-- Starting October 30, 2026, Supabase will no longer expose tables by default.
--
-- We grant full access to 'service_role' (the key Rhea uses) and 'authenticated'.
-- We do NOT grant access to 'anon' (public web) to keep the database secure.

DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'ai_signals',
        'avatar_briefs',
        'backfill_progress',
        'content_calendar',
        'content_frameworks',
        'daily_spend_log',
        'discovery_queue',
        'engine_metrics',
        'face_anchors',
        'latency_log',
        'newsletter_subscribers',
        'pending_audio_uploads',
        'pending_check_ins',
        'persona_loras',
        'persona_voice_refs',
        'personas',
        'reel_concepts',
        'reel_keyframes',
        'reel_performance',
        'render_steps',
        'runs',
        'signal_sources',
        'system_settings',
        'tools',
        'topic_history',
        'travel_calendar',
        'trending_formats'
    ];
BEGIN
    FOREACH t IN ARRAY tables
    LOOP
        -- Grant full access to authenticated users and service role
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', t);
        
        -- Also grant access to sequences (for auto-incrementing IDs)
        -- We do this for all sequences in the public schema
    END LOOP;
END $$;

-- Grant access to all sequences (required for INSERTs to work)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Reload the PostgREST schema cache
NOTIFY pgrst, 'reload schema';
