/**
 * EverythinInAI - Environment Validator
 * 
 * Fails loudly at startup if required env vars are missing or malformed.
 * Call validateEnv() at the top of every entry-point script.
 */

const { createLogger } = require('../utils/logger');
const log = createLogger('env_validator');

const RULES = {
  SUPABASE_URL: { required: true, pattern: /^https:\/\/.+\.supabase\.co$/, hint: 'Should be https://xxxxx.supabase.co' },
  SUPABASE_SERVICE_KEY: { required: true, pattern: /^eyJ[A-Za-z0-9_\-\.]+$/, hint: 'JWT token starting with eyJ' },
  REPLICATE_API_TOKEN: { required: true, pattern: /^r8_[A-Za-z0-9]{30,}$/, hint: 'Should start with r8_' },
  GEMINI_API_KEY: { required: true, pattern: /^.+/, hint: 'Non-empty Gemini API key' },
  TELEGRAM_BOT_TOKEN: { required: false, pattern: /^\d+:[A-Za-z0-9_\-]{20,}$/, hint: '<bot_id>:<token>' },
  TELEGRAM_CHAT_ID: { required: false, pattern: /^-?\d+$/, hint: 'Numeric chat ID' },
};

function validateEnv(strictness = 'soft') {
  const errors = [];
  const warnings = [];

  for (const [name, rule] of Object.entries(RULES)) {
    const val = process.env[name];
    if (!val) {
      const msg = `Missing env var: ${name} (${rule.hint})`;
      if (rule.required) errors.push(msg); else warnings.push(msg);
      continue;
    }
    if (rule.pattern && !rule.pattern.test(val)) {
      const msg = `Malformed env var: ${name} (${rule.hint}; got: ${val.slice(0, 20)}...)`;
      if (rule.required) errors.push(msg); else warnings.push(msg);
    }
  }

  warnings.forEach(w => log.warn(w));

  if (errors.length > 0) {
    log.error('Environment validation FAILED:');
    errors.forEach(e => log.error('  ' + e));
    if (strictness === 'strict' || strictness === 'hard') {
      process.exit(1);
    }
    return { ok: false, errors, warnings };
  }
  return { ok: true, errors: [], warnings };
}

module.exports = { validateEnv, RULES };
