'use strict';

const store = require('../../data/store');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredString,
  requiredInt,
  requiredEnum,
  optionalString,
  optionalNumber,
  paginate,
  parseId,
} = require('../../middleware/validate');
const pedidosLib = require('../../lib/pedidos');

const CANALES_PROPIO = ['whatsapp', 'telefono', 'delivery_propio'];
const METODOS_ENTREGA = ['efectivo', 'yape', 'plin', 'tarjeta'];

function crearCliente(cliente) {
  const payload = requiredObject(cliente, 'cliente');
  const nombre = requiredString(payload.nombre, 'cliente.nombre', { max: 120 });
  const existente = store.state.clientes.find(
    (item) => item.nombre.toLowerCase() === nombre.toLowerCase() && item.telefono === payload.telefono,
  );
  if (existente) {
    return existente;
  }

  const record = {
    id: store.nextId('clientes'),
    nombre,
    tipo_documento: null,
    numero_documento: null,
    telefono: optionalString(payload.telefono, 'cliente.telefono', { max: 20 }),
    direccion: optionalString(payload.direccion, 'cliente.direccion', { max: 200 }),
    referencia: optionalString(payload.referencia, 'cliente.referencia', { max: 150 }),
    creado_en: store.nowIso(),
    actualizado_en: store.nowIso(),
  };
  store.state.clientes.push(record);
  return record;
}

function listPedidos(query = {}) {
  const estado = query.estado ? String(query.estado) : null;
  const repartidorId = query.repartidor_id ? parseId(query.repartidor_id, 'repartidor_id') : null;

  const data = store.state.pedidos
    .filter((pedido) => pedido.tipo_consumo === 'delivery' && CANALES_PROPIO.includes(pedido.canal))
    .filter((pedido) => !estado || pedido.estado === estado || pedido.estado_entrega === estado)
    .filter((pedido) => !repartidorId || pedido.repartidor_id === repartidorId)
    .sort((a, b) => b.id - a.id)
    .map((pedido) => {
      const detalle = pedidosLib.pedidoConDetalles(pedido);
      return {
        ...detalle,
        minutos_desde_pedido: Math.max(
          0,
          Math.round((Date.now() - Date.parse(pedido.fecha_pedido)) / 60000),
        ),
      };
    });

  return paginate(data, query);
}

function crearPedido(body, usuario) {
  const payload = requiredObject(body);
  const canal = requiredEnum(payload.canal || 'whatsapp', 'canal', CANALES_PROPIO);
  store.requireCajaAbierta();

  const cliente = payload.cliente ? crearCliente(payload.cliente) : null;
  const direccion = payload.cliente && payload.cliente.direccion
    ? requiredString(payload.cliente.direccion, 'cliente.direccion', { max: 200 })
    : optionalString(payload.direccion_entrega, 'direccion_entrega', { max: 200 });

  if (!direccion) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El delivery requiere dirección de entrega.', [
      { field: 'cliente.direccion' },
    ]);
  }

  const pedido = pedidosLib.createPedidoRecord({
    canal,
    tipo_consumo: 'delivery',
    items: payload.items,
    cliente_id: cliente ? cliente.id : null,
    usuario_id: usuario.id,
    observaciones: payload.observaciones,
    direccion_entrega: direccion,
    referencia_entrega: payload.cliente ? payload.cliente.referencia : null,
    costo_delivery: optionalNumber(payload.costo_delivery, 'costo_delivery', { min: 0 }) || 0,
  });

  const debeEnviar = payload.enviar_cocina !== false;
  if (debeEnviar) {
    pedidosLib.enviarPedidoACocina(pedido, usuario.id);
  }

  return pedidosLib.pedidoConDetalles(pedido);
}

function asignarRepartidor(id, body) {
  const pedido = store.findOrThrow('pedidos', parseId(id), 'Pedido');
  const payload = requiredObject(body);
  const repartidorId = requiredInt(payload.repartidor_id, 'repartidor_id', { min: 1 });
  const repartidor = store.findOrThrow('usuarios', repartidorId, 'Repartidor');

  if (!repartidor.roles.includes('Repartidor') && !repartidor.roles.includes('Dueño/Admin')) {
    throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'El usuario indicado no tiene rol de Repartidor.');
  }

  pedido.repartidor_id = repartidor.id;
  return pedidosLib.pedidoConDetalles(pedido);
}

function actualizarEstado(id, body) {
  const pedido = store.findOrThrow('pedidos', parseId(id), 'Pedido');
  const payload = requiredObject(body);
  const estado = requiredEnum(payload.estado, 'estado', ['en_camino', 'entregado']);

  if (pedido.estado === 'cancelado') {
    throw new AppError(409, 'CONFLICT', 'El pedido está cancelado.');
  }

  if (estado === 'en_camino') {
    if (!pedido.repartidor_id) {
      throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'Asigne un repartidor antes de iniciar la entrega.');
    }
    pedido.estado_entrega = 'en_camino';
  } else {
    pedido.estado_entrega = 'entregado';
    pedido.fecha_entrega = store.nowIso();
  }

  return pedidosLib.pedidoConDetalles(pedido);
}

function registrarEntrega(id, body, usuario) {
  const pedido = store.findOrThrow('pedidos', parseId(id), 'Pedido');
  const payload = requiredObject(body);
  const metodo = requiredEnum(payload.metodo, 'metodo', METODOS_ENTREGA);
  store.requireCajaAbierta();

  if (pedido.estado === 'cancelado') {
    throw new AppError(409, 'CONFLICT', 'El pedido está cancelado.');
  }
  if (pedido.estado_pago === 'pagado') {
    throw new AppError(409, 'CONFLICT', 'El pedido ya fue cobrado.');
  }

  const monto = payload.monto === undefined
    ? pedido.total
    : optionalNumber(payload.monto, 'monto', { min: 0 });
  if (monto + 0.009 < pedido.total) {
    throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'El monto recibido es menor al total del pedido.', [
      { total: pedido.total, monto },
    ]);
  }

  const ahora = store.nowIso();
  pedido.estado = 'cobrado';
  pedido.estado_pago = 'pagado';
  pedido.metodo_pago = metodo;
  pedido.estado_entrega = 'entregado';
  pedido.fecha_entrega = pedido.fecha_entrega || ahora;

  const pago = store.addPago({
    pedido_id: pedido.id,
    metodo,
    monto: pedido.total,
    es_contraentrega: true,
    usuario_id: usuario.id,
    fecha: ahora,
  });

  return {
    pedido: pedidosLib.pedidoConDetalles(pedido),
    pago,
    vuelto: store.round2(Math.max(0, monto - pedido.total)),
  };
}

module.exports = {
  crearCliente,
  CANALES_PROPIO,
  METODOS_ENTREGA,
  listPedidos,
  crearPedido,
  asignarRepartidor,
  actualizarEstado,
  registrarEntrega,
};

