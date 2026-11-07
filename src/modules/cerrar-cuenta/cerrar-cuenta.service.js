'use strict';

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredEnum,
  optionalNumber,
  optionalString,
  parseId,
} = require('../../middleware/validate');
const pedidosLib = require('../../lib/pedidos');
const pedidosDb = require('../../lib/pedidos-db');
const sunat = require('../../lib/sunat');

const METODOS = ['efectivo', 'tarjeta', 'yape', 'plin', 'transferencia'];

async function rondasDeCuenta(cuentaId) {
  if (!db.isSupabase()) {
    return store.state.pedidos
      .filter((pedido) => pedido.cuenta_id === cuentaId && pedido.estado !== 'cancelado')
      .sort((a, b) => a.id - b.id);
  }
  const { data } = await repository.list('pedidos', {
    filters: {
      cuenta_id: Number(cuentaId),
      estado: { op: 'neq', value: 'cancelado' },
    },
    orderBy: 'id',
    ascending: true,
    limit: 100,
  });
  return data;
}

async function cuentaDetalle(id) {
  if (!db.isSupabase()) {
    const cuenta = store.findOrThrow('cuentas', parseId(id), 'Cuenta');
    const mesa = store.find('mesas', cuenta.mesa_id);
    const rondas = store.state.pedidos
      .filter((pedido) => pedido.cuenta_id === cuenta.id && pedido.estado !== 'cancelado')
      .sort((a, b) => a.id - b.id);
    const subtotal = store.round2(rondas.reduce((sum, pedido) => sum + pedido.subtotal, 0));
    const igv = store.round2(rondas.reduce((sum, pedido) => sum + pedido.igv, 0));
    const total = store.round2(rondas.reduce((sum, pedido) => sum + pedido.total, 0));
    const pagos = store.state.pagos.filter((pago) => pago.cuenta_id === cuenta.id);

    return {
      ...cuenta,
      mesa_numero: mesa ? mesa.numero : null,
      subtotal,
      igv,
      total_consolidado: total,
      total: cuenta.estado === 'abierta' ? total : cuenta.total,
      rondas: rondas.length,
      pedidos: rondas.map((pedido) => pedidosLib.pedidoConDetalles(pedido)),
      pagos,
      comprobante: cuenta.comprobante_numero
        ? {
            tipo: cuenta.comprobante_tipo,
            numero: cuenta.comprobante_numero,
            fecha: cuenta.fecha_cierre,
            total: cuenta.total,
          }
        : null,
    };
  }

  const cuenta = await db.findOrThrow('cuentas', parseId(id), 'Cuenta');
  const [mesa, rondas, pagosResult] = await Promise.all([
    repository.getById('mesas', cuenta.mesa_id),
    rondasDeCuenta(cuenta.id),
    repository.list('pagos', {
      filters: { cuenta_id: cuenta.id },
      orderBy: 'id',
      ascending: true,
      limit: 100,
    }),
  ]);

  const subtotal = store.round2(
    rondas.reduce((sum, pedido) => sum + Number(pedido.subtotal), 0),
  );
  const igv = store.round2(rondas.reduce((sum, pedido) => sum + Number(pedido.igv), 0));
  const total = store.round2(rondas.reduce((sum, pedido) => sum + Number(pedido.total), 0));
  const pagos = pagosResult.data.map((pago) => ({ ...pago, monto: Number(pago.monto) }));
  const pedidos = await Promise.all(
    rondas.map((pedido) => pedidosDb.pedidoConDetalles(pedido)),
  );

  return {
    ...cuenta,
    total: Number(cuenta.total),
    mesa_numero: mesa ? mesa.numero : null,
    subtotal,
    igv,
    total_consolidado: total,
    total: cuenta.estado === 'abierta' ? total : Number(cuenta.total),
    rondas: rondas.length,
    pedidos,
    pagos,
    comprobante: cuenta.comprobante_numero
      ? {
          tipo: cuenta.comprobante_tipo,
          numero: cuenta.comprobante_numero,
          fecha: cuenta.fecha_cierre,
          total: Number(cuenta.total),
        }
      : null,
  };
}

async function listPagos(id) {
  if (!db.isSupabase()) {
    const cuenta = store.findOrThrow('cuentas', parseId(id), 'Cuenta');
    const pagos = store.state.pagos.filter((pago) => pago.cuenta_id === cuenta.id);
    return {
      cuenta_id: cuenta.id,
      estado: cuenta.estado,
      pagos,
      total_pagado: store.round2(pagos.reduce((sum, pago) => sum + pago.monto, 0)),
    };
  }

  const cuenta = await db.findOrThrow('cuentas', parseId(id), 'Cuenta');
  const { data } = await repository.list('pagos', {
    filters: { cuenta_id: cuenta.id },
    orderBy: 'id',
    ascending: true,
    limit: 100,
  });
  const pagos = data.map((pago) => ({ ...pago, monto: Number(pago.monto) }));
  return {
    cuenta_id: cuenta.id,
    estado: cuenta.estado,
    pagos,
    total_pagado: store.round2(pagos.reduce((sum, pago) => sum + pago.monto, 0)),
  };
}

async function cobrarCuenta(id, body, usuario) {
  const payload = body && typeof body === 'object' ? body : {};

  if (!db.isSupabase()) {
    const cuenta = store.findOrThrow('cuentas', parseId(id), 'Cuenta');

    if (cuenta.estado === 'cobrada') {
      throw new AppError(409, 'CUENTA_YA_COBRADA', 'La cuenta ya fue cobrada.');
    }
    if (cuenta.estado !== 'abierta') {
      throw new AppError(409, 'CONFLICT', 'La cuenta no está abierta.');
    }

    const metodo = requiredEnum(payload.metodo, 'metodo', METODOS);
    store.requireCajaAbierta();

    const rondas = store.state.pedidos
      .filter((pedido) => pedido.cuenta_id === cuenta.id && pedido.estado !== 'cancelado')
      .sort((a, b) => a.id - b.id);
    if (rondas.length === 0) {
      throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'La cuenta no tiene pedidos para cobrar.');
    }

    const total = store.round2(rondas.reduce((sum, pedido) => sum + pedido.total, 0));
    const montoEntregado = payload.monto === undefined || payload.monto === null
      ? total
      : optionalNumber(payload.monto, 'monto', { min: 0 });

    if (montoEntregado + 0.009 < total) {
      throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'El monto recibido es menor al total de la cuenta.', [
        { total, monto: montoEntregado },
      ]);
    }

    const ahora = store.nowIso();
    const numero = cuenta.comprobante_numero || store.generarComprobanteNumero();

    for (const pedido of rondas) {
      pedido.estado = 'cobrado';
      pedido.estado_pago = 'pagado';
      pedido.metodo_pago = metodo;
      pedido.comprobante_numero = numero;
    }

    cuenta.estado = 'cobrada';
    cuenta.total = total;
    cuenta.fecha_cierre = ahora;
    cuenta.usuario_cierre_id = usuario.id;
    cuenta.comprobante_numero = numero;

    const sunatInicial = sunat.estadoInicial();
    cuenta.sunat_modo = sunatInicial.modo;
    cuenta.sunat_estado = sunatInicial.estado;
    cuenta.sunat_codigo = null;
    cuenta.sunat_mensaje = sunatInicial.mensaje;
    cuenta.sunat_ticket = null;
    cuenta.sunat_fecha_envio = null;

    const mesa = store.find('mesas', cuenta.mesa_id);
    if (mesa) {
      mesa.estado = 'libre';
    }

    const pago = store.addPago({
      cuenta_id: cuenta.id,
      metodo,
      monto: total,
      usuario_id: usuario.id,
      fecha: ahora,
    });

    return {
      cuenta: await cuentaDetalle(cuenta.id),
      pago,
      comprobante: {
        tipo: cuenta.comprobante_tipo,
        numero,
        total,
        fecha: ahora,
        sunat: sunat.estadoDeCuenta(cuenta),
      },
      vuelto: store.round2(Math.max(0, montoEntregado - total)),
    };
  }

  const cuenta = await db.findOrThrow('cuentas', parseId(id), 'Cuenta');

  if (cuenta.estado === 'cobrada') {
    throw new AppError(409, 'CUENTA_YA_COBRADA', 'La cuenta ya fue cobrada.');
  }
  if (cuenta.estado !== 'abierta') {
    throw new AppError(409, 'CONFLICT', 'La cuenta no está abierta.');
  }

  const metodo = requiredEnum(payload.metodo, 'metodo', METODOS);
  await db.requireCajaAbierta();

  const rondas = await rondasDeCuenta(cuenta.id);
  if (rondas.length === 0) {
    throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'La cuenta no tiene pedidos para cobrar.');
  }

  const total = store.round2(rondas.reduce((sum, pedido) => sum + Number(pedido.total), 0));
  const montoEntregado = payload.monto === undefined || payload.monto === null
    ? total
    : optionalNumber(payload.monto, 'monto', { min: 0 });

  if (montoEntregado + 0.009 < total) {
    throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'El monto recibido es menor al total de la cuenta.', [
      { total, monto: montoEntregado },
    ]);
  }

  const ahora = db.nowIso();
  const numero = cuenta.comprobante_numero || await db.nextComprobanteNumero();

  // Sin transacción: se actualizan las rondas, la cuenta, la mesa y el pago.
  // Si un paso falla, se informa PERSISTENCIA_ERROR (ver docs/PERSISTENCIA.md).
  for (const pedido of rondas) {
    await repository.update('pedidos', pedido.id, {
      estado: 'cobrado',
      estado_pago: 'pagado',
      metodo_pago: metodo,
      comprobante_numero: numero,
    });
  }

  const sunatInicial = sunat.estadoInicial();

  await repository.update('cuentas', cuenta.id, {
    estado: 'cobrada',
    total,
    fecha_cierre: ahora,
    usuario_cierre_id: usuario.id,
    comprobante_numero: numero,
    sunat_modo: sunatInicial.modo,
    sunat_estado: sunatInicial.estado,
    sunat_codigo: null,
    sunat_mensaje: sunatInicial.mensaje,
    sunat_ticket: null,
    sunat_fecha_envio: null,
  });

  await repository.update('mesas', cuenta.mesa_id, { estado: 'libre' });

  const pago = await repository.insert('pagos', {
    cuenta_id: cuenta.id,
    metodo,
    monto: total,
    usuario_id: usuario.id,
    fecha: ahora,
  });

  return {
    cuenta: await cuentaDetalle(cuenta.id),
    pago: { ...pago, monto: Number(pago.monto) },
    comprobante: {
      tipo: cuenta.comprobante_tipo,
      numero,
      total,
      fecha: ahora,
      sunat: { ...sunatInicial },
    },
    vuelto: store.round2(Math.max(0, montoEntregado - total)),
  };
}

async function comprobanteCuenta(id) {
  const cuenta = db.isSupabase()
    ? await db.findOrThrow('cuentas', parseId(id), 'Cuenta')
    : store.findOrThrow('cuentas', parseId(id), 'Cuenta');

  if (cuenta.estado !== 'cobrada' || !cuenta.comprobante_numero) {
    throw new AppError(409, 'CONFLICT', 'El comprobante se genera al cerrar y cobrar la cuenta.');
  }

  const detalle = await cuentaDetalle(cuenta.id);
  const items = detalle.pedidos.flatMap((pedido) =>
    pedido.detalles.map((linea) => ({
      platillo_id: linea.platillo_id,
      platillo: linea.platillo_nombre,
      cantidad: linea.cantidad,
      precio_unitario: linea.precio_unitario,
      subtotal: linea.subtotal,
    })),
  );

  return {
    tipo: cuenta.comprobante_tipo,
    numero: cuenta.comprobante_numero,
    fecha: cuenta.fecha_cierre,
    cuenta_id: cuenta.id,
    mesa_numero: detalle.mesa_numero,
    cliente: 'Cliente varios',
    ruc: null,
    moneda: 'PEN',
    subtotal: detalle.subtotal,
    igv: detalle.igv,
    total: Number(cuenta.total),
    items,
    sunat: sunat.estadoDeCuenta(cuenta),
  };
}

async function cargarCuenta(id) {
  return db.isSupabase()
    ? db.findOrThrow('cuentas', parseId(id), 'Cuenta')
    : store.findOrThrow('cuentas', parseId(id), 'Cuenta');
}

async function persistirEstadoSunat(cuenta, resultado) {
  const patch = {
    sunat_modo: resultado.modo,
    sunat_estado: resultado.estado,
    sunat_codigo: resultado.codigo,
    sunat_mensaje: resultado.mensaje,
    sunat_ticket: resultado.ticket,
    sunat_fecha_envio: resultado.fecha_envio,
  };

  if (db.isSupabase()) {
    await repository.update('cuentas', cuenta.id, patch);
  } else {
    Object.assign(cuenta, patch);
  }

  return patch;
}

// Envía (o reintenta enviar) el comprobante de una cuenta cobrada al proveedor
// SUNAT configurado. Nunca lanza por un fallo del proveedor: devuelve
// estado 'error' para que la caja no se bloquee.
async function enviarComprobante(id) {
  const cuenta = await cargarCuenta(id);

  if (cuenta.estado !== 'cobrada' || !cuenta.comprobante_numero) {
    throw new AppError(409, 'CONFLICT', 'El comprobante se genera al cerrar y cobrar la cuenta.');
  }

  const comprobante = await comprobanteCuenta(cuenta.id);
  const resultado = await sunat.enviar(comprobante);
  await persistirEstadoSunat(cuenta, resultado);

  return {
    cuenta_id: cuenta.id,
    numero: cuenta.comprobante_numero,
    sunat: resultado,
  };
}

async function cancelarCuenta(id, body, usuario) {
  const payload = body && typeof body === 'object' ? body : {};
  const motivo = optionalString(payload.motivo, 'motivo', { max: 300 });

  if (!db.isSupabase()) {
    const cuenta = store.findOrThrow('cuentas', parseId(id), 'Cuenta');

    if (cuenta.estado === 'cobrada') {
      throw new AppError(409, 'CUENTA_YA_COBRADA', 'La cuenta ya fue cobrada.');
    }
    if (cuenta.estado !== 'abierta') {
      throw new AppError(409, 'CONFLICT', 'La cuenta no está abierta.');
    }

    let movimientos = 0;
    for (const pedido of store.state.pedidos.filter((item) => item.cuenta_id === cuenta.id)) {
      if (pedido.estado !== 'cancelado') {
        movimientos += pedidosLib.revertirStockPedido(
          pedido,
          usuario.id,
          motivo || 'Cancelación de cuenta',
        ).length;
        pedido.estado = 'cancelado';
      }
    }

    cuenta.estado = 'cancelada';
    cuenta.fecha_cierre = store.nowIso();
    cuenta.usuario_cierre_id = usuario.id;
    cuenta.motivo_cancelacion = motivo;

    const mesa = store.find('mesas', cuenta.mesa_id);
    if (mesa) {
      mesa.estado = 'libre';
    }

    return {
      ...(await cuentaDetalle(cuenta.id)),
      movimientos_inventario: movimientos,
    };
  }

  const cuenta = await db.findOrThrow('cuentas', parseId(id), 'Cuenta');

  if (cuenta.estado === 'cobrada') {
    throw new AppError(409, 'CUENTA_YA_COBRADA', 'La cuenta ya fue cobrada.');
  }
  if (cuenta.estado !== 'abierta') {
    throw new AppError(409, 'CONFLICT', 'La cuenta no está abierta.');
  }

  const { data: pedidosCuenta } = await repository.list('pedidos', {
    filters: { cuenta_id: cuenta.id },
    orderBy: 'id',
    ascending: true,
    limit: 100,
  });

  let movimientos = 0;
  for (const pedido of pedidosCuenta) {
    if (pedido.estado !== 'cancelado') {
      movimientos += (await pedidosDb.revertirStockPedido(
        pedido,
        usuario.id,
        motivo || 'Cancelación de cuenta',
      )).length;
      await repository.update('pedidos', pedido.id, { estado: 'cancelado' });
    }
  }

  await repository.update('cuentas', cuenta.id, {
    estado: 'cancelada',
    fecha_cierre: db.nowIso(),
    usuario_cierre_id: usuario.id,
  });

  await repository.update('mesas', cuenta.mesa_id, { estado: 'libre' });

  return {
    ...(await cuentaDetalle(cuenta.id)),
    movimientos_inventario: movimientos,
  };
}

module.exports = {
  METODOS,
  cuentaDetalle,
  listPagos,
  cobrarCuenta,
  comprobanteCuenta,
  enviarComprobante,
  cancelarCuenta,
};
