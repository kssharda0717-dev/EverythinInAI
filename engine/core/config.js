/**
 * EverythinInAI Discovery Engine — Configuration
 * Loads and validates all environment variables.
 * In the unified project, .env lives at the project root (two levels up from engine/core/).
 */
const path = require('path');

// Try loading .env from project root — in production, env vars are already set
try {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
} catch (e) {
  // dotenv may not be available in all environments; env vars should be pre-set
}

const config = {
  supabase: {
    url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
    anonKey: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
    rpmLimit: parseInt(process.env.GEMINI_RPM_LIMIT || '15', 10),
    tpmLimit: parseInt(process.env.GEMINI_TPM_LIMIT || '1000000', 10),
    rpdLimit: parseInt(process.env.GEMINI_RPD_LIMIT || '1500', 10),
    batchSize: parseInt(process.env.GEMINI_BATCH_SIZE || '5', 10),
  },
  github: {
    token: process.env.GITHUB_TOKEN || '',
    repo: process.env.GITHUB_REPO || 'kssharda0717-dev/EverythinInAI',
    branch: process.env.GITHUB_BRANCH || 'main',
  },
  engine: {
    mode: process.env.ENGINE_MODE || 'incremental',
    backfillChunkMonths: parseInt(process.env.BACKFILL_CHUNK_MONTHS || '1', 10),
    incrementalHours: parseInt(process.env.INCREMENTAL_HOURS || '6', 10),
    maxItemsPerRun: parseInt(process.env.MAX_ITEMS_PER_RUN || '500', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    engineApiPort: parseInt(process.env.ENGINE_API_PORT || '3847', 10),
    engineApiSecret: process.env.ENGINE_API_SECRET || '',
  },
};

/**
 * Validate that critical config values are present.
 * Returns an array of error messages (empty = all good).
 */
function validateConfig() {
  const errors = [];
  if (!config.supabase.url) errors.push('SUPABASE_URL is required');
  if (!config.supabase.serviceKey) errors.push('SUPABASE_SERVICE_KEY is required');
  if (!config.gemini.apiKey) errors.push('GEMINI_API_KEY is required');
  return errors;
}

module.exports = { config, validateConfig };
