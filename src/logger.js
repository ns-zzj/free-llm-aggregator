'use strict';

const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] !== undefined ? LEVELS[config.logLevel] : LEVELS.info;

function emit(level, message, extra) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (extra === undefined) stream.write(`${line}\n`);
  else stream.write(`${line} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}\n`);
}

module.exports = {
  debug: (m, e) => emit('debug', m, e),
  info: (m, e) => emit('info', m, e),
  warn: (m, e) => emit('warn', m, e),
  error: (m, e) => emit('error', m, e),
};
