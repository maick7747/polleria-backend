'use strict';

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredString,
  optionalString,
  requiredInt,
  requiredEnum,
  optionalNumber,
  optionalDate,
  paginate,
  parseId,
} = require('../../middleware/validate');
const pedidos = require('../../lib/pedidos');
const pedidosDb = require('../../lib/pedidos-db');
const documentoProviders = require('./providers/documento');

function fechaLima(iso) {
  if (!iso) {
    return null;
  }
  return new Date(Date.parse(iso) - 5 * 3600000).toISOString().slice(0, 10);
}

async function cuentaAbiertaDeMesa(mesaId) {
  if (!db.isSupabase()) {
    return store.state.cuentas.find(
      (cuenta) => cuenta.mesa_id === Number(mesaId) && cuenta.estado === 'abierta',
    ) || null;
  }
  return db.findOne('cuentas', { mesa_id: Number(mesaId), estado: 'abierta' });
}

async function rondasDeCuenta(cuentaId) {
  if (!db.isSupabase()) {
    return store.state.pedidos.filter((pedido) => pedido.cuenta_id === cuentaId);
  }
  const { data } = await repository.list('pedidos', {
    filters: { cuenta_id: Number(cuentaId) },
    orderBy: 'id',
    ascending: true,
    limit: 100,
  });
  return data;
}

async function resumenCuenta(cuenta) {
  if (!db.isSupabase()) {
    const mesa = store.find('mesas', cuenta.mesa_id);
    const rondas = store.state.pedidos.filter((pedido) => pedido.cuenta_id === cuenta.id);
    return {
      ...cuenta,
      mesa_numero: mesa ? mesa.numero : null,
      rondas: rondas.length,
      pedidos: rondas.map((pedido) => pedido.id),
    };
  }

  const [mesa, rondas] = await Promise.all([
    repository.getById('mesas', cuenta.mesa_id),
    rondasDeCuenta(cuenta.id),
  ]);
  return {
    ...cuenta,
    total: Number(cuenta.total),
    mesa_numero: mesa ? mesa.numero : null,
    rondas: rondas.length,
    pedidos: rondas.map((pedido) => pedido.id),
  };
}

async function cuentaAbiertaDetalle(mesaId) {
  const cuenta = await cuentaAbiertaDeMesa(mesaId);
  if (!cuenta) {
    return null;
  }
  const rondas = await rondasDeCuenta(cuenta.id);
  const detalle = await Promise.all(rondas.map((pedido) => pedidosDb.pedidoConDetalles(pedido)));
  return {
    ...cuenta,
    total: Number(cuenta.total),
    mesa_numero: null,
    rondas: rondas.length,
    pedidos: detalle,
  };
}

async function listMesas(query = {}) {
  const estado = query.estado
    ? requiredEnum(query.estado, 'estado', ['libre', 'ocupada'])
    : null;

  if (!db.isSupabase()) {
    const data = store.state.mesas
      .filter((mesa) => mesa.activa)
      .map((mesa) => {
        const cuenta = store.state.cuentas.find(
          (item) => item.mesa_id === mesa.id && item.estado === 'abierta',
        );
        return {
          ...mesa,
          estado: cuenta ? 'ocupada' : mesa.estado,
          cuenta_abierta: cuenta ? { id: cuenta.id, total: cuenta.total, fecha_apertura: cuenta.fecha_apertura } : null,
        };
      })
      .filter((mesa) => !estado || mesa.estado === estado);

    return paginate(data, { ...query, limit: query.limit || 50 });
  }

  const [{ data: mesas }, { data: cuentas }] = await Promise.all([
    repository.list('mesas', {
      filters: { activa: true },
      orderBy: 'numero',
      ascending: true,
      limit: 100,
    }),
    repository.list('cuentas', {
      filters: { estado: 'abierta' },
      orderBy: 'id',
      ascending: true,
      limit: 100,
    }),
  ]);

  const abiertas = new Map(cuentas.map((cuenta) => [cuenta.mesa_id, cuenta]));
  const data = mesas
    .map((mesa) => {
      const cuenta = abiertas.get(mesa.id);
      return {
        ...mesa,
        estado: cuenta ? 'ocupada' : mesa.estado,
        cuenta_abierta: cuenta
          ? {
              id: cuenta.id,
              total: Number(cuenta.total),
              fecha_apertura: cuenta.fecha_apertura,
            }
          : null,
      };
    })
    .filter((mesa) => !estado || mesa.estado === estado);

  return paginate(data, { ...query, limit: query.limit || 50 });
}

async function getMesa(id) {
  if (!db.isSupabase()) {
    const mesa = store.findOrThrow('mesas', parseId(id), 'Mesa');
    const cuenta = store.state.cuentas.find(
      (item) => item.mesa_id === mesa.id && item.estado === 'abierta',
    );
    return {
      ...mesa,
      estado: cuenta ? 'ocupada' : mesa.estado,
      cuenta_abierta: cuenta
        ? {
            ...(await resumenCuenta(cuenta)),
            pedidos: store.state.pedidos
              .filter((pedido) => pedido.cuenta_id === cuenta.id)
              .map((pedido) => pedidos.pedidoConDetalles(pedido)),
          }
        : null,
    };
  }

  const mesa = await db.findOrThrow('mesas', parseId(id), 'Mesa');
  const detalle = await cuentaAbiertaDetalle(mesa.id);
  if (detalle) {
    detalle.mesa_numero = mesa.numero;
  }
  return {
    ...mesa,
    estado: detalle ? 'ocupada' : mesa.estado,
    cuenta_abierta: detalle,
  };
}

async function listCuentas(query = {}) {
  const estado = query.estado
    ? requiredEnum(query.estado, 'estado', ['abierta', 'cobrada', 'cancelada'])
    : null;

  if (!db.isSupabase()) {
    const data = store.state.cuentas
      .filter((cuenta) => !estado || cuenta.estado === estado)
      .sort((a, b) => b.id - a.id)
      .map((cuenta) => resumenCuentaSync(cuenta));

    return paginate(data, query);
  }

  const { data } = await repository.list('cuentas', {
    filters: estado ? { estado } : {},
    orderBy: 'id',
    ascending: false,
    limit: 100,
  });
  const mapped = await Promise.all(data.map((cuenta) => resumenCuenta(cuenta)));
  return paginate(mapped, query);
}

function resumenCuentaSync(cuenta) {
  const mesa = store.find('mesas', cuenta.mesa_id);
  const rondas = store.state.pedidos.filter((pedido) => pedido.cuenta_id === cuenta.id);
  return {
    ...cuenta,
    mesa_numero: mesa ? mesa.numero : null,
    rondas: rondas.length,
    pedidos: rondas.map((pedido) => pedido.id),
  };
}

async function getCuentaBasica(id) {
  if (!db.isSupabase()) {
    return resumenCuentaSync(store.findOrThrow('cuentas', parseId(id), 'Cuenta'));
  }
  const cuenta = await db.findOrThrow('cuentas', parseId(id), 'Cuenta');
  return resumenCuenta(cuenta);
}

async function createCuenta(body, usuario) {
  const payload = requiredObject(body);
  const mesaId = requiredInt(payload.mesa_id, 'mesa_id', { min: 1 });

  if (!db.isSupabase()) {
    const mesa = store.findOrThrow('mesas', mesaId, 'Mesa');
    if (!mesa.activa) {
      throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'La mesa está inactiva.');
    }
    if (store.state.cuentas.some((cuenta) => cuenta.mesa_id === mesaId && cuenta.estado === 'abierta')) {
      throw new AppError(409, 'CUENTA_ABIERTA', `La mesa ${mesa.numero} ya tiene una cuenta abierta.`);
    }
    store.requireCajaAbierta();

    const cuenta = {
      id: store.nextId('cuentas'),
      mesa_id: mesaId,
      estado: 'abierta',
      total: 0,
      fecha_apertura: store.nowIso(),
      usuario_apertura_id: usuario.id,
      fecha_cierre: null,
      usuario_cierre_id: null,
      comprobante_tipo: 'boleta',
      comprobante_numero: null,
    };
    store.state.cuentas.push(cuenta);
    mesa.estado = 'ocupada';
    return resumenCuentaSync(cuenta);
  }

  const mesa = await db.findOrThrow('mesas', mesaId, 'Mesa');
  if (!mesa.activa) {
    throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'La mesa está inactiva.');
  }
  if (await cuentaAbiertaDeMesa(mesaId)) {
    throw new AppError(409, 'CUENTA_ABIERTA', `La mesa ${mesa.numero} ya tiene una cuenta abierta.`);
  }
  await db.requireCajaAbierta();

  let cuenta;
  try {
    cuenta = await repository.insert('cuentas', {
      mesa_id: mesaId,
      estado: 'abierta',
      total: 0,
      fecha_apertura: db.nowIso(),
      usuario_apertura_id: usuario.id,
      comprobante_tipo: 'boleta',
    });
  } catch (error) {
    if (String(error.code) === '23505') {
      throw new AppError(409, 'CUENTA_ABIERTA', `La mesa ${mesa.numero} ya tiene una cuenta abierta.`);
    }
    throw db.persistenceError('No se pudo abrir la cuenta.', error);
  }

  try {
    await repository.update('mesas', mesaId, { estado: 'ocupada' });
  } catch (error) {
    try {
      await repository.remove('cuentas', cuenta.id);
    } catch (rollbackError) {
      // compensación best-effort
    }
    throw db.persistenceError(
      `Se abrió la cuenta ${cuenta.id} pero no se pudo marcar la mesa ${mesa.numero} como ocupada.`,
      error,
    );
  }

  return resumenCuenta(cuenta);
}

async function addRonda(cuentaId, body, usuario) {
  const id = parseId(cuentaId);
  const payload = requiredObject(body);

  if (!db.isSupabase()) {
    const cuenta = store.findOrThrow('cuentas', id, 'Cuenta');
    if (cuenta.estado !== 'abierta') {
      throw new AppError(409, 'CONFLICT', 'La cuenta ya no está abierta.');
    }
    store.requireCajaAbierta();

    const pedido = pedidos.createPedidoRecord({
      canal: 'local',
      tipo_consumo: 'sala',
      mesa_id: cuenta.mesa_id,
      cuenta_id: cuenta.id,
      usuario_id: usuario.id,
      items: payload.items,
      observaciones: payload.observaciones,
    });

    cuenta.total = store.round2(cuenta.total + pedido.total);
    return pedidos.pedidoConDetalles(pedido);
  }

  const cuenta = await db.findOrThrow('cuentas', id, 'Cuenta');
  if (cuenta.estado !== 'abierta') {
    throw new AppError(409, 'CONFLICT', 'La cuenta ya no está abierta.');
  }
  await db.requireCajaAbierta();

  const pedido = await pedidosDb.createPedidoRecord({
    canal: 'local',
    tipo_consumo: 'sala',
    mesa_id: cuenta.mesa_id,
    cuenta_id: cuenta.id,
    usuario_id: usuario.id,
    items: payload.items,
    observaciones: payload.observaciones,
  });

  try {
    await repository.update('cuentas', cuenta.id, {
      total: db.round2(Number(cuenta.total) + Number(pedido.total)),
    });
  } catch (error) {
    throw db.persistenceError(
      `La ronda ${pedido.numero} se registró pero no se pudo actualizar el total de la cuenta.`,
      error,
    );
  }

  return pedidosDb.pedidoConDetalles(pedido);
}

async function listPedidos(query = {}) {
  const estado = query.estado
    ? requiredEnum(query.estado, 'estado', ['borrador', 'en_cocina', 'servido', 'cobrado', 'cancelado'])
    : null;
  const canal = query.canal
    ? requiredEnum(query.canal, 'canal', pedidos.CANALES)
    : null;
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');

  if (!db.isSupabase()) {
    const data = store.state.pedidos
      .filter((pedido) => (!estado || pedido.estado === estado))
      .filter((pedido) => (!canal || pedido.canal === canal))
      .filter((pedido) => (!desde || pedido.fecha_pedido.slice(0, 10) >= desde))
      .filter((pedido) => (!hasta || pedido.fecha_pedido.slice(0, 10) <= hasta))
      .sort((a, b) => b.id - a.id)
      .map((pedido) => pedidos.pedidoConDetalles(pedido));

    return paginate(data, query);
  }

  const filters = {};
  if (estado) {
    filters.estado = estado;
  }
  if (canal) {
    filters.canal = canal;
  }

  const { data } = await repository.list('pedidos', {
    filters,
    orderBy: 'id',
    ascending: false,
    limit: 100,
  });

  const filtrados = data
    .filter((pedido) => !desde || fechaLima(pedido.fecha_pedido) >= desde)
    .filter((pedido) => !hasta || fechaLima(pedido.fecha_pedido) <= hasta);

  const mapped = await Promise.all(filtrados.map((pedido) => pedidosDb.pedidoConDetalles(pedido)));
  return paginate(mapped, query);
}

async function getPedido(id) {
  if (!db.isSupabase()) {
    return pedidos.pedidoConDetalles(store.findOrThrow('pedidos', parseId(id), 'Pedido'));
  }
  const pedido = await db.findOrThrow('pedidos', parseId(id), 'Pedido');
  return pedidosDb.pedidoConDetalles(pedido);
}

async function createPedido(body, usuario) {
  const payload = requiredObject(body);

  if (!db.isSupabase()) {
    store.requireCajaAbierta();

    if (payload.cuenta_id) {
      const cuenta = store.findOrThrow('cuentas', requiredInt(payload.cuenta_id, 'cuenta_id'), 'Cuenta');
      if (cuenta.estado !== 'abierta') {
        throw new AppError(409, 'CONFLICT', 'La cuenta no está abierta.');
      }
    }

    if (payload.mesa_id) {
      store.findOrThrow('mesas', requiredInt(payload.mesa_id, 'mesa_id'), 'Mesa');
    }

    const pedido = pedidos.createPedidoRecord({
      canal: payload.canal || 'local',
      tipo_consumo: payload.tipo_consumo || 'para_llevar',
      items: payload.items,
      mesa_id: payload.mesa_id,
      cuenta_id: payload.cuenta_id,
      cliente_id: payload.cliente_id,
      repartidor_id: payload.repartidor_id,
      usuario_id: usuario.id,
      observaciones: payload.observaciones,
      direccion_entrega: payload.direccion_entrega,
      referencia_entrega: payload.referencia_entrega,
      costo_delivery: optionalNumber(payload.costo_delivery, 'costo_delivery', { min: 0 }) || 0,
    });

    if (pedido.cuenta_id) {
      const cuenta = store.findOrThrow('cuentas', pedido.cuenta_id, 'Cuenta');
      cuenta.total = store.round2(cuenta.total + pedido.total);
    }

    return pedidos.pedidoConDetalles(pedido);
  }

  await db.requireCajaAbierta();

  if (payload.cuenta_id) {
    const cuenta = await db.findOrThrow(
      'cuentas',
      requiredInt(payload.cuenta_id, 'cuenta_id'),
      'Cuenta',
    );
    if (cuenta.estado !== 'abierta') {
      throw new AppError(409, 'CONFLICT', 'La cuenta no está abierta.');
    }
  }

  if (payload.mesa_id) {
    await db.findOrThrow('mesas', requiredInt(payload.mesa_id, 'mesa_id'), 'Mesa');
  }

  const pedido = await pedidosDb.createPedidoRecord({
    canal: payload.canal || 'local',
    tipo_consumo: payload.tipo_consumo || 'para_llevar',
    items: payload.items,
    mesa_id: payload.mesa_id,
    cuenta_id: payload.cuenta_id,
    cliente_id: payload.cliente_id,
    repartidor_id: payload.repartidor_id,
    usuario_id: usuario.id,
    observaciones: payload.observaciones,
    direccion_entrega: payload.direccion_entrega,
    referencia_entrega: payload.referencia_entrega,
    costo_delivery: optionalNumber(payload.costo_delivery, 'costo_delivery', { min: 0 }) || 0,
  });

  if (pedido.cuenta_id) {
    const cuenta = await db.findOrThrow('cuentas', pedido.cuenta_id, 'Cuenta');
    try {
      await repository.update('cuentas', cuenta.id, {
        total: db.round2(Number(cuenta.total) + Number(pedido.total)),
      });
    } catch (error) {
      throw db.persistenceError(
        `El pedido ${pedido.numero} se registró pero no se pudo actualizar el total de la cuenta.`,
        error,
      );
    }
  }

  return pedidosDb.pedidoConDetalles(pedido);
}

async function updatePedido(id, body) {
  const payload = requiredObject(body);

  if (!db.isSupabase()) {
    const pedido = store.findOrThrow('pedidos', parseId(id), 'Pedido');
    if (pedido.estado !== 'borrador') {
      throw new AppError(409, 'PEDIDO_NO_EDITABLE', 'Solo se puede editar un pedido en borrador.');
    }

    const totalAnterior = pedido.total;

    if (payload.observaciones !== undefined) {
      pedido.observaciones = optionalString(payload.observaciones, 'observaciones', { max: 300 });
    }
    if (payload.direccion_entrega !== undefined) {
      pedido.direccion_entrega = optionalString(payload.direccion_entrega, 'direccion_entrega', { max: 200 });
    }
    if (payload.referencia_entrega !== undefined) {
      pedido.referencia_entrega = optionalString(payload.referencia_entrega, 'referencia_entrega', { max: 150 });
    }
    if (payload.costo_delivery !== undefined) {
      pedido.costo_delivery = optionalNumber(payload.costo_delivery, 'costo_delivery', { min: 0 }) || 0;
    }

    if (payload.items !== undefined) {
      const { detalles, subtotal } = pedidos.buildDetalles(payload.items);
      store.state.pedido_detalles = store.state.pedido_detalles.filter(
        (detail) => detail.pedido_id !== pedido.id,
      );
      for (const detail of detalles) {
        store.state.pedido_detalles.push({
          id: store.nextId('pedido_detalles'),
          pedido_id: pedido.id,
          ...detail,
          estado_preparacion: 'pendiente',
          fecha_inicio_prep: null,
          fecha_listo: null,
        });
      }
      const totals = store.calcTotals(subtotal, pedido.costo_delivery);
      pedido.subtotal = totals.subtotal;
      pedido.igv = totals.igv;
      pedido.total = totals.total;
    } else if (payload.costo_delivery !== undefined) {
      const totals = store.calcTotals(pedido.subtotal, pedido.costo_delivery);
      pedido.igv = totals.igv;
      pedido.total = totals.total;
    }

    if (pedido.cuenta_id) {
      const cuenta = store.find('cuentas', pedido.cuenta_id);
      if (cuenta && cuenta.estado === 'abierta') {
        cuenta.total = store.round2(Math.max(0, cuenta.total - totalAnterior + pedido.total));
      }
    }

    return pedidos.pedidoConDetalles(pedido);
  }

  const pedido = await db.findOrThrow('pedidos', parseId(id), 'Pedido');
  if (pedido.estado !== 'borrador') {
    throw new AppError(409, 'PEDIDO_NO_EDITABLE', 'Solo se puede editar un pedido en borrador.');
  }

  const totalAnterior = Number(pedido.total);
  const patch = {};

  if (payload.observaciones !== undefined) {
    patch.observaciones = optionalString(payload.observaciones, 'observaciones', { max: 300 });
  }
  if (payload.direccion_entrega !== undefined) {
    patch.direccion_entrega = optionalString(payload.direccion_entrega, 'direccion_entrega', { max: 200 });
  }
  if (payload.referencia_entrega !== undefined) {
    patch.referencia_entrega = optionalString(payload.referencia_entrega, 'referencia_entrega', { max: 150 });
  }
  if (payload.costo_delivery !== undefined) {
    patch.costo_delivery = optionalNumber(payload.costo_delivery, 'costo_delivery', { min: 0 }) || 0;
  }

  if (payload.items !== undefined) {
    const { detalles, subtotal } = await pedidosDb.buildDetalles(payload.items);
    const { data: existentes } = await repository.list('pedido_detalles', {
      filters: { pedido_id: pedido.id },
      limit: 100,
    });
    for (const detail of existentes) {
      await repository.remove('pedido_detalles', detail.id);
    }
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
    const costo = patch.costo_delivery !== undefined
      ? Number(patch.costo_delivery)
      : Number(pedido.costo_delivery);
    const totals = await db.calcTotals(subtotal, costo);
    patch.subtotal = totals.subtotal;
    patch.igv = totals.igv;
    patch.total = totals.total;
  } else if (payload.costo_delivery !== undefined) {
    const totals = await db.calcTotals(Number(pedido.subtotal), Number(patch.costo_delivery));
    patch.igv = totals.igv;
    patch.total = totals.total;
  }

  let actualizado = pedido;
  if (Object.keys(patch).length > 0) {
    actualizado = (await repository.update('pedidos', pedido.id, patch)) || pedido;
  }

  if (pedido.cuenta_id) {
    const cuenta = await repository.getById('cuentas', pedido.cuenta_id);
    if (cuenta && cuenta.estado === 'abierta') {
      await repository.update('cuentas', cuenta.id, {
        total: db.round2(
          Math.max(0, Number(cuenta.total) - totalAnterior + Number(actualizado.total)),
        ),
      });
    }
  }

  return pedidosDb.pedidoConDetalles(actualizado);
}

async function enviarCocina(id, usuario) {
  if (!db.isSupabase()) {
    const pedido = store.findOrThrow('pedidos', parseId(id), 'Pedido');
    const result = pedidos.enviarPedidoACocina(pedido, usuario.id);
    return {
      ...pedidos.pedidoConDetalles(result.pedido),
      movimientos_inventario: result.movimientos.length,
    };
  }

  const pedido = await db.findOrThrow('pedidos', parseId(id), 'Pedido');
  const result = await pedidosDb.enviarPedidoACocina(pedido, usuario.id);
  const detalle = await pedidosDb.pedidoConDetalles(result.pedido);
  return {
    ...detalle,
    movimientos_inventario: result.movimientos.length,
  };
}

async function cancelarPedido(id, body, usuario) {
  const payload = requiredObject(body || {});
  const motivo = optionalString(payload.motivo, 'motivo', { max: 300 });

  if (!db.isSupabase()) {
    const pedido = store.findOrThrow('pedidos', parseId(id), 'Pedido');
    if (pedido.estado === 'cobrado') {
      throw new AppError(409, 'CONFLICT', 'Un pedido cobrado no puede cancelarse.');
    }
    if (pedido.estado === 'cancelado') {
      throw new AppError(409, 'CONFLICT', 'El pedido ya está cancelado.');
    }

    const movimientos = pedidos.revertirStockPedido(pedido, usuario.id, motivo || 'Cancelación de pedido');
    pedido.estado = 'cancelado';
    pedido.fecha_cancelacion = store.nowIso();
    pedido.motivo_cancelacion = motivo;

    if (pedido.cuenta_id) {
      const cuenta = store.find('cuentas', pedido.cuenta_id);
      if (cuenta && cuenta.estado === 'abierta') {
        cuenta.total = store.round2(Math.max(0, cuenta.total - pedido.total));
      }
    }

    return {
      ...pedidos.pedidoConDetalles(pedido),
      movimientos_inventario: movimientos.length,
    };
  }

  const pedido = await db.findOrThrow('pedidos', parseId(id), 'Pedido');
  if (pedido.estado === 'cobrado') {
    throw new AppError(409, 'CONFLICT', 'Un pedido cobrado no puede cancelarse.');
  }
  if (pedido.estado === 'cancelado') {
    throw new AppError(409, 'CONFLICT', 'El pedido ya está cancelado.');
  }

  const movimientos = await pedidosDb.revertirStockPedido(
    pedido,
    usuario.id,
    motivo || 'Cancelación de pedido',
  );

  // El esquema no tiene columnas fecha_cancelacion/motivo_cancelacion:
  // el motivo se conserva en el log de la petición y el estado queda en 'cancelado'.
  const actualizado = await repository.update('pedidos', pedido.id, { estado: 'cancelado' });

  if (pedido.cuenta_id) {
    const cuenta = await repository.getById('cuentas', pedido.cuenta_id);
    if (cuenta && cuenta.estado === 'abierta') {
      await repository.update('cuentas', cuenta.id, {
        total: db.round2(Math.max(0, Number(cuenta.total) - Number(pedido.total))),
      });
    }
  }

  return {
    ...(await pedidosDb.pedidoConDetalles(actualizado)),
    movimientos_inventario: movimientos.length,
  };
}

async function listClientes(query = {}) {
  const documento = query.documento ? String(query.documento).trim() : '';
  const q = query.q ? String(query.q).trim().toLowerCase() : '';

  if (!db.isSupabase()) {
    const data = store.state.clientes
      .filter((cliente) => !documento || (cliente.numero_documento || '').includes(documento))
      .filter(
        (cliente) =>
          !q ||
          cliente.nombre.toLowerCase().includes(q) ||
          (cliente.numero_documento || '').includes(q),
      )
      .sort((a, b) => a.nombre.localeCompare(b.nombre));

    return paginate(data, query);
  }

  const { data } = await repository.list('clientes', {
    orderBy: 'nombre',
    ascending: true,
    limit: 100,
  });
  const filtrados = data
    .filter((cliente) => !documento || String(cliente.numero_documento || '').includes(documento))
    .filter(
      (cliente) =>
        !q ||
        String(cliente.nombre || '').toLowerCase().includes(q) ||
        String(cliente.numero_documento || '').includes(q),
    );

  return paginate(filtrados, query);
}

async function createCliente(body) {
  const payload = requiredObject(body);
  const nombre = requiredString(payload.nombre, 'nombre', { max: 120 });
  const tipoDocumento = payload.tipo_documento
    ? requiredEnum(payload.tipo_documento, 'tipo_documento', ['DNI', 'RUC'])
    : null;
  const numeroDocumento = payload.numero_documento
    ? requiredString(payload.numero_documento, 'numero_documento', { max: 11 })
    : null;

  if (tipoDocumento && !numeroDocumento) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El número de documento es obligatorio.', [
      { field: 'numero_documento' },
    ]);
  }

  const cliente = {
    nombre,
    tipo_documento: tipoDocumento,
    numero_documento: numeroDocumento,
    telefono: optionalString(payload.telefono, 'telefono', { max: 20 }),
    direccion: optionalString(payload.direccion, 'direccion', { max: 200 }),
    referencia: optionalString(payload.referencia, 'referencia', { max: 150 }),
  };

  if (!db.isSupabase()) {
    if (
      tipoDocumento &&
      store.state.clientes.some(
        (item) =>
          item.tipo_documento === tipoDocumento &&
          item.numero_documento === numeroDocumento,
      )
    ) {
      throw new AppError(409, 'CONFLICT', 'Ya existe un cliente con ese documento.');
    }
    const record = {
      id: store.nextId('clientes'),
      ...cliente,
      creado_en: store.nowIso(),
      actualizado_en: store.nowIso(),
    };
    store.state.clientes.push(record);
    return record;
  }

  if (tipoDocumento) {
    const existente = await db.findOne('clientes', {
      tipo_documento: tipoDocumento,
      numero_documento: numeroDocumento,
    });
    if (existente) {
      throw new AppError(409, 'CONFLICT', 'Ya existe un cliente con ese documento.');
    }
  }

  try {
    return await repository.insert('clientes', cliente);
  } catch (error) {
    if (String(error.code) === '23505') {
      throw new AppError(409, 'CONFLICT', 'Ya existe un cliente con ese documento.');
    }
    throw db.persistenceError('No se pudo registrar el cliente.', error);
  }
}

async function validarDocumento(body) {
  const payload = requiredObject(body);
  const tipo = requiredEnum(payload.tipo_documento, 'tipo_documento', ['DNI', 'RUC']);
  const numero = requiredString(payload.numero_documento, 'numero_documento', { max: 11 });

  // Patrón Strategy: el proveedor se resuelve por DOCUMENTO_PROVIDER y, si
  // falla, se intenta DOCUMENTO_FALLBACK. Nunca bloquea la venta.
  return documentoProviders.validarDocumento({ tipo, numero });
}

module.exports = {
  listMesas,
  getMesa,
  listCuentas,
  getCuentaBasica,
  createCuenta,
  addRonda,
  listPedidos,
  getPedido,
  createPedido,
  updatePedido,
  enviarCocina,
  cancelarPedido,
  listClientes,
  createCliente,
  validarDocumento,
};
