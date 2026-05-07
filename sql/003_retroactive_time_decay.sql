-- ═══════════════════════════════════════════════════════════════════════════════
-- EverythinInAI — Retroactive Virality Time-Decay
--
-- Applies the same time-decay rules as engine/intelligence/time_decay.js to
-- the existing rows in `ai_signals`. Run this ONCE in Supabase SQL Editor
-- after deploying the time_decay.js code.
--
-- Decay rules:
--   For TIME-SENSITIVE types (news, release, drama, funding):
--     ≤ 7 days  : keep original virality
--     8-30 days : virality × 0.5
--     31-90 days : virality × 0.2
--     > 90 days : virality = 0 (effectively excluded from avatar selection)
--
--   For EVERGREEN types (tool, research, tutorial, opinion, meme):
--     no change (kept as-is)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Show before-state for sanity check
SELECT 'BEFORE' AS phase, type, COUNT(*) AS rows, ROUND(AVG(virality_score), 1) AS avg_v
FROM ai_signals
GROUP BY type
ORDER BY type;

-- Apply decay to time-sensitive signals
UPDATE ai_signals
SET virality_score = CASE
  WHEN type NOT IN ('news', 'release', 'drama', 'funding') THEN virality_score
  WHEN published_at IS NULL THEN virality_score
  WHEN published_at >= NOW() - INTERVAL '7 days'  THEN virality_score
  WHEN published_at >= NOW() - INTERVAL '30 days' THEN ROUND(virality_score * 0.5)
  WHEN published_at >= NOW() - INTERVAL '90 days' THEN ROUND(virality_score * 0.2)
  ELSE 0
END,
is_evergreen = (type IN ('tool', 'research', 'tutorial', 'opinion', 'meme'))
WHERE TRUE;

-- Show after-state
SELECT 'AFTER' AS phase, type, COUNT(*) AS rows, ROUND(AVG(virality_score), 1) AS avg_v,
  COUNT(*) FILTER (WHERE virality_score = 0) AS zero_v_count,
  COUNT(*) FILTER (WHERE virality_score >= 7) AS hot_signals
FROM ai_signals
GROUP BY type
ORDER BY type;
