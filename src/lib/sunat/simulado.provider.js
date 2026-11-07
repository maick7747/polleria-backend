'use strict';

// Proveedor simulado: no hace red y no envía nada.
// Es el modo por defecto y mantiene el contrato histórico
// `sunat: { modo: 'simulado', estado: 'no_enviado' }`.

const crypto = require('crypto');

const nombre = 'simulado';
const modo = 'simulado';
const endpoint = null;

function configurado() {
  return true;
}

function hashDe(comprobante) {
  const base = JSON.stringify({
    numero: comprobante.numero,
    tipo: comprobante.tipo,
    total: comprobante.total,
  });
  return crypto.createHash('sha256').update(base).digest('hex');
}

async function enviar(comprobante) {
  return {
    modo,
    estado: 'no_enviado',
    codigo: null,
    mensaje: 'SUNAT simulado: el comprobante no se envía y no tiene validez tributaria.',
    ticket: null,
    hash: hashDe(comprobante),
    fecha_envio: null,
    endpoint: null,
  };
}

function estadoInicial() {
  return {
    modo,
    estado: 'no_enviado',
    codigo: null,
    mensaje: null,
    ticket: null,
    fecha_envio: null,
  };
}

module.exports = { nombre, modo, endpoint, configurado, enviar, estadoInicial, hashDe };
