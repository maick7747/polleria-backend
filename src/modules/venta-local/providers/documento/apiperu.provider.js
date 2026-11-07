'use strict';

// Proveedor ApiPeruDev (https://docs.apiperu.dev).
// Plan gratuito con cuota mensual; requiere token Bearer.
//
//   POST {APIPERU_BASE_URL}/dni   { dni }
//   POST {APIPERU_BASE_URL}/ruc   { ruc }
//
// Respuesta: { success, code, data, message? }
//   DNI -> data.nombre_completo
//   RUC -> data.nombre_o_razon_social, estado, condicion, direccion

const env = require('../../../../config/env');
const { fetchJson } = require('../../../../lib/http');
const { ProveedorError } = require('./documento.provider');

const nombre = 'apiperu';
const modo = 'sandbox';

function soporta(tipo) {
  return tipo === 'DNI' || tipo === 'RUC';
}

function baseUrl() {
  return String(env.apiperuBaseUrl || 'https://api.apiperu.dev').replace(/\/+$/, '');
}

async function validar({ tipo, numero }) {
  if (!env.apiperuToken) {
    throw new ProveedorError('Falta APIPERU_TOKEN en la configuración.', {
      code: 'NO_CONFIGURADO',
      retryable: false,
    });
  }

  const endpoint = tipo === 'DNI' ? 'dni' : 'ruc';
  const cuerpo = tipo === 'DNI' ? { dni: numero } : { ruc: numero };

  let respuesta;
  try {
    respuesta = await fetchJson(`${baseUrl()}/${endpoint}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.apiperuToken}`,
      },
      body: JSON.stringify(cuerpo),
      timeoutMs: env.documentoTimeoutMs,
    });
  } catch (error) {
    // 404/400 = documento inexistente, no es una falla del proveedor.
    if (error.status === 404 || error.status === 400) {
      return {
        valido: false,
        tipo_documento: tipo,
        numero_documento: numero,
        nombre: null,
        motivo: 'Documento no encontrado en el padrón público.',
        datos: null,
      };
    }
    throw error;
  }

  if (!respuesta || respuesta.success !== true) {
    return {
      valido: false,
      tipo_documento: tipo,
      numero_documento: numero,
      nombre: null,
      motivo: (respuesta && (respuesta.message || respuesta.code)) || 'Documento no encontrado.',
      datos: null,
    };
  }

  const data = respuesta.data || {};

  if (tipo === 'DNI') {
    return {
      valido: true,
      tipo_documento: tipo,
      numero_documento: numero,
      nombre: data.nombre_completo || null,
      motivo: null,
      datos: {
        nombres: data.nombres || null,
        apellido_paterno: data.apellido_paterno || null,
        apellido_materno: data.apellido_materno || null,
      },
    };
  }

  return {
    valido: true,
    tipo_documento: tipo,
    numero_documento: numero,
    nombre: data.nombre_o_razon_social || null,
    motivo: null,
    datos: {
      estado: data.estado || null,
      condicion: data.condicion || null,
      direccion: data.direccion || null,
      ubigeo: data.ubigeo || null,
    },
  };
}

module.exports = { nombre, modo, soporta, validar };
