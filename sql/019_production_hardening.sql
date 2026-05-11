-- Migration 019: Production Hardening

CREATE TABLE IF NOT EXISTS daily_spend_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date        date NOT NULL,
  service     text NOT NULL,
  model       text,
  cost_usd    numeric(10, 4) NOT NULL,
  context     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_daily_spend_date ON daily_spend_log(date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_spend_service ON daily_spend_log(service, date DESC);

CREATE TABLE IF NOT EXISTS latency_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service     text NOT NULL,
  operation   text NOT NULL,
  duration_ms integer NOT NULL,
  ok          boolean NOT NULL DEFAULT true,
  error_msg   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_latency_log_recent ON latency_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_latency_log_service ON latency_log(service, operation, created_at DESC);

CREATE TABLE IF NOT EXISTS system_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_settings (key, value, description) VALUES
  ('current_persona_slug', '"avi"'::jsonb, 'Active persona slug used by all workers'),
  ('daily_spend_cap_usd', '5.0'::jsonb, 'Maximum daily spend across all services'),
  ('expensive_call_threshold_usd', '0.5'::jsonb, 'Calls above this trigger the cap check'),
  ('growth_phase', '"cold_start"'::jsonb, 'cold_start | growth | scale | monetize')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE content_calendar
  ADD COLUMN IF NOT EXISTS posted_at timestamptz,
  ADD COLUMN IF NOT EXISTS display_id text;
CREATE INDEX IF NOT EXISTS idx_calendar_posted_at ON content_calendar(posted_at DESC) WHERE posted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_display_id ON content_calendar(display_id);

ALTER TABLE reel_concepts
  ADD COLUMN IF NOT EXISTS display_id text;
CREATE INDEX IF NOT EXISTS idx_concepts_display_id ON reel_concepts(display_id);

ALTER TABLE tools
  ADD COLUMN IF NOT EXISTS last_url_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS url_status_code integer,
  ADD COLUMN IF NOT EXISTS url_check_error text;
CREATE INDEX IF NOT EXISTS idx_tools_last_url_check
  ON tools(last_url_check_at NULLS FIRST) WHERE is_active = true;
