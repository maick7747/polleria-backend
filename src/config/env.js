'use strict';

const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const file = path.resolve(__dirname, '../../.env');
  if (!fs.existsSync(file)) {
    return;
  }

  const content = fs.readFileSync(file, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const env = {
  port: asNumber(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  dbMode: process.env.DB_MODE || 'memory',
  databaseUrl: process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_KEY || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  jwtSecret: process.env.JWT_SECRET || 'fratellis-demo-secret-change-me-32-bytes-long',
  tokenTtlSec: asNumber(process.env.TOKEN_TTL_SEC, 1800),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  logRequests: process.env.LOG_REQUESTS !== '0',
};

module.exports = env;
