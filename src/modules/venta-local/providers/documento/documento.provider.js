'use strict';

// PUERTO (patrón Strategy) para la validación de documentos de identidad.
//
// Cada proveedor concreto (mock, apiperu, openruc) debe exportar:
//
//   nombre : string          Identificador corto (ej. 'apiperu').
//   modo   : string          'sandbox' | 'mock' (entorno lógico).
//   soporta(tipo) : boolean  ¿Atiende 'DNI' y/o 'RUC'?
//   async validar({ tipo, numero }) : ResultadoDocumento
//
// ResultadoDocumento:
//   {
//     valido: boolean,
//     tipo_documento: 'DNI' | 'RUC',
//     numero_documento: string,
//     nombre: string | null,
//     motivo: string | null,
//     datos: object | null,       // estado, condición, dirección, etc.
//   }
//
// Si el proveedor no puede responder (red, cuota, credencial faltante),
// debe lanzar ProveedorError y el factory decidirá el fallback.

class ProveedorError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ProveedorError';
    this.code = options.code || 'PROVEEDOR_ERROR';
    this.retryable = Boolean(options.retryable);
    this.detalle = options.detalle === undefined ? null : options.detalle;
  }
}

const TIPOS = ['DNI', 'RUC'];

function normalizarEntrada({ tipo, numero }) {
  const tipoDocumento = String(tipo || '').trim().toUpperCase();
  const numeroDocumento = String(numero || '').trim();
  return { tipo: tipoDocumento, numero: numeroDocumento };
}

function longitudEsperada(tipo) {
  return tipo === 'DNI' ? 8 : 11;
}

function soloDigitos(numero) {
  return /^\d+$/.test(String(numero));
}

module.exports = {
  ProveedorError,
  TIPOS,
  normalizarEntrada,
  longitudEsperada,
  soloDigitos,
};
