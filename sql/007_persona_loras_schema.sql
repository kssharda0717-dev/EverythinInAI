-- ═══════════════════════════════════════════════════════════════════════════════
-- EverythinInAI — Persona LoRAs Schema
--
-- Stores trained Flux LoRAs (low-rank adapters) for each persona. The LoRA
-- is the "memorized identity" — once trained, downstream image generation
-- uses Flux Dev + this LoRA to produce a 100%-consistent Avi every time.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS persona_loras (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    persona_id      UUID NOT NULL REFERENCES personas(id) ON DELETE CASCADE,

    -- Identification
    trigger_word    TEXT NOT NULL,             -- 'AVI_TOK' — must appear in every prompt
    weights_url     TEXT,                      -- public URL of the .safetensors file
    storage_path    TEXT,                      -- 'persona-loras/avi/...' (mirrored to Supabase Storage)

    -- Training metadata
    training_id     TEXT,                      -- Replicate training id
    training_status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (training_status IN ('pending', 'training', 'succeeded', 'failed', 'canceled')),
    training_steps  INTEGER DEFAULT 1000,
    lora_rank       INTEGER DEFAULT 16,
    learning_rate   NUMERIC(10, 6) DEFAULT 0.0004,
    cost_usd        NUMERIC(10, 4) DEFAULT 0,

    -- Training input
    training_zip_url TEXT,                     -- public URL of the input zip
    training_image_count INTEGER DEFAULT 0,

    -- Selection
    is_active       BOOLEAN DEFAULT FALSE,     -- only one active per persona at a time
    activated_at    TIMESTAMPTZ,

    -- Logs / debug
    error_message   TEXT,
    training_logs   TEXT,

    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_persona_loras_persona ON persona_loras (persona_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_persona_loras_active
    ON persona_loras (persona_id) WHERE is_active = TRUE;

-- Public read (so frontend can show "Avi has trained model")
ALTER TABLE persona_loras ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS persona_loras_public_read ON persona_loras;
CREATE POLICY persona_loras_public_read ON persona_loras FOR SELECT USING (TRUE);

-- Add lora reference to personas table for fast lookup
ALTER TABLE personas
    ADD COLUMN IF NOT EXISTS active_lora_url TEXT,
    ADD COLUMN IF NOT EXISTS active_lora_trigger TEXT;

-- ─── SECURITY FUTURE-PROOFING (EXPLICIT GRANTS) ──────────────────────────────
-- Required for Supabase Data API changes (May/Oct 2026)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE persona_loras TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- Reload the PostgREST schema cache
NOTIFY pgrst, 'reload schema';

SELECT 'persona loras schema applied' AS status,
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'persona_loras') AS exists;
