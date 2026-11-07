'use strict';

const store = require('../../data/store');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredString,
  requiredNumber,
  requiredEnum,
  optionalString,
  optionalDate,
  paginate,
  parseId,
} = require('../../middleware/validate');
const pedidosLib = require('../../lib/pedidos');
const deliveryPropio = require('../delivery-propio/delivery-propio.service');

const PLATAFORMAS = ['rappi', 'llamafood'];

function tasaComision(plataforma) {
  const clave = plataforma === 'rappi' ? 'comision_rappi_pct' : 'comision_llamafood_pct';
  return (Number(store.getConfig(clave)) || 0) / 100;
}

function listPedidos(query = {}) {
  const plataforma = query.plataforma
    ? requiredEnum(query.plataforma, 'plataforma', PLATAFORMAS)
    : null;
  const estado = query.estado
    ? requiredEnum(query.estado, 'estado', ['borrador', 'en_cocina', 'servido', 'cobrado', 'cancelado'])
    : null;

  const data = store.state.pedidos
    .filter((pedido) => PLATAFORMAS.includes(pedido.canal))
    .filter((pedido) => !plataforma || pedido.canal === plataforma)
    .filter((pedido) => !estado || pedido.estado === estado)
    .sort((a, b) => b.id - a.id)
    .map((pedido) => pedidosLib.pedidoConDetalles(pedido));

  return paginate(data, query);
}

function crearPedido(body, usuario) {
  const payload = requiredObject(body);
  const plataforma = requiredEnum(payload.plataforma || payload.canal, 'plataforma', PLATAFORMAS);
  store.requireCajaAbierta();

  const cliente = payload.cliente ? deliveryPropio.crearCliente(payload.cliente) : null;
  const direccion = payload.direccion_entrega
    || (payload.cliente && payload.cliente.direccion)
    || null;

  if (!direccion) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El delivery externo requiere dirección de entrega.', [
      { field: 'direccion_entrega' },
    ]);
  }

  const pedido = pedidosLib.createPedidoRecord({
    canal: plataforma,
    tipo_consumo: 'delivery',
    items: payload.items,
    cliente_id: cliente ? cliente.id : null,
    usuario_id: usuario.id,
    observaciones: payload.observaciones,
    direccion_entrega: direccion,
    referencia_entrega: payload.referencia_entrega || null,
  });

  const comision = store.round2(pedido.total * tasaComision(plataforma));
  pedido.comision_plataforma = comision;
  pedido.monto_neto = store.round2(pedido.total - comision);

  return {
    ...pedidosLib.pedidoConDetalles(pedido),
    comision_pct: tasaComision(plataforma) * 100,
    monto_bruto: pedido.total,
    comision,
    monto_neto: pedido.monto_neto,
  };
}

function aceptarPedido(id, usuario) {
  const pedido = store.findOrThrow('pedidos', parseId(id), 'Pedido');
  if (pedido.estado !== 'borrador') {
    throw new AppError(409, 'CONFLICT', 'Solo un pedido en borrador puede aceptarse.');
  }
  const result = pedidosLib.enviarPedidoACocina(pedido, usuario.id);
  return {
    ...pedidosLib.pedidoConDetalles(result.pedido),
    movimientos_inventario: result.movimientos.length,
  };
}

function cancelarPedido(id, body, usuario) {
  const pedido = store.findOrThrow('pedidos', parseId(id), 'Pedido');
  const payload = requiredObject(body || {});
  const motivo = optionalString(payload.motivo, 'motivo', { max: 300 });

  if (pedido.estado === 'cancelado') {
    throw new AppError(409, 'CONFLICT', 'El pedido ya está cancelado.');
  }

  const movimientos = pedidosLib.revertirStockPedido(
    pedido,
    usuario.id,
    motivo || 'Cancelación de delivery externo',
  );
  pedido.estado = 'cancelado';
  pedido.fecha_cancelacion = store.nowIso();
  pedido.motivo_cancelacion = motivo;

  return {
    ...pedidosLib.pedidoConDetalles(pedido),
    movimientos_inventario: movimientos.length,
    stock_revertido: movimientos.length > 0,
  };
}

function listLiquidaciones(query = {}) {
  const plataforma = query.plataforma
    ? requiredEnum(query.plataforma, 'plataforma', PLATAFORMAS)
    : null;
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');

  const data = store.state.liquidaciones
    .filter((item) => !plataforma || item.plataforma === plataforma)
    .filter((item) => !desde || item.fecha >= desde)
    .filter((item) => !hasta || item.fecha <= hasta)
    .sort((a, b) => b.id - a.id);

  return paginate(data, query);
}

function crearLiquidacion(body, usuario) {
  const payload = requiredObject(body);
  const plataforma = requiredEnum(payload.plataforma, 'plataforma', PLATAFORMAS);
  const fecha = optionalDate(payload.fecha, 'fecha') || store.today();
  const montoBruto = requiredNumber(payload.monto_bruto, 'monto_bruto', { min: 0.01 });
  const comision = payload.comision === undefined
    ? store.round2(montoBruto * tasaComision(plataforma))
    : requiredNumber(payload.comision, 'comision', { min: 0 });
  const montoNeto = payload.monto_neto === undefined
    ? store.round2(montoBruto - comision)
    : requiredNumber(payload.monto_neto, 'monto_neto', { min: 0 });

  const liquidacion = {
    id: store.nextId('liquidaciones'),
    plataforma,
    fecha,
    monto_bruto: store.round2(montoBruto),
    comision: store.round2(comision),
    monto_neto: store.round2(montoNeto),
    referencia: optionalString(payload.referencia, 'referencia', { max: 60 }),
    usuario_id: usuario.id,
    creado_en: store.nowIso(),
  };
  store.state.liquidaciones.push(liquidacion);
  return liquidacion;
}

module.exports = {
  PLATAFORMAS,
  tasaComision,
  listPedidos,
  crearPedido,
  aceptarPedido,
  cancelarPedido,
  listLiquidaciones,
  crearLiquidacion,
};
