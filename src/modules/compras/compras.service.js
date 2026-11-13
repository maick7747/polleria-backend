'use strict';

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
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
  optionalAfter,
  paginate,
  pageParams,
  metaPaginada,
  parseId,
  parseSort,
} = require('../../middleware/validate');

const ESTADOS_COMPRA = ['ordenada', 'recibida', 'cancelada'];
const METODOS_PAGO_COMPRA = ['efectivo', 'transferencia'];
const CAMPOS_ORDEN_COMPRA = ['id', 'fecha', 'total', 'estado'];

function aNumero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function proveedorResumen(proveedor) {
  return proveedor
    ? { id: proveedor.id, ruc: proveedor.ruc, razon_social: proveedor.razon_social }
    : null;
}

// Valor con el que se ordena cada fila. `id`/`total` se comparan como número
// para que el orden no dependa de la representación en texto.
function valorOrden(fila, campo) {
  if (campo === 'id' || campo === 'total') {
    return aNumero(fila[campo]);
  }
  const valor = fila[campo];
  return valor === null || valor === undefined ? '' : String(valor);
}

// Desempate estable por id descendente: el comportamiento histórico del
// listado en memoria ya era id desc y así la paginación no repite filas.
function ordenarCompras(filas, campo, ascending) {
  const direccion = ascending ? 1 : -1;
  return [...filas].sort((izq, der) => {
    const a = valorOrden(izq, campo);
    const b = valorOrden(der, campo);
    if (a < b) return -1 * direccion;
    if (a > b) return 1 * direccion;
    return aNumero(der.id) - aNumero(izq.id);
  });
}

function compraConDetalles(compra) {
  const proveedor = store.find('proveedores', compra.proveedor_id);
  return {
    ...compra,
    proveedor: proveedorResumen(proveedor),
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

async function compraConDetallesSupabase(compra) {
  const [proveedor, detalles, pagos] = await Promise.all([
    repository.getById('proveedores', compra.proveedor_id),
    repository.list('compra_detalles', {
      filters: { compra_id: compra.id },
      orderBy: 'id',
      ascending: true,
      limit: 500,
    }),
    repository.list('pagos_compras', {
      filters: { compra_id: compra.id },
      orderBy: 'id',
      ascending: true,
      limit: 500,
    }),
  ]);

  const lineas = detalles.data || [];
  const insumoIds = [...new Set(lineas.map((linea) => linea.insumo_id))];
  const insumos = insumoIds.length
    ? await repository.list('insumos', { filters: { id: insumoIds }, limit: 1000 })
    : { data: [] };
  const insumosPorId = new Map((insumos.data || []).map((insumo) => [insumo.id, insumo]));

  return {
    ...compra,
    total: db.round2(aNumero(compra.total)),
    proveedor: proveedorResumen(proveedor),
    detalles: lineas.map((detalle) => {
      const insumo = insumosPorId.get(detalle.insumo_id);
      return {
        ...detalle,
        cantidad: aNumero(detalle.cantidad),
        precio_unitario: aNumero(detalle.precio_unitario),
        subtotal: db.round2(aNumero(detalle.subtotal)),
        insumo: insumo ? insumo.nombre : null,
        unidad_medida: insumo ? insumo.unidad_medida : null,
      };
    }),
    pagos: (pagos.data || []).map((pago) => ({
      ...pago,
      monto: db.round2(aNumero(pago.monto)),
    })),
  };
}

function filtrosCompras(query = {}) {
  const estado = query.estado ? requiredEnum(query.estado, 'estado', ESTADOS_COMPRA) : null;
  const proveedorId = query.proveedor_id ? parseId(query.proveedor_id, 'proveedor_id') : null;
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');
  const q = query.q ? String(query.q).trim() : '';
  const { campo, ascending } = parseSort(query.sort, CAMPOS_ORDEN_COMPRA, 'id:desc', 'sort');
  const after = optionalAfter(query);
  return { estado, proveedorId, desde, hasta, q, sort: campo, ascending, after };
}

function listComprasMemoria(filtros, query) {
  const buscado = filtros.q.toLowerCase();
  const filtradas = store.state.compras
    .filter((compra) => !filtros.estado || compra.estado === filtros.estado)
    .filter((compra) => !filtros.proveedorId || compra.proveedor_id === filtros.proveedorId)
    .filter((compra) => !filtros.after || Number(compra.id) > filtros.after)
    .filter((compra) => !filtros.desde || compra.fecha >= filtros.desde)
    .filter((compra) => !filtros.hasta || compra.fecha <= filtros.hasta)
    .filter((compra) => {
      if (!buscado) {
        return true;
      }
      const proveedor = store.find('proveedores', compra.proveedor_id);
      const enProveedor = String(proveedor ? proveedor.razon_social : '')
        .toLowerCase()
        .includes(buscado);
      const enNotas = String(compra.notas || '').toLowerCase().includes(buscado);
      return enProveedor || enNotas;
    });

  const ordenadas = ordenarCompras(filtradas, filtros.sort, filtros.ascending);
  const resultado = paginate(ordenadas, query, { cursor: true });

  const conteo = new Map();
  for (const detalle of store.state.compra_detalles) {
    conteo.set(detalle.compra_id, (conteo.get(detalle.compra_id) || 0) + 1);
  }

  return {
    data: resultado.data.map((compra) => ({
      ...compra,
      total: db.round2(aNumero(compra.total)),
      proveedor: proveedorResumen(store.find('proveedores', compra.proveedor_id)),
      items: conteo.get(compra.id) || 0,
    })),
    meta: resultado.meta,
  };
}

// Valor para el operador `or` de PostgREST: se entrecomilla para que comas,
// espacios y paréntesis del texto buscado no rompan la expresión.
function valorOrLike(texto) {
  return `"%${String(texto).replace(/"/g, '')}%"`;
}

async function listComprasSupabase(filtros, query) {
  const { page, limit } = pageParams(query);

  // PostgREST no compara columnas de tablas relacionadas en un solo filtro:
  // primero se resuelven los proveedores que coinciden con `q`.
  let proveedoresCoincidentes = null;
  if (filtros.q) {
    const { data, error } = await repository
      .table('proveedores')
      .select('id')
      .ilike('razon_social', `%${filtros.q}%`)
      .limit(1000);
    if (error) {
      throw db.persistenceError('No se pudo filtrar las compras por proveedor.', error);
    }
    proveedoresCoincidentes = (data || []).map((fila) => fila.id);
  }

  let consulta = repository.table('compras').select('*', { count: 'exact' });
  if (filtros.after) {
    consulta = consulta.gt('id', filtros.after);
  }
  if (filtros.estado) {
    consulta = consulta.eq('estado', filtros.estado);
  }
  if (filtros.proveedorId) {
    consulta = consulta.eq('proveedor_id', filtros.proveedorId);
  }
  if (filtros.desde) {
    consulta = consulta.gte('fecha', filtros.desde);
  }
  if (filtros.hasta) {
    consulta = consulta.lte('fecha', filtros.hasta);
  }
  if (filtros.q) {
    if (proveedoresCoincidentes && proveedoresCoincidentes.length > 0) {
      consulta = consulta.or(
        `notas.ilike.${valorOrLike(filtros.q)},proveedor_id.in.(${proveedoresCoincidentes.join(',')})`,
      );
    } else {
      consulta = consulta.ilike('notas', `%${filtros.q}%`);
    }
  }
  consulta = consulta
    .order(filtros.sort, { ascending: filtros.ascending })
    .order('id', { ascending: false });

  const inicio = (page - 1) * limit;
  const { data, error, count } = await consulta.range(inicio, inicio + limit - 1);
  if (error) {
    throw db.persistenceError('No se pudieron listar las compras.', error);
  }

  const compras = data || [];
  const ids = compras.map((compra) => compra.id);
  const proveedorIds = [...new Set(compras.map((compra) => compra.proveedor_id))];

  // Enriquecimiento por lote (sin N+1): una consulta de proveedores y una de
  // detalles para toda la página.
  const [proveedores, detalles] = await Promise.all([
    proveedorIds.length
      ? repository.list('proveedores', { filters: { id: proveedorIds }, limit: 1000 })
      : { data: [] },
    ids.length
      ? repository.list('compra_detalles', {
        select: 'id, compra_id',
        filters: { compra_id: ids },
        limit: 1000,
      })
      : { data: [] },
  ]);

  const proveedoresPorId = new Map((proveedores.data || []).map((proveedor) => [proveedor.id, proveedor]));
  const itemsPorCompra = new Map();
  for (const detalle of detalles.data || []) {
    itemsPorCompra.set(detalle.compra_id, (itemsPorCompra.get(detalle.compra_id) || 0) + 1);
  }

  const total = typeof count === 'number' ? count : compras.length;
  const salida = compras.map((compra) => ({
    ...compra,
    total: db.round2(aNumero(compra.total)),
    proveedor: proveedorResumen(proveedoresPorId.get(compra.proveedor_id)),
    items: itemsPorCompra.get(compra.id) || 0,
  }));
  return {
    data: salida,
    meta: metaPaginada({ page, limit, total }, salida, inicio),
  };
}

async function listCompras(query = {}) {
  const filtros = filtrosCompras(query);
  if (db.isSupabase()) {
    return listComprasSupabase(filtros, query);
  }
  return listComprasMemoria(filtros, query);
}

async function getCompra(id) {
  const compra = await db.findOrThrow('compras', parseId(id), 'Compra');
  if (!db.isSupabase()) {
    return compraConDetalles(compra);
  }
  return compraConDetallesSupabase(compra);
}

async function validarItemsCompras(items) {
  const list = requiredArray(items, 'items', { max: 100 });

  // En Supabase la existencia de los insumos se resuelve con una sola
  // consulta; en memoria se mantiene el findOrThrow por ítem para conservar
  // exactamente el mismo orden de validaciones.
  let existentes = null;
  if (db.isSupabase()) {
    const candidatos = [...new Set(
      list
        .map((item) => Number(item && item.insumo_id))
        .filter((numero) => Number.isInteger(numero) && numero > 0),
    )];
    const { data } = candidatos.length
      ? await repository.list('insumos', { select: 'id', filters: { id: candidatos }, limit: 1000 })
      : { data: [] };
    existentes = new Set((data || []).map((fila) => fila.id));
  }

  const vistos = new Set();
  let total = 0;

  const rows = list.map((item, index) => {
    const insumoId = requiredInt(item.insumo_id, `items[${index}].insumo_id`, { min: 1 });
    if (vistos.has(insumoId)) {
      throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'No se puede repetir el mismo insumo en la compra.', [
        { field: `items[${index}].insumo_id`, value: insumoId },
      ]);
    }
    if (existentes) {
      if (!existentes.has(insumoId)) {
        throw new AppError(404, 'NOT_FOUND', `Insumo con id ${insumoId} no existe.`);
      }
    } else {
      store.findOrThrow('insumos', insumoId, 'Insumo');
    }
    vistos.add(insumoId);
    const cantidad = requiredNumber(item.cantidad, `items[${index}].cantidad`, { min: 0.001 });
    const precio = requiredNumber(item.precio_unitario, `items[${index}].precio_unitario`, { min: 0 });
    const subtotal = db.round2(cantidad * precio);
    total += subtotal;
    return { insumo_id: insumoId, cantidad: db.round3(cantidad), precio_unitario: precio, subtotal };
  });

  return { rows, total: db.round2(total) };
}

// `subtotal` es una columna generada (GENERATED ALWAYS) en PostgreSQL y el
// id es IDENTITY: no se envían al insertar.
function lineaParaSupabase(linea) {
  return {
    insumo_id: linea.insumo_id,
    cantidad: linea.cantidad,
    precio_unitario: linea.precio_unitario,
  };
}

async function crearCompra(body, usuario) {
  const payload = requiredObject(body);
  const proveedorId = requiredInt(payload.proveedor_id, 'proveedor_id', { min: 1 });
  await db.findOrThrow('proveedores', proveedorId, 'Proveedor');
  const { rows, total } = await validarItemsCompras(payload.items);
  const fecha = optionalDate(payload.fecha, 'fecha') || db.today();

  if (!db.isSupabase()) {
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

  const cabecera = {
    proveedor_id: proveedorId,
    fecha,
    estado: 'ordenada',
    total,
    usuario_id: usuario.id,
    notas: optionalString(payload.notas, 'notas', { max: 500 }),
  };

  let creada;
  try {
    creada = await repository.insert('compras', cabecera);
  } catch (error) {
    throw db.persistenceError('No se pudo registrar la compra.', error);
  }

  try {
    await repository.insertMany(
      'compra_detalles',
      rows.map((row) => ({ compra_id: creada.id, ...lineaParaSupabase(row) })),
    );
  } catch (error) {
    // Compensación: sin detalles la cabecera no sirve. Si la limpieza también
    // falla, el error original sigue siendo el que se informa.
    try {
      await repository.remove('compras', creada.id);
    } catch (limpieza) {
      // la cabecera queda huérfana; se documenta en la respuesta de error
    }
    throw db.persistenceError('No se pudieron guardar los detalles de la compra.', error);
  }

  return getCompra(creada.id);
}

async function actualizarCompra(id, body) {
  const compra = await db.findOrThrow('compras', parseId(id), 'Compra');
  const payload = requiredObject(body);

  if (compra.estado !== 'ordenada') {
    throw new AppError(409, 'CONFLICT', 'Solo se puede editar una compra ordenada.');
  }

  if (!db.isSupabase()) {
    if (payload.notas !== undefined) {
      compra.notas = optionalString(payload.notas, 'notas', { max: 500 });
    }
    if (payload.fecha !== undefined) {
      compra.fecha = optionalDate(payload.fecha, 'fecha') || compra.fecha;
    }
    if (payload.items !== undefined) {
      const { rows, total } = await validarItemsCompras(payload.items);
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

  const patch = {};
  if (payload.notas !== undefined) {
    patch.notas = optionalString(payload.notas, 'notas', { max: 500 });
  }
  if (payload.fecha !== undefined) {
    patch.fecha = optionalDate(payload.fecha, 'fecha') || compra.fecha;
  }

  let nuevas = null;
  let anteriores = [];
  if (payload.items !== undefined) {
    const { rows, total } = await validarItemsCompras(payload.items);
    nuevas = rows;
    patch.total = total;
    anteriores = (await repository.list('compra_detalles', {
      filters: { compra_id: compra.id },
      limit: 500,
    })).data || [];

    const { error } = await repository
      .table('compra_detalles')
      .delete()
      .eq('compra_id', compra.id);
    if (error) {
      throw db.persistenceError('No se pudieron reemplazar los detalles de la compra.', error);
    }
  }

  try {
    if (Object.keys(patch).length > 0) {
      await repository.update('compras', compra.id, patch);
    }
    if (nuevas) {
      await repository.insertMany(
        'compra_detalles',
        nuevas.map((row) => ({ compra_id: compra.id, ...lineaParaSupabase(row) })),
      );
    }
  } catch (error) {
    // Compensación: se intenta devolver las líneas anteriores si el reemplazo
    // falló después de borrarlas.
    if (nuevas && anteriores.length > 0) {
      try {
        await repository.insertMany(
          'compra_detalles',
          anteriores.map(({ id: _id, subtotal: _subtotal, ...resto }) => resto),
        );
      } catch (restauracion) {
        // las líneas quedan perdidas; el error original se informa igual
      }
    }
    throw db.persistenceError('No se pudo actualizar la compra.', error);
  }

  return getCompra(compra.id);
}

async function recibirCompra(id, body, usuario) {
  const compra = await db.findOrThrow('compras', parseId(id), 'Compra');
  const payload = body && typeof body === 'object' ? body : {};

  if (compra.estado === 'recibida') {
    throw new AppError(409, 'COMPRA_YA_RECIBIDA', 'La compra ya fue recibida.');
  }
  if (compra.estado !== 'ordenada') {
    throw new AppError(409, 'CONFLICT', 'Solo se puede recibir una compra ordenada.');
  }

  const detalles = db.isSupabase()
    ? (await repository.list('compra_detalles', {
      filters: { compra_id: compra.id },
      orderBy: 'id',
      ascending: true,
      limit: 500,
    })).data || []
    : store.state.compra_detalles.filter((detail) => detail.compra_id === compra.id);

  // applyMovements es atómico en Supabase cuando existe la RPC 006 y aplica el
  // mismo bucle en memoria: un solo camino para ambos modos.
  await db.applyMovements(detalles.map((detalle) => ({
    insumo_id: detalle.insumo_id,
    tipo: 'entrada',
    cantidad: aNumero(detalle.cantidad),
    referencia_tipo: 'compra',
    referencia_id: compra.id,
    usuario_id: usuario.id,
    observacion: `Recepción de compra #${compra.id}`,
  })));

  for (const detalle of detalles) {
    const precio = aNumero(detalle.precio_unitario);
    if (!(precio > 0)) {
      continue;
    }
    if (db.isSupabase()) {
      await repository.update('insumos', detalle.insumo_id, { costo_promedio: db.round2(precio) });
    } else {
      const insumo = store.find('insumos', detalle.insumo_id);
      if (insumo) {
        insumo.costo_promedio = db.round2(precio);
      }
    }
  }

  const fechaRecepcion = optionalDate(payload.fecha_recepcion, 'fecha_recepcion') || db.today();

  if (db.isSupabase()) {
    await repository.update('compras', compra.id, {
      estado: 'recibida',
      fecha_recepcion: fechaRecepcion,
    });
  } else {
    compra.estado = 'recibida';
    compra.fecha_recepcion = fechaRecepcion;
  }

  return getCompra(compra.id);
}

async function cancelarCompra(id, body) {
  const compra = await db.findOrThrow('compras', parseId(id), 'Compra');
  const payload = body && typeof body === 'object' ? body : {};

  if (compra.estado !== 'ordenada') {
    throw new AppError(409, 'CONFLICT', 'Solo se puede cancelar una compra ordenada.');
  }

  const motivo = optionalString(payload.motivo, 'motivo', { max: 300 });

  if (!db.isSupabase()) {
    compra.estado = 'cancelada';
    compra.motivo_cancelacion = motivo;
    compra.fecha_cancelacion = store.nowIso();
    return compraConDetalles(compra);
  }

  const fechaCancelacion = db.nowIso();
  try {
    await repository.update('compras', compra.id, {
      estado: 'cancelada',
      motivo_cancelacion: motivo,
      fecha_cancelacion: fechaCancelacion,
    });
  } catch (error) {
    throw db.persistenceError('No se pudo cancelar la compra.', error);
  }

  const detalle = await getCompra(compra.id);
  return { ...detalle, motivo_cancelacion: motivo, fecha_cancelacion: fechaCancelacion };
}

async function registrarPago(id, body, usuario) {
  const compra = await db.findOrThrow('compras', parseId(id), 'Compra');
  const payload = requiredObject(body);
  const metodo = requiredEnum(payload.metodo, 'metodo', METODOS_PAGO_COMPRA);
  const monto = requiredNumber(payload.monto, 'monto', { min: 0.01 });
  const observacion = optionalString(payload.observacion, 'observacion', { max: 200 });

  if (compra.estado === 'cancelada') {
    throw new AppError(409, 'CONFLICT', 'Una compra cancelada no admite pagos.');
  }

  // El pago sale de la caja del día: mismo requisito que POST /gastos.
  await db.requireCajaAbierta();

  // Tope: la suma de pagos no puede exceder el total de la compra.
  const pagosPrevios = db.isSupabase()
    ? (await repository.list('pagos_compras', {
        filters: { compra_id: compra.id },
        limit: 1000,
      })).data
    : store.state.pagos_compras.filter((pago) => pago.compra_id === compra.id);
  const totalCompra = aNumero(compra.total);
  const yaPagado = store.round2(
    pagosPrevios.reduce((suma, pago) => suma + aNumero(pago.monto), 0),
  );
  if (yaPagado + monto > totalCompra + 0.009) {
    throw new AppError(
      400,
      'PAGO_EXCESIVO',
      'El pago excede el saldo pendiente de la compra.',
      [{ total: totalCompra, pagado: yaPagado, monto }],
    );
  }

  if (!db.isSupabase()) {
    const pago = {
      id: store.nextId('pagos_compras'),
      compra_id: compra.id,
      fecha: store.today(),
      metodo,
      monto: store.round2(monto),
      usuario_id: usuario.id,
      observacion,
    };
    store.state.pagos_compras.push(pago);
    return pago;
  }

  try {
    const pago = await repository.insert('pagos_compras', {
      compra_id: compra.id,
      fecha: db.today(),
      metodo,
      monto: db.round2(monto),
      usuario_id: usuario.id,
      observacion,
    });
    return { ...pago, monto: db.round2(aNumero(pago.monto)) };
  } catch (error) {
    throw db.persistenceError('No se pudo registrar el pago de la compra.', error);
  }
}

function sugerenciaDesdeInsumos(insumos) {
  return insumos
    .filter((insumo) => insumo.activo && aNumero(insumo.stock_actual) <= aNumero(insumo.stock_minimo))
    .map((insumo) => {
      const stockActual = aNumero(insumo.stock_actual);
      const stockMinimo = aNumero(insumo.stock_minimo);
      return {
        insumo_id: insumo.id,
        codigo: insumo.codigo,
        nombre: insumo.nombre,
        unidad_medida: insumo.unidad_medida,
        stock_actual: stockActual,
        stock_minimo: stockMinimo,
        cantidad_sugerida: db.round3(
          Math.max(stockMinimo * 2 - stockActual, stockMinimo - stockActual, 1),
        ),
        costo_promedio: aNumero(insumo.costo_promedio),
      };
    })
    .sort(
      (a, b) =>
        a.stock_actual / Math.max(a.stock_minimo, 0.001) -
        b.stock_actual / Math.max(b.stock_minimo, 0.001),
    );
}

async function sugerenciaCompra() {
  let data;
  if (!db.isSupabase()) {
    data = sugerenciaDesdeInsumos(store.state.insumos);
  } else {
    // PostgREST no compara dos columnas entre sí: se filtra en JS sobre los
    // insumos activos (una sola consulta).
    const { data: insumos } = await repository.list('insumos', {
      filters: { activo: true },
      limit: 1000,
    });
    data = sugerenciaDesdeInsumos(insumos || []);
  }

  return {
    data,
    meta: {
      total: data.length,
      generado_en: db.nowIso(),
      criterio: 'stock_actual <= stock_minimo',
    },
  };
}

async function lineasPlantilla(compra) {
  const detalles = db.isSupabase()
    ? (await repository.list('compra_detalles', {
      filters: { compra_id: compra.id },
      orderBy: 'id',
      ascending: true,
      limit: 500,
    })).data || []
    : store.state.compra_detalles.filter((detail) => detail.compra_id === compra.id);

  if (!db.isSupabase()) {
    return detalles.map((detail) => {
      const insumo = store.find('insumos', detail.insumo_id);
      return {
        cantidad: detail.cantidad,
        precio_unitario: detail.precio_unitario,
        unidad_medida: insumo ? insumo.unidad_medida : '',
        nombre: insumo ? insumo.nombre : 'insumo',
      };
    });
  }

  const insumoIds = [...new Set(detalles.map((detail) => detail.insumo_id))];
  const insumos = insumoIds.length
    ? await repository.list('insumos', { filters: { id: insumoIds }, limit: 1000 })
    : { data: [] };
  const insumosPorId = new Map((insumos.data || []).map((insumo) => [insumo.id, insumo]));

  return detalles.map((detail) => {
    const insumo = insumosPorId.get(detail.insumo_id);
    return {
      cantidad: aNumero(detail.cantidad),
      precio_unitario: aNumero(detail.precio_unitario),
      unidad_medida: insumo ? insumo.unidad_medida : '',
      nombre: insumo ? insumo.nombre : 'insumo',
    };
  });
}

async function plantillaCompra(id, query = {}) {
  const compra = await db.findOrThrow('compras', parseId(id), 'Compra');
  const canal = query.canal ? requiredEnum(query.canal, 'canal', ['whatsapp', 'telefono']) : 'whatsapp';
  const proveedor = db.isSupabase()
    ? await repository.getById('proveedores', compra.proveedor_id)
    : store.find('proveedores', compra.proveedor_id);
  const lineas = (await lineasPlantilla(compra)).map(
    (linea) =>
      `- ${linea.cantidad} ${linea.unidad_medida} de ${linea.nombre} (S/ ${linea.precio_unitario.toFixed(2)} c/u)`,
  );

  const mensaje = [
    `Hola ${proveedor ? proveedor.contacto_nombre || proveedor.razon_social : 'proveedor'}, le escribo de Fratelli's Restaurante.`,
    `Necesito confirmar el pedido #${compra.id} del ${compra.fecha}:`,
    ...lineas,
    `Total estimado: S/ ${aNumero(compra.total).toFixed(2)}.`,
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

async function listProveedores(query = {}) {
  const q = query.q ? String(query.q).trim() : '';

  if (!db.isSupabase()) {
    const buscado = q.toLowerCase();
    const data = store.state.proveedores
      .filter((proveedor) => proveedor.activo)
      .filter(
        (proveedor) =>
          !buscado ||
          proveedor.razon_social.toLowerCase().includes(buscado) ||
          proveedor.ruc.includes(buscado),
      )
      .sort((a, b) => a.razon_social.localeCompare(b.razon_social));

    return paginate(data, query);
  }

  const { page, limit } = pageParams(query);
  let consulta = repository
    .table('proveedores')
    .select('*', { count: 'exact' })
    .eq('activo', true);

  if (q) {
    const patron = valorOrLike(q);
    consulta = consulta.or(`razon_social.ilike.${patron},ruc.ilike.${patron}`);
  }
  consulta = consulta.order('razon_social', { ascending: true }).order('id', { ascending: true });

  const inicio = (page - 1) * limit;
  const { data, error, count } = await consulta.range(inicio, inicio + limit - 1);
  if (error) {
    throw db.persistenceError('No se pudieron listar los proveedores.', error);
  }

  const total = typeof count === 'number' ? count : (data || []).length;
  return {
    data: data || [],
    meta: { page, limit, total, pages: total === 0 ? 0 : Math.ceil(total / limit) },
  };
}

async function crearProveedor(body) {
  const payload = requiredObject(body);
  const ruc = requiredString(payload.ruc, 'ruc', { max: 11 });
  if (!/^\d{11}$/.test(ruc)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El RUC debe tener 11 dígitos.', [{ field: 'ruc', value: ruc }]);
  }

  if (!db.isSupabase()) {
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

  const existente = await db.findOne('proveedores', { ruc });
  if (existente) {
    throw new AppError(409, 'CONFLICT', 'Ya existe un proveedor con ese RUC.');
  }

  const fila = {
    ruc,
    razon_social: requiredString(payload.razon_social, 'razon_social', { max: 150 }),
    contacto_nombre: optionalString(payload.contacto_nombre, 'contacto_nombre', { max: 120 }),
    telefono: optionalString(payload.telefono, 'telefono', { max: 20 }),
    direccion: optionalString(payload.direccion, 'direccion', { max: 200 }),
    email: optionalString(payload.email, 'email', { max: 150 }),
    activo: true,
  };

  try {
    return await repository.insert('proveedores', fila);
  } catch (error) {
    if (String(error && error.code) === '23505') {
      throw new AppError(409, 'CONFLICT', 'Ya existe un proveedor con ese RUC.');
    }
    throw db.persistenceError('No se pudo registrar el proveedor.', error);
  }
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
