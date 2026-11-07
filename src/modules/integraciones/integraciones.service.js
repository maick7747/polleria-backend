'use strict';

// Estado de las integraciones externas (sin exponer credenciales).
// Sirve para verificar qué proveedor está activo y si está configurado.

const documento = require('../venta-local/providers/documento');
const sunat = require('../../lib/sunat');

function estado() {
  return {
    documento: documento.describir(),
    sunat: sunat.describir(),
    actualizado_en: new Date().toISOString(),
  };
}

module.exports = { estado };
