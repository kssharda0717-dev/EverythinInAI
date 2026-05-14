-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration 027 (DEFENSIVE): Master Security Patch — Future-Proofing for Supabase 2026
--
-- This migration prepares the project for two upcoming Supabase Data API changes:
--   - May 30, 2026: Default for all NEW Supabase projects.
--   - October 30, 2026: Enforced on ALL EXISTING projects (including this one).
--
-- After those dates, tables in the "public" schema will NOT be exposed to the
-- Data API (supabase-js, REST, GraphQL) unless they have explicit GRANTs.
-- Without these grants, Rhea's brain (which reads/writes via supabase-js using
-- the service_role key) would lose access to its own database.
--
-- DEFENSIVE DESIGN:
--   Instead of hardcoding table names (which fails if a table doesn't exist
--   in this particular project), we iterate over information_schema and grant
--   on every public table that is actually present. Missing tables are
--   silently skipped, so this migration is safe to run on any project state.
--
-- IDEMPOTENT: Safe to run multiple times — GRANTs simply overwrite themselves.
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  r RECORD;
  granted_count INT := 0;
  skipped_count INT := 0;
BEGIN
  -- Iterate over every BASE TABLE in the public schema
  FOR r IN
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  LOOP
    BEGIN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated, service_role',
        r.table_name
      );
      granted_count := granted_count + 1;
      RAISE NOTICE '  ✓ Granted on public.%', r.table_name;
    EXCEPTION WHEN OTHERS THEN
      skipped_count := skipped_count + 1;
      RAISE NOTICE '  ⚠ Skipped public.% (reason: %)', r.table_name, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE '─────────────────────────────────────────';
  RAISE NOTICE 'GRANT summary: % tables granted, % skipped', granted_count, skipped_count;
END $$;

-- Grant usage + select on all sequences (needed for any auto-incrementing IDs).
-- This is a single statement that applies to every sequence in public, so it
-- doesn't need defensive iteration.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- Tell PostgREST to reload its schema cache so the API immediately sees the new permissions.
NOTIFY pgrst, 'reload schema';

-- Final sanity check: list the tables that now have grants
SELECT
  table_name AS "Table",
  COUNT(*) FILTER (WHERE grantee = 'authenticated') AS "auth grants",
  COUNT(*) FILTER (WHERE grantee = 'service_role') AS "svc grants"
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('authenticated', 'service_role')
GROUP BY table_name
ORDER BY table_name;
