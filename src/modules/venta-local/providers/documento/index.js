'use strict';

// FACTORY (patrón Strategy) de validación de documentos.
//
// Resuelve el proveedor a partir de DOCUMENTO_PROVIDER y aplica una cadena de
// fallback (DOCUMENTO_FALLBACK). Si todos fallan, devuelve un resultado
// "manual" que NO bloquea la venta (RN-VL-014).
//
// Variables de entorno:
//   DOCUMENTO_PROVIDER      mock | apiperu | openruc   (default: mock)
//   DOCUMENTO_FALLBACK      mock | apiperu | openruc | none (default: mock)
//   DOCUMENTO_CACHE_TTL_SEC segundos de caché por documento (default: 86400)

const env = require('../../../../config/env');
const { ProveedorError, normalizarEntrada } = require('./documento.provider');

const PROVEEDORES = {
  mock: require('./mock.provider'),
  apiperu: require('./apiperu.provider'),
  openruc: require('./openruc.provider'),
};

const cache = new Map();

function limpiarCache() {
  cache.clear();
}

function ttlMs() {
  const segundos = Number(env.documentoCacheTtlSec);
  return Number.isFinite(segundos) && segundos > 0 ? segundos * 1000 : 0;
}

function leerCache(clave) {
  const entrada = cache.get(clave);
  if (!entrada) {
    return null;
  }
  if (entrada.expira <= Date.now()) {
    cache.delete(clave);
    return null;
  }
  return { ...entrada.resultado, cache: true };
}

function guardarCache(clave, resultado) {
  const ms = ttlMs();
  if (ms <= 0) {
    return;
  }
  cache.set(clave, { resultado, expira: Date.now() + ms });
}

function resolverNombre(valor, defecto) {
  const nombre = String(valor || defecto || '').trim().toLowerCase();
  if (!nombre || nombre === 'none' || nombre === 'ninguno') {
    return null;
  }
  return Object.prototype.hasOwnProperty.call(PROVEEDORES, nombre) ? nombre : null;
}

function cadenaDeProveedores() {
  const primario = resolverNombre(env.documentoProvider, 'mock');
  const fallback = resolverNombre(env.documentoFallback, 'mock');
  return [primario, fallback].filter((nombre, index, lista) => nombre && lista.indexOf(nombre) === index);
}

async function validarDocumento({ tipo, numero }) {
  const entrada = normalizarEntrada({ tipo, numero });
  const clave = `${entrada.tipo}:${entrada.numero}`;

  const enCache = leerCache(clave);
  if (enCache) {
    return enCache;
  }

  const intentos = [];

  for (const nombre of cadenaDeProveedores()) {
    const proveedor = PROVEEDORES[nombre];

    if (!proveedor.soporta(entrada.tipo)) {
      intentos.push({ proveedor: nombre, codigo: 'NO_SOPORTADO', mensaje: `No atiende ${entrada.tipo}.` });
      continue;
    }

    try {
      const resultado = await proveedor.validar(entrada);
      const respuesta = {
        ...resultado,
        modo: proveedor.modo,
        fuente: proveedor.nombre,
        cache: false,
      };
      guardarCache(clave, respuesta);
      return respuesta;
    } catch (error) {
      intentos.push({
        proveedor: nombre,
        codigo: error instanceof ProveedorError ? error.code : 'ERROR_INESPERADO',
        mensaje: error.message,
      });
    }
  }

  return {
    valido: false,
    tipo_documento: entrada.tipo,
    numero_documento: entrada.numero,
    nombre: null,
    motivo: 'No se pudo validar el documento. Se permite el registro manual sin bloquear la venta.',
    datos: null,
    modo: 'manual',
    fuente: 'ninguno',
    cache: false,
    intentos,
  };
}

function describir() {
  const configurado = {};
  for (const [nombre, proveedor] of Object.entries(PROVEEDORES)) {
    const requiereToken = nombre === 'apiperu';
    configurado[nombre] = typeof proveedor.validar === 'function'
      && (!requiereToken || Boolean(env.apiperuToken));
  }

  return {
    proveedor: resolverNombre(env.documentoProvider, 'mock'),
    fallback: resolverNombre(env.documentoFallback, 'mock'),
    proveedores_disponibles: Object.keys(PROVEEDORES),
    configurado,
    cache_ttl_sec: Math.round(ttlMs() / 1000),
    cache_entradas: cache.size,
  };
}

module.exports = {
  validarDocumento,
  describir,
  limpiarCache,
  PROVEEDORES,
};
