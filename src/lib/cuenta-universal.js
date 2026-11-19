'use strict';

// Cuenta universal: toda venta que entra a la caja tiene una cuenta.
//
//   * sala        -> cuenta con mesa (comportamiento histórico)
//   * para_llevar -> cuenta sin mesa, se cobra al recoger
//   * delivery    -> cuenta sin mesa, contraentrega del delivery propio
//   * delivery externo (Rappi / LlamaFood) -> sin cuenta: lo liquida la
//     plataforma y no entra a la caja física.
//
// La cuenta es la unidad de cobro; el pedido es la unidad de producción.

const store = require('../data/store');
const repository = require('../data/repository');
const db = require('../data/db');
const { AppError } = require('../middleware/error');

const CANALES_DELIVERY_PROPIO = new Set(['whatsapp', 'telefono', 'local']);

function necesitaCuenta(tipoConsumo, canal) {
  if (tipoConsumo === 'sala' || tipoConsumo === 'para_llevar') {
    return true;
  }
  if (tipoConsumo === 'delivery') {
    return CANALES_DELIVERY_PROPIO.has(canal || 'whatsapp');
  }
  return false;
}

function tipoServicioDe(tipoConsumo) {
  if (tipoConsumo === 'para_llevar') {
    return 'para_llevar';
  }
  if (tipoConsumo === 'delivery') {
    return 'delivery';
  }
  return 'sala';
}

// Cuenta abierta sin mesa para una venta de mostrador o delivery propio.
async function crearCuenta({ tipoServicio, usuarioId, clienteId = null }) {
  const fila = {
    mesa_id: null,
    tipo_servicio: tipoServicio,
    estado: 'abierta',
    total: 0,
    fecha_apertura: db.isSupabase() ? db.nowIso() : store.nowIso(),
    usuario_apertura_id: usuarioId,
    cliente_id: clienteId || null,
    comprobante_tipo: 'boleta',
  };

  if (!db.isSupabase()) {
    const cuenta = {
      id: store.nextId('cuentas'),
      ...fila,
      fecha_cierre: null,
      usuario_cierre_id: null,
      comprobante_numero: null,
    };
    store.state.cuentas.push(cuenta);
    return cuenta;
  }

  try {
    return await repository.insert('cuentas', fila);
  } catch (error) {
    throw db.persistenceError('No se pudo abrir la cuenta de la venta.', error);
  }
}

// Devuelve la cuenta del pedido; si es histórico (sin cuenta) la crea y
// reengancha los pagos que estuvieran colgados del pedido.
async function asegurarCuentaDePedido(pedido, usuario) {
  if (pedido.cuenta_id) {
    return Number(pedido.cuenta_id);
  }

  if (!necesitaCuenta(pedido.tipo_consumo, pedido.canal)) {
    throw new AppError(
      422,
      'BUSINESS_RULE_VIOLATION',
      'Este pedido no se cobra en caja: el delivery externo lo liquida la plataforma.',
    );
  }

  const cuenta = await crearCuenta({
    tipoServicio: tipoServicioDe(pedido.tipo_consumo),
    usuarioId: usuario.id,
    clienteId: pedido.cliente_id,
  });

  await repository.update('pedidos', pedido.id, { cuenta_id: cuenta.id });

  // Pagos históricos del pedido (contraentrega) pasan a colgar de la cuenta.
  try {
    await repository.updateWhere(
      'pagos',
      { pedido_id: pedido.id, cuenta_id: null },
      { cuenta_id: cuenta.id },
    );
  } catch {
    // El pago huérfano no debe impedir el cobro; la cuenta ya quedó enlazada.
  }

  pedido.cuenta_id = cuenta.id;
  return Number(cuenta.id);
}

// Marca todas las líneas del pedido como entregadas. Se usa al confirmar la
// entrega en mostrador (el cliente se lleva el pedido) y en el contraentrega
// (el repartidor ya lo entregó en la puerta).
async function marcarLineasEntregadas(pedidoId, usuarioId) {
  const ahora = db.isSupabase() ? db.nowIso() : store.nowIso();
  const filas = await repository.updateWhere(
    'pedido_detalles',
    { pedido_id: Number(pedidoId), entregado_en: null },
    { entregado_en: ahora, entregado_por_id: usuarioId || null },
  );
  return filas.length;
}

// Líneas que todavía no están listas (ni entregadas). Es el candado de
// mostrador: no se cobra un pedido que sigue en cocina.
async function lineasPendientesDeListo(pedidoId) {
  const { data } = await repository.list('pedido_detalles', {
    filters: { pedido_id: Number(pedidoId) },
    orderBy: 'id',
    ascending: true,
    limit: 100,
  });
  return data.filter(
    (linea) => !linea.entregado_en && linea.estado_preparacion !== 'listo',
  );
}

module.exports = {
  necesitaCuenta,
  tipoServicioDe,
  crearCuenta,
  asegurarCuentaDePedido,
  marcarLineasEntregadas,
  lineasPendientesDeListo,
};
