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

  // 1ra pasada: validar la forma de cada ítem sin ir a la BD.
  const entradas = list.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new AppError(400, 'VALIDATION_ERROR', `El ítem ${index + 1} no es válido.`, [
        { field: `items[${index}]` },
      ]);
    }
    return {
      platilloId: requiredInt(item.platillo_id, `items[${index}].platillo_id`, { min: 1 }),
      cantidad: requiredInt(item.cantidad, `items[${index}].cantidad`, { min: 1, max: 999 }),
      notas: optionalString(item.notas, `items[${index}].notas`, { max: 200 }),
    };
  });

  // 2da pasada: una sola consulta para todos los platillos (antes: 1 por ítem).
  const platilloIds = [...new Set(entradas.map((entrada) => entrada.platilloId))];
  const { data: platillos } = await repository.list('platillos', {
    filters: { id: platilloIds },
    limit: platilloIds.length,
  });
  const platillosPorId = new Map(platillos.map((platillo) => [platillo.id, platillo]));

  let subtotal = 0;
  const detalles = [];

  for (const entrada of entradas) {
    const platillo = platillosPorId.get(entrada.platilloId);
    if (!platillo) {
      throw new AppError(404, 'NOT_FOUND', `Platillo con id ${entrada.platilloId} no existe.`);
    }
    if (!platillo.activo) {
      throw new AppError(422, 'BUSINESS_RULE_VIOLATION', `El platillo "${platillo.nombre}" está inactivo.`);
    }
    const precio = Number(platillo.precio_venta);
    const lineSubtotal = db.round2(entrada.cantidad * precio);
    subtotal += lineSubtotal;
    detalles.push({
      platillo_id: platillo.id,
      platillo_nombre: platillo.nombre,
      cantidad: entrada.cantidad,
      precio_unitario: precio,
      subtotal: lineSubtotal,
      notas: entrada.notas,
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
    idempotency_key = null,
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
    idempotency_key: idempotency_key || null,
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

  const filas = detalles.map((detail) => ({
    pedido_id: pedido.id,
    platillo_id: detail.platillo_id,
    cantidad: detail.cantidad,
    precio_unitario: detail.precio_unitario,
    notas: detail.notas,
    estado_preparacion: 'pendiente',
    fecha_inicio_prep: null,
    fecha_listo: null,
  }));

  let insertadas;
  try {
    insertadas = await repository.insertMany('pedido_detalles', filas);
  } catch (error) {
    // Compensación best-effort: el pedido ya existe pero sus líneas no.
    throw db.persistenceError(
      `El pedido ${pedido.numero} se creó pero no se pudieron registrar todas sus líneas.`,
      error,
    );
  }

  // Se reutilizan las filas insertadas para la respuesta (evita releer
  // pedido_detalles + platillos solo para armar el JSON).
  const detallesFinales = filas.map((fila, index) => {
    const insertada = insertadas[index];
    if (!insertada) {
      return { ...fila, subtotal: detalles[index].subtotal, platillo_nombre: detalles[index].platillo_nombre };
    }
    return {
      ...insertada,
      precio_unitario: Number(insertada.precio_unitario),
      subtotal: Number(insertada.subtotal),
      platillo_nombre: detalles[index].platillo_nombre,
    };
  });

  return { ...pedido, detalles: detallesFinales };
}

async function detallesDePedido(pedidoId) {
  const { data: detalles } = await repository.list('pedido_detalles', {
    filters: { pedido_id: Number(pedidoId) },
    orderBy: 'id',
    ascending: true,
    limit: 1000,
  });

  if (detalles.length === 0) {
    return [];
  }

  const platilloIds = [...new Set(detalles.map((item) => item.platillo_id))];
  const { data: platillos } = await repository.list('platillos', {
    filters: { id: platilloIds },
    limit: platilloIds.length,
  });
  const nombres = new Map(platillos.map((platillo) => [platillo.id, platillo.nombre]));

  return detalles.map((detail) => ({
    ...detail,
    precio_unitario: Number(detail.precio_unitario),
    subtotal: Number(detail.subtotal),
    platillo_nombre: nombres.get(detail.platillo_id) || null,
  }));
}

async function pedidoConDetalles(pedido, opciones = {}) {
  const detallesPrevios = Array.isArray(opciones.detalles) ? opciones.detalles : null;
  const [mesa, cliente, repartidor, detalles] = await Promise.all([
    pedido.mesa_id ? repository.getById('mesas', pedido.mesa_id) : null,
    pedido.cliente_id ? repository.getById('clientes', pedido.cliente_id) : null,
    pedido.repartidor_id ? repository.getById('usuarios', pedido.repartidor_id) : null,
    detallesPrevios ? Promise.resolve(detallesPrevios) : detallesDePedido(pedido.id),
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

async function requerimientosDePedido(pedido, detallesPrevios = null) {
  const requerimientos = new Map();
  const detalles = detallesPrevios || (await detallesDePedido(pedido.id));
  if (detalles.length === 0) {
    return requerimientos;
  }

  const platilloIds = [...new Set(detalles.map((item) => item.platillo_id))];
  const { data: fichas } = await repository.list('fichas_tecnicas', {
    filters: { platillo_id: platilloIds, activa: true },
    limit: 1000,
  });
  if (fichas.length === 0) {
    return requerimientos;
  }

  const fichaPorPlatillo = new Map(fichas.map((ficha) => [ficha.platillo_id, ficha]));
  const fichaIds = fichas.map((ficha) => ficha.id);
  const { data: ingredientes } = await repository.list('fichas_tecnicas_detalle', {
    filters: { ficha_id: fichaIds },
    limit: 1000,
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

async function validarStockPedido(pedido, detallesPrevios = null) {
  const requerimientos = await requerimientosDePedido(pedido, detallesPrevios);
  const insumoIds = [...requerimientos.keys()];
  if (insumoIds.length === 0) {
    return requerimientos;
  }

  // Una sola consulta para todos los insumos (antes: 1 por insumo).
  const { data: insumos } = await repository.list('insumos', {
    filters: { id: insumoIds },
    limit: insumoIds.length,
  });
  const insumosPorId = new Map(insumos.map((insumo) => [insumo.id, insumo]));
  const faltantes = [];

  for (const [insumoId, cantidad] of requerimientos.entries()) {
    const insumo = insumosPorId.get(insumoId);
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
    limit: 1000,
  });
  return data;
}

async function descontarStockPedido(pedido, usuarioId, detallesPrevios = null) {
  const salidas = await movimientosDePedido(pedido.id, 'salida');
  if (salidas.length > 0) {
    return [];
  }

  // No se lee el stock: el RPC valida y descuenta de forma atomica.
  const requerimientos = await requerimientosDePedido(pedido, detallesPrevios);
  const movimientos = [];
  for (const [insumoId, cantidad] of requerimientos.entries()) {
    if (!(cantidad > 0)) {
      continue;
    }
    movimientos.push({
      insumo_id: insumoId,
      tipo: 'salida',
      cantidad: db.round3(cantidad),
      referencia_tipo: 'pedido',
      referencia_id: pedido.id,
      usuario_id: usuarioId,
      observacion: `Consumo del pedido ${pedido.numero}`,
    });
  }

  if (movimientos.length === 0) {
    return [];
  }
  // Una sola llamada (RPC atomico en Supabase; bucle en memoria).
  return db.applyMovements(movimientos);
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
    if (!insumosDescontados.has(insumoId) || !(cantidad > 0)) {
      continue;
    }
    movimientos.push({
      insumo_id: insumoId,
      tipo: 'devolucion',
      cantidad: db.round3(cantidad),
      referencia_tipo: 'pedido',
      referencia_id: pedido.id,
      usuario_id: usuarioId,
      observacion: motivo || `Reversa del pedido ${pedido.numero}`,
    });
  }

  if (movimientos.length === 0) {
    return [];
  }
  return db.applyMovements(movimientos);
}

async function enviarPedidoACocina(pedido, usuarioId) {
  if (pedido.estado !== 'borrador') {
    throw new AppError(409, 'CONFLICT', 'Solo un pedido en borrador puede enviarse a cocina.');
  }

  // Se leen los detalles una sola vez y se reutilizan para stock y respuesta.
  const detalles = await detallesDePedido(pedido.id);
  const movimientos = await descontarStockPedido(pedido, usuarioId, detalles);
  const ahora = db.nowIso();

  const actualizado = await repository.update('pedidos', pedido.id, {
    estado: 'en_cocina',
    fecha_inicio_prep: ahora,
  });

  // Una sola sentencia para todas las lineas (antes: 1 UPDATE por linea).
  await repository.updateWhere(
    'pedido_detalles',
    { pedido_id: pedido.id },
    { fecha_inicio_prep: ahora },
  );

  const detallesActualizados = detalles.map((detail) => ({
    ...detail,
    fecha_inicio_prep: ahora,
  }));

  return {
    pedido: actualizado || { ...pedido, estado: 'en_cocina', fecha_inicio_prep: ahora },
    movimientos,
    detalles: detallesActualizados,
  };
}

function traducirErrorRpc(error) {
  const mensaje = [error && error.message, error && error.details, error && error.hint]
    .filter(Boolean)
    .join(' ');

  const stock = mensaje.match(/STOCK_INSUFICIENTE:\s*(.+)$/i);
  if (stock) {
    const nombre = stock[1].trim();
    return new AppError(409, 'STOCK_INSUFICIENTE', `No hay stock suficiente de ${nombre}.`, [
      { insumo: nombre },
    ]);
  }

  const insumo = mensaje.match(/INSUMO_NO_ENCONTRADO:\s*(.+)$/i);
  if (insumo) {
    return new AppError(404, 'NOT_FOUND', `Insumo con id ${insumo[1].trim()} no existe.`);
  }

  if (/CUENTA_NO_ENCONTRADA/i.test(mensaje)) {
    return new AppError(404, 'NOT_FOUND', 'La cuenta no existe.');
  }
  if (/CUENTA_NO_ABIERTA/i.test(mensaje)) {
    return new AppError(409, 'CONFLICT', 'La cuenta ya no está abierta.');
  }
  if (/CAJA_CERRADA/i.test(mensaje)) {
    return new AppError(
      409,
      'CAJA_CERRADA',
      'La caja del día está cerrada. Abra el cuadre de caja para operar.',
    );
  }
  if (/PLATILLO_NO_ENCONTRADO/i.test(mensaje)) {
    return new AppError(404, 'NOT_FOUND', 'Uno de los platillos no existe.');
  }

  const platilloInactivo = mensaje.match(/PLATILLO_INACTIVO:\s*(.+)$/i);
  if (platilloInactivo) {
    return new AppError(
      422,
      'BUSINESS_RULE_VIOLATION',
      `El platillo "${platilloInactivo[1].trim()}" está inactivo.`,
    );
  }

  if (/ITEMS_REQUERIDOS/i.test(mensaje)) {
    return new AppError(400, 'VALIDATION_ERROR', 'Debe enviar al menos un ítem.');
  }

  const item = mensaje.match(/ITEM_INVALIDO:\s*(.+)$/i);
  if (item) {
    return new AppError(400, 'VALIDATION_ERROR', item[1].trim());
  }

  return null;
}

function rondaDesdeRpc(data) {
  const payload = data && typeof data === 'object' ? data : {};
  const pedido = payload.pedido && typeof payload.pedido === 'object' ? payload.pedido : {};
  const detalles = Array.isArray(payload.detalles)
    ? payload.detalles.map((detail) => ({
        ...detail,
        precio_unitario: Number(detail.precio_unitario),
        subtotal: Number(detail.subtotal),
      }))
    : [];

  const resultado = {
    ...pedido,
    origen: 'rpc',
    subtotal: Number(pedido.subtotal),
    igv: Number(pedido.igv),
    total: Number(pedido.total),
    comision_plataforma: Number(pedido.comision_plataforma),
    costo_delivery: Number(pedido.costo_delivery),
    mesa_numero: payload.mesa_numero ?? null,
    cliente_nombre: null,
    repartidor_nombre: null,
    detalles,
    movimientos_inventario: Number(payload.movimientos) || 0,
  };

  if (payload.idempotente === true) {
    resultado.idempotente = true;
  }

  return resultado;
}

async function crearRondaYEnviarRpc(options) {
  const {
    cuentaId,
    usuarioId,
    items,
    observaciones = null,
    idempotencyKey = null,
    enviar = false,
  } = options;

  const data = await repository.rpc('fn_crear_ronda_y_enviar', {
    p_cuenta_id: Number(cuentaId),
    p_usuario_id: Number(usuarioId),
    p_items: Array.isArray(items) ? items : [],
    p_observaciones: observaciones ?? null,
    p_idempotency_key: idempotencyKey ?? null,
    p_enviar: Boolean(enviar),
  });

  return rondaDesdeRpc(data);
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
  crearRondaYEnviarRpc,
  traducirErrorRpc,
};
