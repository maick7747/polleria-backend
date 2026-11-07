'use strict';

const store = require('../data/store');
const { AppError } = require('../middleware/error');
const {
  requiredArray,
  requiredInt,
  requiredEnum,
  optionalString,
  requiredString,
} = require('../middleware/validate');

const CANALES = ['local', 'whatsapp', 'telefono', 'delivery_propio', 'rappi', 'llamafood'];
const TIPOS_CONSUMO = ['sala', 'para_llevar', 'delivery'];

function buildDetalles(items) {
  const list = requiredArray(items, 'items', { max: 100 });
  let subtotal = 0;

  const detalles = list.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new AppError(400, 'VALIDATION_ERROR', `El ítem ${index + 1} no es válido.`, [
        { field: `items[${index}]` },
      ]);
    }
    const platilloId = requiredInt(item.platillo_id, `items[${index}].platillo_id`, { min: 1 });
    const cantidad = requiredInt(item.cantidad, `items[${index}].cantidad`, { min: 1, max: 999 });
    const platillo = store.findOrThrow('platillos', platilloId, 'Platillo');
    if (!platillo.activo) {
      throw new AppError(422, 'BUSINESS_RULE_VIOLATION', `El platillo "${platillo.nombre}" está inactivo.`);
    }
    const notas = optionalString(item.notas, `items[${index}].notas`, { max: 200 });
    const lineSubtotal = store.round2(cantidad * platillo.precio_venta);
    subtotal += lineSubtotal;
    return {
      platillo_id: platillo.id,
      cantidad,
      precio_unitario: platillo.precio_venta,
      subtotal: lineSubtotal,
      notas,
    };
  });

  return { detalles, subtotal: store.round2(subtotal) };
}

function createPedidoRecord(options) {
  const {
    canal,
    tipo_consumo,
    items,
    mesa_id = null,
    cuenta_id = null,
    cliente_id = null,
    repartidor_id = null,
    usuario_id,
    estado = 'borrador',
    estado_pago = 'pendiente',
    metodo_pago = null,
    observaciones = null,
    direccion_entrega = null,
    referencia_entrega = null,
    costo_delivery = 0,
    comision_plataforma = 0,
    fecha_pedido = store.nowIso(),
  } = options;

  requiredEnum(canal, 'canal', CANALES);
  requiredEnum(tipo_consumo, 'tipo_consumo', TIPOS_CONSUMO);

  if (tipo_consumo === 'sala' && !mesa_id) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El pedido de sala requiere mesa_id.');
  }
  if (tipo_consumo === 'delivery' && !direccion_entrega) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El pedido de delivery requiere direccion_entrega.');
  }

  const { detalles, subtotal } = buildDetalles(items);
  const totals = store.calcTotals(subtotal, Number(costo_delivery) || 0);

  const pedido = {
    id: store.nextId('pedidos'),
    numero: store.generarNumeroPedido(),
    fecha_pedido,
    canal,
    tipo_consumo,
    mesa_id: mesa_id || null,
    cuenta_id: cuenta_id || null,
    cliente_id: cliente_id || null,
    repartidor_id: repartidor_id || null,
    usuario_cajero_id: usuario_id,
    estado,
    estado_pago,
    metodo_pago,
    subtotal: totals.subtotal,
    igv: totals.igv,
    total: totals.total,
    comision_plataforma: store.round2(comision_plataforma),
    costo_delivery: store.round2(costo_delivery),
    direccion_entrega,
    referencia_entrega,
    observaciones: observaciones ? requiredString(observaciones, 'observaciones', { max: 300 }) : null,
    comprobante_tipo: tipo_consumo === 'sala' ? 'boleta' : 'ticket',
    comprobante_numero: null,
    fecha_inicio_prep: null,
    fecha_listo: null,
    fecha_entrega: null,
    estado_entrega: null,
    stock_descontado: false,
    creado_en: store.nowIso(),
  };

  store.state.pedidos.push(pedido);

  for (const detail of detalles) {
    store.state.pedido_detalles.push({
      id: store.nextId('pedido_detalles'),
      pedido_id: pedido.id,
      platillo_id: detail.platillo_id,
      cantidad: detail.cantidad,
      precio_unitario: detail.precio_unitario,
      subtotal: detail.subtotal,
      notas: detail.notas,
      estado_preparacion: 'pendiente',
      fecha_inicio_prep: null,
      fecha_listo: null,
    });
  }

  return pedido;
}

function detallesDePedido(pedidoId) {
  return store.state.pedido_detalles
    .filter((detail) => detail.pedido_id === Number(pedidoId))
    .map((detail) => {
      const platillo = store.find('platillos', detail.platillo_id);
      return {
        ...detail,
        platillo_nombre: platillo ? platillo.nombre : null,
      };
    });
}

function pedidoConDetalles(pedido) {
  const mesa = pedido.mesa_id ? store.find('mesas', pedido.mesa_id) : null;
  const cliente = pedido.cliente_id ? store.find('clientes', pedido.cliente_id) : null;
  const repartidor = pedido.repartidor_id ? store.find('usuarios', pedido.repartidor_id) : null;
  return {
    ...pedido,
    mesa_numero: mesa ? mesa.numero : null,
    cliente_nombre: cliente ? cliente.nombre : null,
    repartidor_nombre: repartidor ? repartidor.nombre : null,
    detalles: detallesDePedido(pedido.id),
  };
}

function fichaDePlatillo(platilloId) {
  return store.state.fichas_tecnicas.find(
    (ficha) => ficha.platillo_id === Number(platilloId) && ficha.activa,
  ) || null;
}

function requerimientosDePedido(pedido) {
  const requerimientos = new Map();
  const detalles = store.state.pedido_detalles.filter((detail) => detail.pedido_id === pedido.id);

  for (const detail of detalles) {
    const ficha = fichaDePlatillo(detail.platillo_id);
    if (!ficha) {
      continue;
    }
    const porciones = ficha.porciones_rendimiento || 1;
    const ingredientes = store.state.fichas_tecnicas_detalle.filter(
      (ingredient) => ingredient.ficha_id === ficha.id,
    );
    for (const ingredient of ingredientes) {
      const cantidad = (ingredient.cantidad / porciones) * detail.cantidad;
      requerimientos.set(
        ingredient.insumo_id,
        (requerimientos.get(ingredient.insumo_id) || 0) + cantidad,
      );
    }
  }

  return requerimientos;
}

function validarStockPedido(pedido) {
  const requerimientos = requerimientosDePedido(pedido);
  const faltantes = [];

  for (const [insumoId, cantidad] of requerimientos.entries()) {
    const insumo = store.find('insumos', insumoId);
    if (!insumo) {
      continue;
    }
    if (insumo.stock_actual + 0.0005 < cantidad) {
      faltantes.push({
        insumo_id: insumo.id,
        insumo: insumo.nombre,
        disponible: insumo.stock_actual,
        requerido: store.round3(cantidad),
      });
    }
  }

  if (faltantes.length > 0) {
    throw new AppError(409, 'STOCK_INSUFICIENTE', 'No hay stock suficiente para preparar el pedido.', faltantes);
  }

  return requerimientos;
}

function descontarStockPedido(pedido, usuarioId) {
  if (pedido.stock_descontado) {
    return [];
  }
  const requerimientos = validarStockPedido(pedido);
  const movimientos = [];
  for (const [insumoId, cantidad] of requerimientos.entries()) {
    movimientos.push(
      store.applyMovement({
        insumo_id: insumoId,
        tipo: 'salida',
        cantidad: store.round3(cantidad),
        referencia_tipo: 'pedido',
        referencia_id: pedido.id,
        usuario_id: usuarioId,
        observacion: `Consumo del pedido ${pedido.numero}`,
      }),
    );
  }
  pedido.stock_descontado = true;
  return movimientos;
}

function revertirStockPedido(pedido, usuarioId, motivo) {
  if (pedido.stock_descontado === false) {
    return [];
  }
  const requerimientos = requerimientosDePedido(pedido);
  const movimientos = [];
  for (const [insumoId, cantidad] of requerimientos.entries()) {
    movimientos.push(
      store.applyMovement({
        insumo_id: insumoId,
        tipo: 'devolucion',
        cantidad: store.round3(cantidad),
        referencia_tipo: 'pedido',
        referencia_id: pedido.id,
        usuario_id: usuarioId,
        observacion: motivo || `Reversa del pedido ${pedido.numero}`,
      }),
    );
  }
  pedido.stock_descontado = false;
  return movimientos;
}

function enviarPedidoACocina(pedido, usuarioId) {
  if (pedido.estado !== 'borrador') {
    throw new AppError(409, 'CONFLICT', 'Solo un pedido en borrador puede enviarse a cocina.');
  }
  const movimientos = descontarStockPedido(pedido, usuarioId);
  const ahora = store.nowIso();
  pedido.estado = 'en_cocina';
  pedido.fecha_inicio_prep = ahora;
  const detalles = store.state.pedido_detalles.filter((detail) => detail.pedido_id === pedido.id);
  for (const detail of detalles) {
    detail.fecha_inicio_prep = ahora;
  }
  return { pedido, movimientos };
}

module.exports = {
  CANALES,
  TIPOS_CONSUMO,
  buildDetalles,
  createPedidoRecord,
  detallesDePedido,
  pedidoConDetalles,
  fichaDePlatillo,
  requerimientosDePedido,
  validarStockPedido,
  descontarStockPedido,
  revertirStockPedido,
  enviarPedidoACocina,
};
