'use strict';

const store = require('../../data/store');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredString,
  requiredInt,
  requiredNumber,
  requiredEnum,
  requiredArray,
  optionalString,
  optionalDate,
  paginate,
  parseId,
} = require('../../middleware/validate');

const ESTADOS_COMPRA = ['ordenada', 'recibida', 'cancelada'];
const METODOS_PAGO_COMPRA = ['efectivo', 'transferencia'];

function proveedorConDatos(proveedorId) {
  return store.find('proveedores', proveedorId) || null;
}

function compraConDetalles(compra) {
  const proveedor = proveedorConDatos(compra.proveedor_id);
  return {
    ...compra,
    proveedor: proveedor
      ? { id: proveedor.id, ruc: proveedor.ruc, razon_social: proveedor.razon_social }
      : null,
    detalles: store.state.compra_detalles
      .filter((detail) => detail.compra_id === compra.id)
      .map((detail) => {
        const insumo = store.find('insumos', detail.insumo_id);
        return {
          ...detail,
          insumo: insumo ? insumo.nombre : null,
          unidad_medida: insumo ? insumo.unidad_medida : null,
        };
      }),
    pagos: store.state.pagos_compras.filter((pago) => pago.compra_id === compra.id),
  };
}

function listCompras(query = {}) {
  const estado = query.estado ? requiredEnum(query.estado, 'estado', ESTADOS_COMPRA) : null;
  const proveedorId = query.proveedor_id ? parseId(query.proveedor_id, 'proveedor_id') : null;
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');

  const data = store.state.compras
    .filter((compra) => !estado || compra.estado === estado)
    .filter((compra) => !proveedorId || compra.proveedor_id === proveedorId)
    .filter((compra) => !desde || compra.fecha >= desde)
    .filter((compra) => !hasta || compra.fecha <= hasta)
    .sort((a, b) => b.id - a.id)
    .map(compraConDetalles);

  return paginate(data, query);
}

function getCompra(id) {
  return compraConDetalles(store.findOrThrow('compras', parseId(id), 'Compra'));
}

function validarItemsCompras(items) {
  const list = requiredArray(items, 'items', { max: 100 });
  const vistos = new Set();
  let total = 0;

  const rows = list.map((item, index) => {
    const insumoId = requiredInt(item.insumo_id, `items[${index}].insumo_id`, { min: 1 });
    store.findOrThrow('insumos', insumoId, 'Insumo');
    if (vistos.has(insumoId)) {
      throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'No se puede repetir el mismo insumo en la compra.', [
        { field: `items[${index}].insumo_id`, value: insumoId },
      ]);
    }
    vistos.add(insumoId);
    const cantidad = requiredNumber(item.cantidad, `items[${index}].cantidad`, { min: 0.001 });
    const precio = requiredNumber(item.precio_unitario, `items[${index}].precio_unitario`, { min: 0 });
    const subtotal = store.round2(cantidad * precio);
    total += subtotal;
    return { insumo_id: insumoId, cantidad: store.round3(cantidad), precio_unitario: precio, subtotal };
  });

  return { rows, total: store.round2(total) };
}

function crearCompra(body, usuario) {
  const payload = requiredObject(body);
  const proveedorId = requiredInt(payload.proveedor_id, 'proveedor_id', { min: 1 });
  store.findOrThrow('proveedores', proveedorId, 'Proveedor');
  const { rows, total } = validarItemsCompras(payload.items);
  const fecha = optionalDate(payload.fecha, 'fecha') || store.today();

  const compra = {
    id: store.nextId('compras'),
    proveedor_id: proveedorId,
    fecha,
    estado: 'ordenada',
    total,
    usuario_id: usuario.id,
    notas: optionalString(payload.notas, 'notas', { max: 500 }),
    fecha_recepcion: null,
    creado_en: store.nowIso(),
  };
  store.state.compras.push(compra);

  for (const row of rows) {
    store.state.compra_detalles.push({
      id: store.nextId('compra_detalles'),
      compra_id: compra.id,
      ...row,
    });
  }

  return compraConDetalles(compra);
}

function actualizarCompra(id, body) {
  const compra = store.findOrThrow('compras', parseId(id), 'Compra');
  const payload = requiredObject(body);

  if (compra.estado !== 'ordenada') {
    throw new AppError(409, 'CONFLICT', 'Solo se puede editar una compra ordenada.');
  }

  if (payload.notas !== undefined) {
    compra.notas = optionalString(payload.notas, 'notas', { max: 500 });
  }
  if (payload.fecha !== undefined) {
    compra.fecha = optionalDate(payload.fecha, 'fecha') || compra.fecha;
  }
  if (payload.items !== undefined) {
    const { rows, total } = validarItemsCompras(payload.items);
    store.state.compra_detalles = store.state.compra_detalles.filter(
      (detail) => detail.compra_id !== compra.id,
    );
    for (const row of rows) {
      store.state.compra_detalles.push({
        id: store.nextId('compra_detalles'),
        compra_id: compra.id,
        ...row,
      });
    }
    compra.total = total;
  }

  return compraConDetalles(compra);
}

function recibirCompra(id, body, usuario) {
  const compra = store.findOrThrow('compras', parseId(id), 'Compra');
  const payload = body && typeof body === 'object' ? body : {};

  if (compra.estado === 'recibida') {
    throw new AppError(409, 'COMPRA_YA_RECIBIDA', 'La compra ya fue recibida.');
  }
  if (compra.estado !== 'ordenada') {
    throw new AppError(409, 'CONFLICT', 'Solo se puede recibir una compra ordenada.');
  }

  const detalles = store.state.compra_detalles.filter((detail) => detail.compra_id === compra.id);
  for (const detail of detalles) {
    store.applyMovement({
      insumo_id: detail.insumo_id,
      tipo: 'entrada',
      cantidad: detail.cantidad,
      referencia_tipo: 'compra',
      referencia_id: compra.id,
      usuario_id: usuario.id,
      observacion: `Recepción de compra #${compra.id}`,
    });
    const insumo = store.find('insumos', detail.insumo_id);
    if (insumo && detail.precio_unitario > 0) {
      insumo.costo_promedio = store.round2(detail.precio_unitario);
    }
  }

  compra.estado = 'recibida';
  compra.fecha_recepcion = optionalDate(payload.fecha_recepcion, 'fecha_recepcion') || store.today();

  return compraConDetalles(compra);
}

function cancelarCompra(id, body) {
  const compra = store.findOrThrow('compras', parseId(id), 'Compra');
  const payload = body && typeof body === 'object' ? body : {};

  if (compra.estado !== 'ordenada') {
    throw new AppError(409, 'CONFLICT', 'Solo se puede cancelar una compra ordenada.');
  }

  compra.estado = 'cancelada';
  compra.motivo_cancelacion = optionalString(payload.motivo, 'motivo', { max: 300 });
  compra.fecha_cancelacion = store.nowIso();
  return compraConDetalles(compra);
}

function registrarPago(id, body, usuario) {
  const compra = store.findOrThrow('compras', parseId(id), 'Compra');
  const payload = requiredObject(body);
  const metodo = requiredEnum(payload.metodo, 'metodo', METODOS_PAGO_COMPRA);
  const monto = requiredNumber(payload.monto, 'monto', { min: 0.01 });

  const pago = {
    id: store.nextId('pagos_compras'),
    compra_id: compra.id,
    fecha: store.today(),
    metodo,
    monto: store.round2(monto),
    usuario_id: usuario.id,
    observacion: optionalString(payload.observacion, 'observacion', { max: 200 }),
  };
  store.state.pagos_compras.push(pago);
  return pago;
}

function sugerenciaCompra() {
  const data = store.state.insumos
    .filter((insumo) => insumo.activo && insumo.stock_actual <= insumo.stock_minimo)
    .map((insumo) => ({
      insumo_id: insumo.id,
      codigo: insumo.codigo,
      nombre: insumo.nombre,
      unidad_medida: insumo.unidad_medida,
      stock_actual: insumo.stock_actual,
      stock_minimo: insumo.stock_minimo,
      cantidad_sugerida: store.round3(
        Math.max(insumo.stock_minimo * 2 - insumo.stock_actual, insumo.stock_minimo - insumo.stock_actual, 1),
      ),
      costo_promedio: insumo.costo_promedio,
    }))
    .sort((a, b) => a.stock_actual / Math.max(a.stock_minimo, 0.001) - b.stock_actual / Math.max(b.stock_minimo, 0.001));

  return {
    data,
    meta: {
      total: data.length,
      generado_en: store.nowIso(),
      criterio: 'stock_actual <= stock_minimo',
    },
  };
}

function plantillaCompra(id, query = {}) {
  const compra = store.findOrThrow('compras', parseId(id), 'Compra');
  const canal = query.canal ? requiredEnum(query.canal, 'canal', ['whatsapp', 'telefono']) : 'whatsapp';
  const proveedor = proveedorConDatos(compra.proveedor_id);
  const detalles = store.state.compra_detalles.filter((detail) => detail.compra_id === compra.id);

  const lineas = detalles.map((detail) => {
    const insumo = store.find('insumos', detail.insumo_id);
    return `- ${detail.cantidad} ${insumo ? insumo.unidad_medida : ''} de ${insumo ? insumo.nombre : 'insumo'} (S/ ${detail.precio_unitario.toFixed(2)} c/u)`;
  });

  const mensaje = [
    `Hola ${proveedor ? proveedor.contacto_nombre || proveedor.razon_social : 'proveedor'}, le escribo de Fratelli's Restaurante.`,
    `Necesito confirmar el pedido #${compra.id} del ${compra.fecha}:`,
    ...lineas,
    `Total estimado: S/ ${compra.total.toFixed(2)}.`,
    'Quedo atento a su confirmación. Gracias.',
  ].join('\n');

  return {
    compra_id: compra.id,
    proveedor: proveedor
      ? {
          id: proveedor.id,
          razon_social: proveedor.razon_social,
          telefono: proveedor.telefono,
          email: proveedor.email,
        }
      : null,
    canal,
    mensaje,
  };
}

function listProveedores(query = {}) {
  const q = query.q ? String(query.q).trim().toLowerCase() : '';
  const data = store.state.proveedores
    .filter((proveedor) => proveedor.activo)
    .filter(
      (proveedor) =>
        !q ||
        proveedor.razon_social.toLowerCase().includes(q) ||
        proveedor.ruc.includes(q),
    )
    .sort((a, b) => a.razon_social.localeCompare(b.razon_social));

  return paginate(data, query);
}

function crearProveedor(body) {
  const payload = requiredObject(body);
  const ruc = requiredString(payload.ruc, 'ruc', { max: 11 });
  if (!/^\d{11}$/.test(ruc)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El RUC debe tener 11 dígitos.', [{ field: 'ruc', value: ruc }]);
  }
  if (store.state.proveedores.some((proveedor) => proveedor.ruc === ruc)) {
    throw new AppError(409, 'CONFLICT', 'Ya existe un proveedor con ese RUC.');
  }

  const proveedor = {
    id: store.nextId('proveedores'),
    ruc,
    razon_social: requiredString(payload.razon_social, 'razon_social', { max: 150 }),
    contacto_nombre: optionalString(payload.contacto_nombre, 'contacto_nombre', { max: 120 }),
    telefono: optionalString(payload.telefono, 'telefono', { max: 20 }),
    direccion: optionalString(payload.direccion, 'direccion', { max: 200 }),
    email: optionalString(payload.email, 'email', { max: 150 }),
    activo: true,
  };
  store.state.proveedores.push(proveedor);
  return proveedor;
}

module.exports = {
  listCompras,
  getCompra,
  crearCompra,
  actualizarCompra,
  recibirCompra,
  cancelarCompra,
  registrarPago,
  sugerenciaCompra,
  plantillaCompra,
  listProveedores,
  crearProveedor,
};
