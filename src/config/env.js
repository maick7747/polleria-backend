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
  slowRequestMs: asNumber(process.env.SLOW_REQUEST_MS, 3000),

  // Integraciones — validación de documentos (patrón Strategy).
  documentoProvider: process.env.DOCUMENTO_PROVIDER || 'mock',
  documentoFallback: process.env.DOCUMENTO_FALLBACK || 'mock',
  documentoTimeoutMs: asNumber(process.env.DOCUMENTO_TIMEOUT_MS, 5000),
  documentoCacheTtlSec: asNumber(process.env.DOCUMENTO_CACHE_TTL_SEC, 86400),
  apiperuBaseUrl: process.env.APIPERU_BASE_URL || 'https://api.apiperu.dev',
  apiperuToken: process.env.APIPERU_TOKEN || '',
  openrucBaseUrl: process.env.OPENRUC_BASE_URL || 'https://openruc.com',

  // Integraciones — emisión SUNAT (patrón Strategy).
  sunatMode: process.env.SUNAT_MODE || 'simulado',
  sunatApiUrl: process.env.SUNAT_API_URL || '',
  sunatApiKey: process.env.SUNAT_API_KEY || '',
  sunatBetaUrl: process.env.SUNAT_BETA_URL || '',
  sunatProduccionUrl: process.env.SUNAT_PRODUCCION_URL || '',
  sunatRuc: process.env.SUNAT_RUC || '',
  sunatRazonSocial: process.env.SUNAT_RAZON_SOCIAL || "FRATELLI'S RESTAURANTE",
  sunatUsuarioSol: process.env.SUNAT_USUARIO_SOL || '',
  sunatClaveSol: process.env.SUNAT_CLAVE_SOL || '',
  sunatCertificadoRuta: process.env.SUNAT_CERTIFICADO_RUTA || '',
  sunatTimeoutMs: asNumber(process.env.SUNAT_TIMEOUT_MS, 15000),
};

module.exports = env;
