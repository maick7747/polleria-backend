'use strict';

// Colector de métricas mínimo en memoria (sin dependencias).
// - Guarda las últimas MAX_MUESTRAS peticiones en un ring buffer, con el
//   patrón de ruta normalizado (nunca ids literales), status y duración.
// - Expone snapshot() con p50/p95/max/errores 5xx agrupados por método+ruta.
// - Avisa una sola vez por request cuando supera SLOW_REQUEST_MS.
//
// Es diagnóstico operativo del proceso: se reinicia con el dyno/servidor y
// no sustituye a un APM. No se registran cuerpos, parámetros ni cabeceras.

const env = require('../config/env');

const MAX_MUESTRAS = 2000;
const MAX_LENTAS = 20;
const IGNORAR = new Set(['/api/health', '/api/metrics']);
const UMBRAL_LENTO_MS = env.slowRequestMs;

const muestras = new Array(MAX_MUESTRAS);
let escrituras = 0;
let total = 0;

const lentas = new Array(MAX_LENTAS);
let escriturasLentas = 0;

// Convierte ids literales en `:id` cuando Express no expone el patrón
// (p. ej. 404). Así una ruta desconocida no genera cardinalidad por id.
function normalizarLiteral(ruta) {
  return (
    String(ruta || '')
      .split('?')[0]
      .replace(/\/[0-9]+(?=\/|$)/g, '/:id')
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:id')
      .slice(0, 200) || '/'
  );
}

function rutaDe(req) {
  const routePath = req.route && req.route.path;
  if (routePath) {
    const patron = Array.isArray(routePath) ? routePath[0] : routePath;
    const ruta = `${req.baseUrl || ''}${patron || '/'}`.replace(/\/+$/, '');
    return ruta || '/';
  }
  return normalizarLiteral(req.originalUrl || req.url);
}

function registrar(muestra) {
  total += 1;
  muestras[escrituras % MAX_MUESTRAS] = muestra;
  escrituras += 1;

  if (muestra.ms > UMBRAL_LENTO_MS) {
    lentas[escriturasLentas % MAX_LENTAS] = {
      momento: muestra.momento,
      metodo: muestra.metodo,
      ruta: muestra.ruta,
      status: muestra.status,
      ms: muestra.ms,
      request_id: muestra.request_id,
    };
    escriturasLentas += 1;
  }
}

function metricsMiddleware(req, res, next) {
  // Los preflight de CORS no son tráfico de la aplicación.
  if (req.method === 'OPTIONS') {
    next();
    return;
  }

  const rutaSolicitada = (req.originalUrl || req.url || '').split('?')[0];
  if (IGNORAR.has(rutaSolicitada)) {
    next();
    return;
  }

  const startedAt = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    const muestra = {
      momento: new Date().toISOString(),
      metodo: req.method,
      ruta: rutaDe(req),
      status: res.statusCode,
      ms,
      request_id: req.id || null,
    };

    if (ms > UMBRAL_LENTO_MS) {
      console.warn(
        `[slow] ${muestra.metodo} ${muestra.ruta} -> ${muestra.status} (${ms} ms) [${muestra.request_id}]`,
      );
    }

    registrar(muestra);
  });

  next();
}

// Percentil por rango más cercano (nearest-rank) sobre un array ordenado.
function percentil(ordenados, valor) {
  if (ordenados.length === 0) {
    return 0;
  }
  const indice = Math.ceil((valor / 100) * ordenados.length) - 1;
  return ordenados[Math.min(Math.max(indice, 0), ordenados.length - 1)];
}

function snapshot() {
  const visibles = Math.min(escrituras, MAX_MUESTRAS);
  const grupos = new Map();

  for (let i = 0; i < visibles; i += 1) {
    const muestra = muestras[i];
    if (!muestra) {
      continue;
    }
    const clave = `${muestra.metodo} ${muestra.ruta}`;
    let grupo = grupos.get(clave);
    if (!grupo) {
      grupo = {
        metodo: muestra.metodo,
        ruta: muestra.ruta,
        duraciones: [],
        errores_5xx: 0,
      };
      grupos.set(clave, grupo);
    }
    grupo.duraciones.push(muestra.ms);
    if (muestra.status >= 500) {
      grupo.errores_5xx += 1;
    }
  }

  const porRuta = Array.from(grupos.values())
    .map((grupo) => {
      const ordenados = grupo.duraciones.slice().sort((a, b) => a - b);
      return {
        metodo: grupo.metodo,
        ruta: grupo.ruta,
        n: ordenados.length,
        p50_ms: percentil(ordenados, 50),
        p95_ms: percentil(ordenados, 95),
        max_ms: ordenados[ordenados.length - 1],
        errores_5xx: grupo.errores_5xx,
      };
    })
    .sort((a, b) => b.n - a.n || a.ruta.localeCompare(b.ruta));

  const totalLentas = Math.min(escriturasLentas, MAX_LENTAS);
  const lentasUltimas = [];
  for (let i = 0; i < totalLentas; i += 1) {
    if (lentas[i]) {
      lentasUltimas.push(lentas[i]);
    }
  }
  lentasUltimas.sort((a, b) => (a.momento < b.momento ? 1 : -1));

  return {
    generado_en: new Date().toISOString(),
    total,
    ventana_muestras: visibles,
    umbral_lento_ms: UMBRAL_LENTO_MS,
    por_ruta: porRuta,
    lentas_ultimas: lentasUltimas,
  };
}

module.exports = { metricsMiddleware, snapshot };
