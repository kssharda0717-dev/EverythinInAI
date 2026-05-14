-- Migration 023: PAIN_HOOK framework
-- Adds a new viral framework that anchors hooks to audience pain points.
-- Inspired by the "Turn pain into a hook" growth-strategist prompt.
--
-- Why this works: AI professionals (our target audience) have specific
-- frustrations: slow RAG, expensive GPT bills, hallucinations, vendor lock-in,
-- model drift, prompt engineering fatigue. A hook that names their pain
-- directly is more scroll-stopping than a generic value prop.

INSERT INTO content_frameworks (slug, stream, display_name, description, prompt_template, example_hook, generation, reasoning) VALUES
  ('pain_hook', 'tech', 'Pain Hook',
   'Comments-driven: names a specific audience frustration and weaponises it as the hook',
   'First identify ONE specific pain point AI builders/professionals have RIGHT NOW about [signal topic] (e.g., "RAG is too slow", "GPT bills are out of control", "this model hallucinates 30% of the time"). Then write the hook as a bold, punchy declaration of that pain in under 10 words. Body explains the new tool/paper as the solution. Punch creates "wait, really?" surprise.',
   'Your RAG is too slow. This paper proves it.',
   1, 'Pain-driven hooks generate 2-3x more comments because viewers self-identify with the frustration before they hear the solution.')
ON CONFLICT (slug) DO NOTHING;

-- ─── SECURITY FUTURE-PROOFING (EXPLICIT GRANTS) ──────────────────────────────
-- Required for Supabase Data API changes (May/Oct 2026)
-- (Grants are applied to the table itself, but we include them here for completeness)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE content_frameworks TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- Reload the PostgREST schema cache
NOTIFY pgrst, 'reload schema';
