'use strict';

// FACTORY (patrón Strategy) del envío de comprobantes a SUNAT.
//
// SUNAT_MODE = simulado | beta | produccion   (default: simulado)
//
// - simulado   : no hace red; estado 'no_enviado'.
// - beta       : SOAP real contra el ambiente de pruebas de SUNAT.
// - produccion : SOAP real contra producción (requiere certificado digital).
//
// El factory NUNCA lanza hacia el caller: si el proveedor falla, devuelve
// estado 'error' con el detalle, para no bloquear el cobro ni la venta.

const env = require('../../config/env');
const { MODOS } = require('./sunat.provider');
const simulado = require('./simulado.provider');
const { crearProveedorSoap } = require('./soap.provider');

const BETA_URL = 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService';
const PRODUCCION_URL = 'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService';

function modoActual() {
  const modo = String(env.sunatMode || 'simulado').trim().toLowerCase();
  return MODOS.includes(modo) ? modo : 'simulado';
}

function proveedores() {
  return {
    simulado,
    beta: crearProveedorSoap({
      nombre: 'beta',
      modo: 'beta',
      endpointPorDefecto: BETA_URL,
    }),
    produccion: crearProveedorSoap({
      nombre: 'produccion',
      modo: 'produccion',
      endpointPorDefecto: PRODUCCION_URL,
    }),
  };
}

function proveedorActual() {
  return proveedores()[modoActual()];
}

async function enviar(comprobante) {
  const proveedor = proveedorActual();
  try {
    return await proveedor.enviar(comprobante);
  } catch (error) {
    return {
      modo: proveedor.modo,
      estado: 'error',
      codigo: error.code || 'SUNAT_ERROR',
      mensaje: error.message,
      ticket: null,
      hash: null,
      fecha_envio: new Date().toISOString(),
      endpoint: typeof proveedor.endpoint === 'function' ? proveedor.endpoint() : proveedor.endpoint,
    };
  }
}

function estadoInicial() {
  if (modoActual() === 'simulado') {
    return simulado.estadoInicial();
  }
  return {
    modo: modoActual(),
    estado: 'pendiente',
    codigo: null,
    mensaje: 'Pendiente de envío a SUNAT.',
    ticket: null,
    fecha_envio: null,
  };
}

function estadoDeCuenta(cuenta) {
  const inicial = estadoInicial();
  return {
    modo: cuenta.sunat_modo || inicial.modo,
    estado: cuenta.sunat_estado || inicial.estado,
    codigo: cuenta.sunat_codigo || null,
    mensaje: cuenta.sunat_mensaje || inicial.mensaje || null,
    ticket: cuenta.sunat_ticket || null,
    fecha_envio: cuenta.sunat_fecha_envio || null,
  };
}

function describir() {
  const modo = modoActual();
  const proveedor = proveedorActual();
  return {
    modo,
    endpoint: typeof proveedor.endpoint === 'function' ? proveedor.endpoint() : proveedor.endpoint,
    configurado: proveedor.configurado(),
    modos_disponibles: MODOS,
    requiere_certificado: modo === 'produccion',
    ruc_emisor: env.sunatRuc || null,
  };
}

module.exports = {
  enviar,
  estadoInicial,
  estadoDeCuenta,
  describir,
  modoActual,
  proveedores,
};
