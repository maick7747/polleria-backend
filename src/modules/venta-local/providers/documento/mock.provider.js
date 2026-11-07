'use strict';

// Proveedor simulado: no hace red. Valida solo formato (longitud y dígitos).
// Es el comportamiento histórico del endpoint y el fallback por defecto.

const { longitudEsperada, soloDigitos } = require('./documento.provider');

const nombre = 'mock';
const modo = 'mock';

function soporta(tipo) {
  return tipo === 'DNI' || tipo === 'RUC';
}

async function validar({ tipo, numero }) {
  const esperado = longitudEsperada(tipo);
  const formatoOk = soloDigitos(numero) && numero.length === esperado;

  return {
    valido: formatoOk,
    tipo_documento: tipo,
    numero_documento: numero,
    nombre: formatoOk ? (tipo === 'DNI' ? 'Cliente Demo DNI' : 'Empresa Demo RUC') : null,
    motivo: formatoOk ? null : `El ${tipo} debe tener ${esperado} dígitos numéricos.`,
    datos: null,
  };
}

module.exports = { nombre, modo, soporta, validar };
