'use strict';

// Reglas de pedidos para DB_MODE=supabase.
// Replica la lógica de src/lib/pedidos.js (modo memoria) usando repository.
// Operaciones compuestas (pedido + líneas, stock + bitácora) no son
// transaccionales: cada fallo se informa con PERSISTENCIA_ERROR.

const repository = require('../data/repository');
const db = require('../data/db');
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

async function buildDetalles(items) {
  const list = requiredArray(items, 'items', { max: 100 });
  let subtotal = 0;
  const detalles = [];

  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (!item || typeof item !== 'object') {
      throw new AppError(400, 'VALIDATION_ERROR', `El ítem ${index + 1} no es válido.`, [
        { field: `items[${index}]` },
      ]);
    }
    const platilloId = requiredInt(item.platillo_id, `items[${index}].platillo_id`, { min: 1 });
    const cantidad = requiredInt(item.cantidad, `items[${index}].cantidad`, { min: 1, max: 999 });
    const platillo = await db.findOrThrow('platillos', platilloId, 'Platillo');
    if (!platillo.activo) {
      throw new AppError(422, 'BUSINESS_RULE_VIOLATION', `El platillo "${platillo.nombre}" está inactivo.`);
    }
    const notas = optionalString(item.notas, `items[${index}].notas`, { max: 200 });
    const precio = Number(platillo.precio_venta);
    const lineSubtotal = db.round2(cantidad * precio);
    subtotal += lineSubtotal;
    detalles.push({
      platillo_id: platillo.id,
      cantidad,
      precio_unitario: precio,
      subtotal: lineSubtotal,
      notas,
    });
  }

  return { detalles, subtotal: db.round2(subtotal) };
}

async function createPedidoRecord(options) {
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
    fecha_pedido = db.nowIso(),
  } = options;

  requiredEnum(canal, 'canal', CANALES);
  requiredEnum(tipo_consumo, 'tipo_consumo', TIPOS_CONSUMO);

  if (tipo_consumo === 'sala' && !mesa_id) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El pedido de sala requiere mesa_id.');
  }
  if (tipo_consumo === 'delivery' && !direccion_entrega) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El pedido de delivery requiere direccion_entrega.');
  }

  const { detalles, subtotal } = await buildDetalles(items);
  const totals = await db.calcTotals(subtotal, Number(costo_delivery) || 0);
  const numero = await db.nextPedidoNumero();

  const pedidoRow = {
    numero,
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
    comision_plataforma: db.round2(comision_plataforma),
    costo_delivery: db.round2(costo_delivery),
    direccion_entrega,
    referencia_entrega,
    observaciones: observaciones
      ? requiredString(observaciones, 'observaciones', { max: 300 })
      : null,
    comprobante_tipo: tipo_consumo === 'sala' ? 'boleta' : 'ticket',
    comprobante_numero: null,
    fecha_inicio_prep: null,
    fecha_listo: null,
    fecha_entrega: null,
    creado_en: db.nowIso(),
  };

  let pedido;
  try {
    pedido = await repository.insert('pedidos', pedidoRow);
  } catch (error) {
    throw db.persistenceError('No se pudo registrar el pedido.', error);
  }

  try {
    for (const detail of detalles) {
      await repository.insert('pedido_detalles', {
        pedido_id: pedido.id,
        platillo_id: detail.platillo_id,
        cantidad: detail.cantidad,
        precio_unitario: detail.precio_unitario,
        notas: detail.notas,
        estado_preparacion: 'pendiente',
        fecha_inicio_prep: null,
        fecha_listo: null,
      });
    }
  } catch (error) {
    // Compensación best-effort: el pedido ya existe pero sus líneas no.
    throw db.persistenceError(
      `El pedido ${pedido.numero} se creó pero no se pudieron registrar todas sus líneas.`,
      error,
    );
  }

  return { ...pedido, detalles };
}

async function detallesDePedido(pedidoId) {
  const { data: detalles } = await repository.list('pedido_detalles', {
    filters: { pedido_id: Number(pedidoId) },
    orderBy: 'id',
    ascending: true,
    limit: 100,
  });

  if (detalles.length === 0) {
    return [];
  }

  const platilloIds = [...new Set(detalles.map((item) => item.platillo_id))];
  const { data: platillos } = await repository.list('platillos', {
    filters: { id: platilloIds },
    limit: 100,
  });
  const nombres = new Map(platillos.map((platillo) => [platillo.id, platillo.nombre]));

  return detalles.map((detail) => ({
    ...detail,
    precio_unitario: Number(detail.precio_unitario),
    subtotal: Number(detail.subtotal),
    platillo_nombre: nombres.get(detail.platillo_id) || null,
  }));
}

async function pedidoConDetalles(pedido) {
  const [mesa, cliente, repartidor, detalles] = await Promise.all([
    pedido.mesa_id ? repository.getById('mesas', pedido.mesa_id) : null,
    pedido.cliente_id ? repository.getById('clientes', pedido.cliente_id) : null,
    pedido.repartidor_id ? repository.getById('usuarios', pedido.repartidor_id) : null,
    detallesDePedido(pedido.id),
  ]);

  return {
    ...pedido,
    subtotal: Number(pedido.subtotal),
    igv: Number(pedido.igv),
    total: Number(pedido.total),
    comision_plataforma: Number(pedido.comision_plataforma),
    costo_delivery: Number(pedido.costo_delivery),
    mesa_numero: mesa ? mesa.numero : null,
    cliente_nombre: cliente ? cliente.nombre : null,
    repartidor_nombre: repartidor ? repartidor.nombre : null,
    detalles,
  };
}

async function fichaDePlatillo(platilloId) {
  const { data } = await repository.list('fichas_tecnicas', {
    filters: { platillo_id: Number(platilloId), activa: true },
    limit: 1,
  });
  return data[0] || null;
}

async function requerimientosDePedido(pedido) {
  const requerimientos = new Map();
  const detalles = await detallesDePedido(pedido.id);
  if (detalles.length === 0) {
    return requerimientos;
  }

  const platilloIds = [...new Set(detalles.map((item) => item.platillo_id))];
  const { data: fichas } = await repository.list('fichas_tecnicas', {
    filters: { platillo_id: platilloIds, activa: true },
    limit: 100,
  });
  if (fichas.length === 0) {
    return requerimientos;
  }

  const fichaPorPlatillo = new Map(fichas.map((ficha) => [ficha.platillo_id, ficha]));
  const fichaIds = fichas.map((ficha) => ficha.id);
  const { data: ingredientes } = await repository.list('fichas_tecnicas_detalle', {
    filters: { ficha_id: fichaIds },
    limit: 100,
  });

  for (const detail of detalles) {
    const ficha = fichaPorPlatillo.get(detail.platillo_id);
    if (!ficha) {
      continue;
    }
    const porciones = Number(ficha.porciones_rendimiento) || 1;
    for (const ingredient of ingredientes) {
      if (ingredient.ficha_id !== ficha.id) {
        continue;
      }
      const cantidad = (Number(ingredient.cantidad) / porciones) * detail.cantidad;
      requerimientos.set(
        ingredient.insumo_id,
        (requerimientos.get(ingredient.insumo_id) || 0) + cantidad,
      );
    }
  }

  return requerimientos;
}

async function validarStockPedido(pedido) {
  const requerimientos = await requerimientosDePedido(pedido);
  const faltantes = [];

  for (const [insumoId, cantidad] of requerimientos.entries()) {
    const insumo = await repository.getById('insumos', insumoId);
    if (!insumo) {
      continue;
    }
    if (Number(insumo.stock_actual) + 0.0005 < cantidad) {
      faltantes.push({
        insumo_id: insumo.id,
        insumo: insumo.nombre,
        disponible: Number(insumo.stock_actual),
        requerido: db.round3(cantidad),
      });
    }
  }

  if (faltantes.length > 0) {
    throw new AppError(409, 'STOCK_INSUFICIENTE', 'No hay stock suficiente para preparar el pedido.', faltantes);
  }

  return requerimientos;
}

async function movimientosDePedido(pedidoId, tipo) {
  const { data } = await repository.list('movimientos_inventario', {
    filters: {
      referencia_tipo: 'pedido',
      referencia_id: Number(pedidoId),
      ...(tipo ? { tipo } : {}),
    },
    orderBy: 'id',
    ascending: true,
    limit: 100,
  });
  return data;
}

async function descontarStockPedido(pedido, usuarioId) {
  const salidas = await movimientosDePedido(pedido.id, 'salida');
  if (salidas.length > 0) {
    return [];
  }

  const requerimientos = await validarStockPedido(pedido);
  const movimientos = [];
  for (const [insumoId, cantidad] of requerimientos.entries()) {
    movimientos.push(
      await db.applyMovement({
        insumo_id: insumoId,
        tipo: 'salida',
        cantidad: db.round3(cantidad),
        referencia_tipo: 'pedido',
        referencia_id: pedido.id,
        usuario_id: usuarioId,
        observacion: `Consumo del pedido ${pedido.numero}`,
      }),
    );
  }
  return movimientos;
}

async function revertirStockPedido(pedido, usuarioId, motivo) {
  const salidas = await movimientosDePedido(pedido.id, 'salida');
  if (salidas.length === 0) {
    return [];
  }
  const insumosDescontados = new Set(salidas.map((movimiento) => movimiento.insumo_id));
  const requerimientos = await requerimientosDePedido(pedido);
  const movimientos = [];
  for (const [insumoId, cantidad] of requerimientos.entries()) {
    if (!insumosDescontados.has(insumoId)) {
      continue;
    }
    movimientos.push(
      await db.applyMovement({
        insumo_id: insumoId,
        tipo: 'devolucion',
        cantidad: db.round3(cantidad),
        referencia_tipo: 'pedido',
        referencia_id: pedido.id,
        usuario_id: usuarioId,
        observacion: motivo || `Reversa del pedido ${pedido.numero}`,
      }),
    );
  }
  return movimientos;
}

async function enviarPedidoACocina(pedido, usuarioId) {
  if (pedido.estado !== 'borrador') {
    throw new AppError(409, 'CONFLICT', 'Solo un pedido en borrador puede enviarse a cocina.');
  }
  const movimientos = await descontarStockPedido(pedido, usuarioId);
  const ahora = db.nowIso();

  const actualizado = await repository.update('pedidos', pedido.id, {
    estado: 'en_cocina',
    fecha_inicio_prep: ahora,
  });

  const detalles = await detallesDePedido(pedido.id);
  for (const detail of detalles) {
    await repository.update('pedido_detalles', detail.id, {
      fecha_inicio_prep: ahora,
    });
  }

  return { pedido: actualizado || { ...pedido, estado: 'en_cocina', fecha_inicio_prep: ahora }, movimientos };
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
  movimientosDePedido,
};
