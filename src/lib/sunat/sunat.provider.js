'use strict';

// PUERTO (patrón Strategy) para el envío de comprobantes a SUNAT.
//
// Cada proveedor concreto (simulado, beta, produccion) debe exportar:
//
//   nombre   : string   'simulado' | 'beta' | 'produccion'
//   modo     : string   igual a nombre
//   endpoint : string|null
//   configurado() : boolean
//   async enviar(comprobante) : ResultadoSunat
//
// ResultadoSunat:
//   {
//     modo, estado, codigo, mensaje, ticket, hash, fecha_envio, endpoint
//   }
//
// estado: 'no_enviado' | 'pendiente' | 'aceptado' | 'observado' | 'rechazado' | 'error'

class SunatError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SunatError';
    this.code = options.code || 'SUNAT_ERROR';
    this.retryable = Boolean(options.retryable);
    this.detalle = options.detalle === undefined ? null : options.detalle;
  }
}

const MODOS = ['simulado', 'beta', 'produccion'];
const ESTADOS = [
  'no_enviado',
  'pendiente',
  'aceptado',
  'observado',
  'rechazado',
  'error',
];

const CODIGOS_OBSERVADOS = ['2326', '2327', '2328'];

function estadoDesdeCodigo(codigo) {
  const valor = String(codigo === null || codigo === undefined ? '' : codigo).trim();
  if (valor === '0') {
    return 'aceptado';
  }
  if (CODIGOS_OBSERVADOS.includes(valor)) {
    return 'observado';
  }
  return 'rechazado';
}

module.exports = { SunatError, MODOS, ESTADOS, estadoDesdeCodigo };
