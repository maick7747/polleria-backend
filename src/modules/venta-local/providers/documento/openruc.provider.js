'use strict';

// Proveedor OpenRUC (https://openruc.com): API abierta, sin token.
//
//   GET {OPENRUC_BASE_URL}/api/ruc/{ruc}
//
// Solo cubre RUC. Para DNI se declara no soportado y el factory usa el fallback.

const env = require('../../../../config/env');
const { fetchJson } = require('../../../../lib/http');
const { ProveedorError } = require('./documento.provider');

const nombre = 'openruc';
const modo = 'sandbox';

function soporta(tipo) {
  return tipo === 'RUC';
}

function baseUrl() {
  return String(env.openrucBaseUrl || 'https://openruc.com').replace(/\/+$/, '');
}

async function validar({ tipo, numero }) {
  if (!soporta(tipo)) {
    throw new ProveedorError(`OpenRUC no soporta ${tipo}.`, {
      code: 'NO_SOPORTADO',
      retryable: false,
    });
  }

  let data;
  try {
    data = await fetchJson(`${baseUrl()}/api/ruc/${encodeURIComponent(numero)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs: env.documentoTimeoutMs,
    });
  } catch (error) {
    if (error.status === 404 || error.status === 400) {
      return {
        valido: false,
        tipo_documento: tipo,
        numero_documento: numero,
        nombre: null,
        motivo: 'RUC no encontrado en el padrón público.',
        datos: null,
      };
    }
    throw error;
  }

  if (!data || !data.ruc) {
    return {
      valido: false,
      tipo_documento: tipo,
      numero_documento: numero,
      nombre: null,
      motivo: 'RUC no encontrado en el padrón público.',
      datos: null,
    };
  }

  return {
    valido: true,
    tipo_documento: tipo,
    numero_documento: numero,
    nombre: data.razon_social || null,
    motivo: null,
    datos: {
      estado: data.estado || null,
      condicion: data.condicion || null,
      direccion: data.direccion || null,
      ubigeo: data.ubigeo || null,
      actualizado_al: data.as_of || null,
    },
  };
}

module.exports = { nombre, modo, soporta, validar };
