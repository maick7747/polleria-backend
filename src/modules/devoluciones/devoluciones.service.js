'use strict';

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredString,
  requiredNumber,
  requiredEnum,
  optionalString,
  optionalDate,
  optionalAfter,
  paginate,
  pageParams,
  metaPaginada,
  parseId,
  parseSort,
} = require('../../middleware/validate');

const RESOLUCIONES = ['re_preparar', 'corregir', 'reembolso_total', 'reembolso_parcial'];
const METODOS_REEMBOLSO = ['efectivo', 'tarjeta', 'yape', 'plin', 'transferencia'];
const ESTADOS = ['pendiente', 'aceptada', 'rechazada'];
const CAMPOS_ORDEN = ['id', 'fecha_reporte', 'monto_reembolsado', 'estado'];

function aNumero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function reembolsoDTO(fila) {
  return {
    id: fila.id,
    devolucion_id: fila.devolucion_id,
    metodo: fila.metodo,
    monto: db.round2(aNumero(fila.monto)),
    observacion: fila.observacion === undefined ? null : fila.observacion,
    usuario_id: fila.usuario_id,
    fecha: fila.fecha,
  };
}

function detalleResolucion(payload) {
  const texto = payload.detalle_resolucion !== undefined
    ? payload.detalle_resolucion
    : (payload.observacion !== undefined
      ? payload.observacion
      : (payload.detalle !== undefined ? payload.detalle : payload.motivo));
  return optionalString(texto, 'detalle_resolucion', { max: 1000 });
}

function valorOrden(fila, campo) {
  if (campo === 'id' || campo === 'monto_reembolsado') {
    return aNumero(fila[campo]);
  }
  const valor = fila[campo];
  return valor === null || valor === undefined ? '' : String(valor);
}

function ordenar(filas, campo, ascending) {
  const direccion = ascending ? 1 : -1;
  return [...filas].sort((izq, der) => {
    const a = valorOrden(izq, campo);
    const b = valorOrden(der, campo);
    if (a < b) return -1 * direccion;
    if (a > b) return 1 * direccion;
    return aNumero(der.id) - aNumero(izq.id);
  });
}

function devolucionDTO(devolucion, refs = {}) {
  return {
    ...devolucion,
    monto_reembolsado: db.round2(aNumero(devolucion.monto_reembolsado)),
    pedido_numero: refs.pedido_numero === undefined ? null : refs.pedido_numero,
    pedido_total: refs.pedido_total === undefined ? null : refs.pedido_total,
    platillo: refs.platillo === undefined ? null : refs.platillo,
    merma: refs.merma === undefined ? null : refs.merma,
    reembolsos: refs.reembolsos === undefined ? [] : refs.reembolsos,
    registrado_por_id: devolucion.registrado_por_id === undefined
      ? null
      : devolucion.registrado_por_id,
  };
}

function enriquecerDevolucion(devolucion) {
  const pedido = store.find('pedidos', devolucion.pedido_id);
  const merma = devolucion.merma_id ? store.find('mermas', devolucion.merma_id) : null;
  const detalle = devolucion.pedido_detalle_id
    ? store.find('pedido_detalles', devolucion.pedido_detalle_id)
    : null;
  const platillo = detalle ? store.find('platillos', detalle.platillo_id) : null;

  return devolucionDTO(devolucion, {
    pedido_numero: pedido ? pedido.numero : null,
    pedido_total: pedido ? db.round2(aNumero(pedido.total)) : null,
    platillo: platillo ? platillo.nombre : null,
    merma: merma
      ? { id: merma.id, estado: merma.estado, costo_estimado: db.round2(aNumero(merma.costo_estimado)) }
      : null,
    reembolsos: store.state.devolucion_reembolsos
      .filter((item) => item.devolucion_id === devolucion.id)
      .map(reembolsoDTO),
  });
}

async function porIds(tabla, ids, select) {
  const limpios = [...new Set(ids.map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  if (limpios.length === 0) {
    return new Map();
  }
  const { data } = await repository.list(tabla, { select, filters: { id: limpios }, limit: 1000 });
  return new Map((data || []).map((fila) => [fila.id, fila]));
}

// Enriquecimiento por lotes: pedidos, mermas, líneas, platillos y el histórico
// de reembolsos (devolucion_reembolsos), sin N+1.
async function enriquecerDevolucionesSupabase(filas) {
  const devolucionIds = filas.map((fila) => fila.id);
  const [pedidos, mermas, detalles, reembolsos] = await Promise.all([
    porIds('pedidos', filas.map((fila) => fila.pedido_id), 'id, numero, total'),
    porIds('mermas', filas.map((fila) => fila.merma_id), 'id, estado, costo_estimado'),
    porIds(
      'pedido_detalles',
      filas.map((fila) => fila.pedido_detalle_id),
      'id, platillo_id',
    ),
    devolucionIds.length
      ? repository.list('devolucion_reembolsos', {
        filters: { devolucion_id: devolucionIds },
        orderBy: 'id',
        ascending: true,
        limit: 1000,
      })
      : { data: [] },
  ]);

  const platillos = await porIds(
    'platillos',
    [...detalles.values()].map((detalle) => detalle.platillo_id),
    'id, nombre',
  );

  const reembolsosPorDevolucion = new Map();
  for (const fila of reembolsos.data || []) {
    const lista = reembolsosPorDevolucion.get(fila.devolucion_id) || [];
    lista.push(fila);
    reembolsosPorDevolucion.set(fila.devolucion_id, lista);
  }

  return filas.map((fila) => {
    const pedido = pedidos.get(fila.pedido_id);
    const merma = fila.merma_id ? mermas.get(fila.merma_id) : null;
    const detalle = fila.pedido_detalle_id ? detalles.get(fila.pedido_detalle_id) : null;
    const platillo = detalle ? platillos.get(detalle.platillo_id) : null;

    return devolucionDTO(fila, {
      pedido_numero: pedido ? pedido.numero : null,
      pedido_total: pedido ? db.round2(aNumero(pedido.total)) : null,
      platillo: platillo ? platillo.nombre : null,
      merma: merma
        ? {
          id: merma.id,
          estado: merma.estado,
          costo_estimado: db.round2(aNumero(merma.costo_estimado)),
        }
        : null,
      reembolsos: (reembolsosPorDevolucion.get(fila.id) || []).map(reembolsoDTO),
    });
  });
}

function filtrosDevolucion(query = {}) {
  const estado = query.estado ? requiredEnum(query.estado, 'estado', ESTADOS) : null;
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');
  const q = query.q ? String(query.q).trim() : '';
  const { campo, ascending } = parseSort(
    query.sort,
    CAMPOS_ORDEN,
    'fecha_reporte:desc',
    'sort',
  );
  const after = optionalAfter(query);
  return { estado, desde, hasta, q, sort: campo, ascending, after };
}

function listDevolucionesMemoria(filtros, query) {
  const buscado = filtros.q.toLowerCase();
  const filtradas = store.state.devoluciones
    .filter((item) => !filtros.estado || item.estado === filtros.estado)
    .filter((item) => !filtros.after || Number(item.id) > filtros.after)
    .filter((item) => !filtros.desde || item.fecha_reporte.slice(0, 10) >= filtros.desde)
    .filter((item) => !filtros.hasta || item.fecha_reporte.slice(0, 10) <= filtros.hasta)
    .filter((item) => !buscado || String(item.motivo || '').toLowerCase().includes(buscado));

  const ordenadas = ordenar(filtradas, filtros.sort, filtros.ascending);
  return paginate(ordenadas.map(enriquecerDevolucion), query, { cursor: true });
}

function finExclusivo(fecha) {
  const [anio, mes, dia] = fecha.split('-').map(Number);
  const siguiente = new Date(Date.UTC(anio, mes - 1, dia + 1));
  return siguiente.toISOString().slice(0, 10);
}

async function listDevolucionesSupabase(filtros, query) {
  const { page, limit } = pageParams(query);

  let consulta = repository.table('devoluciones').select('*', { count: 'exact' });
  if (filtros.after) {
    consulta = consulta.gt('id', filtros.after);
  }
  if (filtros.estado) {
    consulta = consulta.eq('estado', filtros.estado);
  }
  if (filtros.desde) {
    consulta = consulta.gte('fecha_reporte', filtros.desde);
  }
  if (filtros.hasta) {
    consulta = consulta.lt('fecha_reporte', finExclusivo(filtros.hasta));
  }
  if (filtros.q) {
    // `%` y `_` son comodines de LIKE: se limpian para no ampliar la búsqueda.
    const texto = String(filtros.q).replace(/[%_]/g, '');
    consulta = consulta.ilike('motivo', `%${texto}%`);
  }
  consulta = consulta
    .order(filtros.sort, { ascending: filtros.ascending })
    .order('id', { ascending: false });

  const inicio = (page - 1) * limit;
  const { data, error, count } = await consulta.range(inicio, inicio + limit - 1);
  if (error) {
    throw db.persistenceError('No se pudieron listar las devoluciones.', error);
  }

  const filas = data || [];
  const total = typeof count === 'number' ? count : filas.length;
  const salida = await enriquecerDevolucionesSupabase(filas);
  return {
    data: salida,
    meta: metaPaginada({ page, limit, total }, salida, inicio),
  };
}

async function listDevoluciones(query = {}) {
  const filtros = filtrosDevolucion(query);
  if (db.isSupabase()) {
    return listDevolucionesSupabase(filtros, query);
  }
  return listDevolucionesMemoria(filtros, query);
}

async function getDevolucion(id) {
  const devolucion = await db.findOrThrow('devoluciones', parseId(id), 'Devolución');
  if (!db.isSupabase()) {
    return enriquecerDevolucion(devolucion);
  }
  const [dto] = await enriquecerDevolucionesSupabase([devolucion]);
  return dto;
}

async function crearDevolucion(body, usuario) {
  const payload = requiredObject(body);
  const pedidoId = requiredNumber(payload.pedido_id, 'pedido_id', { min: 1 });

  const base = {
    pedido_id: pedidoId,
    fecha_reporte: db.nowIso(),
    motivo: requiredString(payload.motivo, 'motivo', { max: 200 }),
    detalle: optionalString(payload.detalle, 'detalle', { max: 1000 }),
    monto_reembolsado: 0,
    estado: 'pendiente',
    resolucion: null,
    decidido_por_id: null,
    fecha_resolucion: null,
    merma_id: null,
    pago_id: null,
    notificado_dueno: true,
  };

  if (!db.isSupabase()) {
    const pedido = store.findOrThrow('pedidos', pedidoId, 'Pedido');

    let detalleId = null;
    if (payload.pedido_detalle_id !== undefined && payload.pedido_detalle_id !== null) {
      detalleId = parseId(payload.pedido_detalle_id, 'pedido_detalle_id');
      const detalle = store.findOrThrow('pedido_detalles', detalleId, 'Línea de pedido');
      if (detalle.pedido_id !== pedido.id) {
        throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'La línea no pertenece al pedido indicado.');
      }
    }

    const devolucion = {
      id: store.nextId('devoluciones'),
      ...base,
      pedido_detalle_id: detalleId,
      registrado_por_id: usuario.id,
      creado_en: store.nowIso(),
    };
    store.state.devoluciones.push(devolucion);
    return enriquecerDevolucion(devolucion);
  }

  const pedido = await db.findOrThrow('pedidos', pedidoId, 'Pedido');

  let detalleId = null;
  if (payload.pedido_detalle_id !== undefined && payload.pedido_detalle_id !== null) {
    detalleId = parseId(payload.pedido_detalle_id, 'pedido_detalle_id');
    const detalle = await db.findOrThrow('pedido_detalles', detalleId, 'Línea de pedido');
    if (Number(detalle.pedido_id) !== Number(pedido.id)) {
      throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'La línea no pertenece al pedido indicado.');
    }
  }

  let creada;
  try {
    creada = await repository.insert('devoluciones', {
      ...base,
      pedido_detalle_id: detalleId,
      registrado_por_id: usuario.id,
    });
  } catch (error) {
    throw db.persistenceError('No se pudo registrar la devolución.', error);
  }

  const [dto] = await enriquecerDevolucionesSupabase([creada]);
  return dto;
}

async function tipoMermaPorDefecto() {
  const { data } = await repository.list('tipos_merma', {
    orderBy: 'id',
    ascending: true,
    limit: 1000,
  });
  const filas = data || [];
  const tipo = filas.find((item) => Number(item.id) === 1) || filas[0];
  if (!tipo) {
    throw new AppError(
      422,
      'BUSINESS_RULE_VIOLATION',
      'No hay tipos de merma configurados para registrar la devolución.',
    );
  }
  return tipo.id;
}

async function crearMermaPorDevolucionSupabase(devolucion, usuario) {
  let detalle = null;
  if (devolucion.pedido_detalle_id) {
    detalle = await repository.getById('pedido_detalles', devolucion.pedido_detalle_id);
  } else {
    const { data } = await repository.list('pedido_detalles', {
      filters: { pedido_id: devolucion.pedido_id },
      orderBy: 'id',
      ascending: true,
      limit: 1,
    });
    detalle = data && data[0] ? data[0] : null;
  }
  if (!detalle) {
    return null;
  }

  const { data: fichas } = await repository.list('fichas_tecnicas', {
    filters: { platillo_id: detalle.platillo_id, activa: true },
    orderBy: 'id',
    ascending: true,
    limit: 1,
  });
  const ficha = fichas && fichas[0];
  const porciones = ficha ? Number(ficha.porciones_rendimiento) || 1 : 1;
  const costo = ficha
    ? db.round2((Number(ficha.costo_total) / porciones) * Number(detalle.cantidad))
    : 0;
  const tipoMermaId = await tipoMermaPorDefecto();

  return repository.insert('mermas', {
    tipo_merma_id: tipoMermaId,
    insumo_id: null,
    platillo_id: detalle.platillo_id,
    cantidad: Number(detalle.cantidad),
    costo_estimado: costo,
    clasificacion: 'evitable',
    causa_raiz: 'Devolución de cliente',
    motivo: `Devolución #${devolucion.id}: ${devolucion.motivo}`,
    fecha: db.today(),
    estado: 'pendiente',
    usuario_registro_id: usuario.id,
    origen: 'devolucion',
  });
}

async function resolverDevolucionSupabase(devolucion, payload, usuario) {
  const estado = requiredEnum(payload.estado, 'estado', ['aceptada', 'rechazada']);

  if (estado === 'rechazada') {
    const patch = {
      estado: 'rechazada',
      decidido_por_id: usuario.id,
      fecha_resolucion: db.nowIso(),
      detalle_resolucion: detalleResolucion(payload),
    };
    let actualizada;
    try {
      // UPDATE condicional: solo gana quien encuentra la devolución 'pendiente'.
      const filas = await repository.updateWhere(
        'devoluciones',
        { id: devolucion.id, estado: 'pendiente' },
        patch,
      );
      actualizada = filas && filas.length > 0 ? filas[0] : null;
    } catch (error) {
      throw db.persistenceError('No se pudo rechazar la devolución.', error);
    }
    if (!actualizada) {
      throw new AppError(409, 'CONFLICT', 'La devolución ya fue resuelta por otra terminal.');
    }
    const [dto] = await enriquecerDevolucionesSupabase([actualizada]);
    return dto;
  }

  const resolucion = requiredEnum(payload.resolucion, 'resolucion', RESOLUCIONES);
  const monto = payload.monto_reembolsado === undefined
    ? 0
    : requiredNumber(payload.monto_reembolsado, 'monto_reembolsado', { min: 0 });

  let merma = null;
  if (resolucion !== 'corregir') {
    try {
      merma = await crearMermaPorDevolucionSupabase(devolucion, usuario);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw db.persistenceError('No se pudo registrar la merma de la devolución.', error);
    }
  }

  const patch = {
    estado: 'aceptada',
    resolucion,
    decidido_por_id: usuario.id,
    fecha_resolucion: db.nowIso(),
    detalle_resolucion: detalleResolucion(payload),
    monto_reembolsado: db.round2(monto),
    merma_id: merma ? merma.id : null,
  };

  let actualizada;
  try {
    // UPDATE condicional: si otra terminal ya resolvió, no se publica la merma
    // creada arriba (se elimina como compensación).
    const filas = await repository.updateWhere(
      'devoluciones',
      { id: devolucion.id, estado: 'pendiente' },
      patch,
    );
    actualizada = filas && filas.length > 0 ? filas[0] : null;
  } catch (error) {
    // Compensación: la merma ya se insertó y la devolución no se actualizó.
    if (merma) {
      try {
        await repository.remove('mermas', merma.id);
      } catch (compensacionError) {
        error.compensacion = compensacionError.message;
      }
    }
    throw db.persistenceError('No se pudo resolver la devolución.', error);
  }

  if (!actualizada) {
    if (merma) {
      try {
        await repository.remove('mermas', merma.id);
      } catch (compensacionError) {
        // La merma duplicada queda para revisión manual; el 409 es lo importante.
      }
    }
    throw new AppError(409, 'CONFLICT', 'La devolución ya fue resuelta por otra terminal.');
  }

  const [dto] = await enriquecerDevolucionesSupabase([actualizada]);
  return dto;
}

async function resolverDevolucion(id, body, usuario) {
  const devolucion = await db.findOrThrow('devoluciones', parseId(id), 'Devolución');
  const payload = requiredObject(body);

  if (devolucion.estado !== 'pendiente') {
    throw new AppError(409, 'CONFLICT', 'La devolución ya fue resuelta.');
  }

  if (db.isSupabase()) {
    return resolverDevolucionSupabase(devolucion, payload, usuario);
  }

  const estado = requiredEnum(payload.estado, 'estado', ['aceptada', 'rechazada']);

  if (estado === 'rechazada') {
    devolucion.estado = 'rechazada';
    devolucion.decidido_por_id = usuario.id;
    devolucion.fecha_resolucion = store.nowIso();
    devolucion.detalle_resolucion = detalleResolucion(payload);
    return enriquecerDevolucion(devolucion);
  }

  const resolucion = requiredEnum(payload.resolucion, 'resolucion', RESOLUCIONES);
  devolucion.estado = 'aceptada';
  devolucion.resolucion = resolucion;
  devolucion.decidido_por_id = usuario.id;
  devolucion.fecha_resolucion = store.nowIso();
  devolucion.detalle_resolucion = detalleResolucion(payload);
  devolucion.monto_reembolsado = payload.monto_reembolsado === undefined
    ? 0
    : store.round2(requiredNumber(payload.monto_reembolsado, 'monto_reembolsado', { min: 0 }));

  if (resolucion !== 'corregir') {
    const merma = crearMermaPorDevolucion(devolucion, usuario);
    if (merma) {
      devolucion.merma_id = merma.id;
    }
  }

  return enriquecerDevolucion(devolucion);
}

function crearMermaPorDevolucion(devolucion, usuario) {
  const detalle = devolucion.pedido_detalle_id
    ? store.find('pedido_detalles', devolucion.pedido_detalle_id)
    : store.state.pedido_detalles.find((item) => item.pedido_id === devolucion.pedido_id);

  if (!detalle) {
    return null;
  }

  const ficha = store.state.fichas_tecnicas.find(
    (item) => item.platillo_id === detalle.platillo_id && item.activa,
  );
  const porciones = ficha ? ficha.porciones_rendimiento || 1 : 1;
  const costo = ficha ? store.round2((ficha.costo_total / porciones) * detalle.cantidad) : 0;

  const merma = {
    id: store.nextId('mermas'),
    tipo_merma_id: 1,
    insumo_id: null,
    platillo_id: detalle.platillo_id,
    cantidad: detalle.cantidad,
    costo_estimado: costo,
    clasificacion: 'evitable',
    causa_raiz: 'Devolución de cliente',
    motivo: `Devolución #${devolucion.id}: ${devolucion.motivo}`,
    fecha: store.today(),
    estado: 'pendiente',
    usuario_registro_id: usuario.id,
    usuario_aprueba_id: null,
    fecha_resolucion: null,
    observacion_resolucion: null,
    origen: 'devolucion',
    creado_en: store.nowIso(),
  };
  store.state.mermas.push(merma);
  return merma;
}

async function registrarReembolsoSupabase(devolucion, payload, usuario) {
  const metodo = requiredEnum(payload.metodo, 'metodo', METODOS_REEMBOLSO);
  const monto = requiredNumber(payload.monto, 'monto', { min: 0.01 });
  const observacion = optionalString(
    payload.observacion !== undefined ? payload.observacion : payload.referencia,
    'observacion',
    { max: 200 },
  );
  const fecha = db.nowIso();

  // Tope: nunca reembolsar más que el total del pedido ni más de lo ya
  // reembolsado. El total vive en `pedidos`; lo acumulado, en la devolución.
  const pedido = await repository.getById('pedidos', devolucion.pedido_id);
  const totalPedido = aNumero(pedido ? pedido.total : 0);
  let yaReembolsado = aNumero(devolucion.monto_reembolsado);

  if (yaReembolsado + monto > totalPedido + 0.009) {
    throw new AppError(
      400,
      'REEMBOLSO_EXCESIVO',
      'El monto excede el total del pedido o lo ya reembolsado.',
      [{ total_pedido: totalPedido, ya_reembolsado: yaReembolsado, monto }],
    );
  }

  let pago;
  try {
    // El reembolso impacta la caja como pago del pedido (comportamiento
    // histórico); el histórico propio vive en devolucion_reembolsos.
    pago = await repository.insert('pagos', {
      pedido_id: devolucion.pedido_id,
      cuenta_id: null,
      metodo,
      monto: db.round2(monto),
      es_contraentrega: false,
      usuario_id: usuario.id,
    });
  } catch (error) {
    throw db.persistenceError('No se pudo registrar el reembolso.', error);
  }

  let reembolso;
  try {
    reembolso = await repository.insert('devolucion_reembolsos', {
      devolucion_id: devolucion.id,
      metodo,
      monto: db.round2(monto),
      observacion,
      usuario_id: usuario.id,
      fecha,
    });
  } catch (error) {
    try {
      await repository.remove('pagos', pago.id);
    } catch (compensacionError) {
      error.compensacion = compensacionError.message;
    }
    throw db.persistenceError('No se pudo registrar el reembolso de la devolución.', error);
  }

  // Acumulador sin lost-update: UPDATE condicional por el valor leído y un
  // reintento si otra terminal lo cambió en el medio.
  let actualizada = null;
  for (let intento = 0; intento < 2 && actualizada === null; intento += 1) {
    if (intento > 0) {
      const fresca = await repository.getById('devoluciones', devolucion.id);
      yaReembolsado = aNumero(fresca ? fresca.monto_reembolsado : yaReembolsado);
      if (yaReembolsado + monto > totalPedido + 0.009) {
        break;
      }
    }
    const filas = await repository.updateWhere(
      'devoluciones',
      { id: devolucion.id, monto_reembolsado: yaReembolsado },
      { monto_reembolsado: db.round2(yaReembolsado + monto), pago_id: pago.id },
    );
    if (filas && filas.length > 0) {
      actualizada = filas[0];
    }
  }

  if (actualizada === null) {
    try {
      await repository.remove('devolucion_reembolsos', reembolso.id);
      await repository.remove('pagos', pago.id);
    } catch (compensacionError) {
      // El error original manda; la compensación queda anotada.
      reembolso.compensacion = compensacionError.message;
    }
    throw new AppError(
      409,
      'CONFLICT',
      'Otro usuario registró un reembolso a la vez. Reintente con el saldo actualizado.',
    );
  }

  const [dto] = await enriquecerDevolucionesSupabase([actualizada]);
  return {
    reembolso: reembolsoDTO(reembolso),
    devolucion: dto,
  };
}

async function registrarReembolso(id, body, usuario) {
  const devolucion = await db.findOrThrow('devoluciones', parseId(id), 'Devolución');
  const payload = requiredObject(body);

  if (devolucion.estado !== 'aceptada') {
    throw new AppError(409, 'CONFLICT', 'Solo se reembolsa una devolución aceptada.');
  }
  if (!['reembolso_total', 'reembolso_parcial'].includes(devolucion.resolucion)) {
    throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'La resolución no contempla reembolso.');
  }

  if (db.isSupabase()) {
    return registrarReembolsoSupabase(devolucion, payload, usuario);
  }

  const metodo = requiredEnum(payload.metodo, 'metodo', METODOS_REEMBOLSO);
  const monto = requiredNumber(payload.monto, 'monto', { min: 0.01 });
  const observacion = optionalString(
    payload.observacion !== undefined ? payload.observacion : payload.referencia,
    'observacion',
    { max: 200 },
  );

  // Mismo tope que la rama Supabase: no exceder el total del pedido ni lo ya
  // reembolsado (el reembolso es dinero real).
  const pedido = store.find('pedidos', devolucion.pedido_id);
  const totalPedido = pedido ? Number(pedido.total) : 0;
  const yaReembolsado = aNumero(devolucion.monto_reembolsado);
  if (yaReembolsado + monto > totalPedido + 0.009) {
    throw new AppError(
      400,
      'REEMBOLSO_EXCESIVO',
      'El monto excede el total del pedido o lo ya reembolsado.',
      [{ total_pedido: totalPedido, ya_reembolsado: yaReembolsado, monto }],
    );
  }

  const reembolso = {
    id: store.nextId('devolucion_reembolsos'),
    devolucion_id: devolucion.id,
    metodo,
    monto: store.round2(monto),
    observacion,
    usuario_id: usuario.id,
    fecha: store.nowIso(),
  };
  store.state.devolucion_reembolsos.push(reembolso);
  devolucion.monto_reembolsado = store.round2(
    aNumero(devolucion.monto_reembolsado) + reembolso.monto,
  );

  return {
    reembolso: reembolsoDTO(reembolso),
    devolucion: enriquecerDevolucion(devolucion),
  };
}

module.exports = {
  RESOLUCIONES,
  listDevoluciones,
  getDevolucion,
  crearDevolucion,
  resolverDevolucion,
  registrarReembolso,
};
