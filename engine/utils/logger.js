/**
 * EverythinInAI Discovery Engine — Structured Logger
 * Provides consistent, timestamped logging with level filtering.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

class Logger {
  constructor(module, level = 'info') {
    this.module = module;
    this.level = LEVELS[level] ?? LEVELS.info;
  }

  _log(level, emoji, ...args) {
    if (LEVELS[level] > this.level) return;
    const ts = new Date().toISOString();
    const prefix = `${ts} ${emoji} [${this.module}]`;
    console.log(prefix, ...args);
  }

  error(...args) { this._log('error', '✗', ...args); }
  warn(...args)  { this._log('warn',  '⚠', ...args); }
  info(...args)  { this._log('info',  '→', ...args); }
  debug(...args) { this._log('debug', '·', ...args); }
  trace(...args) { this._log('trace', '…', ...args); }

  child(subModule) {
    return new Logger(`${this.module}:${subModule}`, Object.keys(LEVELS)[this.level]);
  }
}

function createLogger(module) {
  const { config } = require('../core/config');
  return new Logger(module, config.engine.logLevel);
}

module.exports = { Logger, createLogger };
