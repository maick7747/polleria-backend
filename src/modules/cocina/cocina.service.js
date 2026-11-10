'use strict';

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredEnum,
  optionalDate,
  pageParams,
  paginate,
  parseId,
} = require('../../middleware/validate');
const pedidosLib = require('../../lib/pedidos');
const pedidosDb = require('../../lib/pedidos-db');

const ESTADOS_PLATO = ['pendiente', 'en_preparacion', 'listo'];
const ESTADOS_ACTIVOS = ['en_cocina', 'servido'];

function minutosDesde(fechaIso) {
  if (!fechaIso) {
    return 0;
  }
  const millis = Date.now() - Date.parse(fechaIso);
  return Math.max(0, Math.round(millis / 60000));
}

function fechaLima(iso) {
  if (!iso) {
    return null;
  }
  return new Date(Date.parse(iso) - 5 * 3600000).toISOString().slice(0, 10);
}

async function slaKds() {
  return Number(await db.getConfig('kds_sla_min')) || 30;
}

function kdsPedido(pedido, detalles, sla, mesaNumero) {
  const referencia = pedido.fecha_inicio_prep || pedido.fecha_pedido;
  const tiempo = minutosDesde(referencia);
  const listo = detalles.length > 0
    && detalles.every((detalle) => detalle.estado_preparacion === 'listo');
  const todosEntregados = detalles.length > 0
    && detalles.every((detalle) => Boolean(detalle.entregado_en));
  return {
    id: pedido.id,
    numero: pedido.numero,
    canal: pedido.canal,
    tipo_consumo: pedido.tipo_consumo,
    mesa_id: pedido.mesa_id ?? null,
    mesa_numero: mesaNumero || null,
    cuenta_id: pedido.cuenta_id ?? null,
    estado: pedido.estado,
    estado_pago: pedido.estado_pago,
    metodo_pago: pedido.metodo_pago ?? null,
    estado_entrega: pedido.estado_entrega || null,
    entregado_en: pedido.fecha_entrega || null,
    prioridad: pedido.estado_entrega === 'en_camino' ? 'entrega' : 'cocina',
    subtotal: Number(pedido.subtotal),
    igv: Number(pedido.igv),
    total: Number(pedido.total),
    fecha_pedido: pedido.fecha_pedido,
    fecha_inicio_prep: pedido.fecha_inicio_prep,
    fecha_listo: pedido.fecha_listo,
    tiempo_min: tiempo,
    sla_min: sla,
    prioritario: tiempo > sla,
    listo,
    todos_entregados: todosEntregados,
    observaciones: pedido.observaciones,
    detalles,
  };
}

// All-day: totales por plato y estación de TODAS las rondas activas. Se
// excluyen las líneas ya entregadas y los pedidos pagados o con entrega
// cerrada. `en_fuego` suma unidades en preparación (misma unidad que
// `cantidad`).
function calcularAllDay(pedidos, detallesPorPedido) {
  const acumulado = new Map();
  let total = 0;

  for (const pedido of pedidos) {
    if (!ESTADOS_ACTIVOS.includes(pedido.estado)) {
      continue;
    }
    if (pedido.estado_pago === 'pagado' || pedido.fecha_entrega) {
      continue;
    }
    const detalles = typeof detallesPorPedido === 'function'
      ? detallesPorPedido(pedido)
      : (detallesPorPedido.get(pedido.id) || []);
    for (const detalle of detalles) {
      if (detalle.entregado_en) {
        continue;
      }
      const clave = `${detalle.platillo_id}|${detalle.estacion || 'parrilla'}`;
      const fila = acumulado.get(clave) || {
        platillo_id: detalle.platillo_id,
        platillo_nombre: detalle.platillo_nombre || null,
        estacion: detalle.estacion || 'parrilla',
        cantidad: 0,
        en_fuego: 0,
      };
      fila.cantidad += Number(detalle.cantidad) || 0;
      if (detalle.estado_preparacion === 'en_preparacion') {
        fila.en_fuego += Number(detalle.cantidad) || 0;
      }
      acumulado.set(clave, fila);
      total += Number(detalle.cantidad) || 0;
    }
  }

  const allDay = [...acumulado.values()].sort(
    (a, b) => a.estacion.localeCompare(b.estacion)
      || b.cantidad - a.cantidad
      || String(a.platillo_nombre || '').localeCompare(String(b.platillo_nombre || '')),
  );

  return { all_day: allDay, all_day_total: total };
}

function validarEntregable(pedido) {
  if (pedido.estado === 'cancelado') {
    throw new AppError(409, 'CONFLICT', 'El pedido está cancelado.');
  }
  if (pedido.estado_pago === 'pagado') {
    throw new AppError(409, 'CONFLICT', 'El pedido ya fue cobrado.');
  }
}

function estacionDeDetalle(detalle, platillo) {
  return detalle.estacion || (platillo && platillo.estacion) || 'parrilla';
}

async function detallesDeVarios(pedidoIds) {
  const map = new Map();
  if (pedidoIds.length === 0) {
    return map;
  }
  const { data } = await repository.list('pedido_detalles', {
    filters: { pedido_id: pedidoIds },
    orderBy: 'id',
    ascending: true,
    limit: 1000,
  });
  if (data.length === 0) {
    return map;
  }

  const platilloIds = [...new Set(data.map((item) => item.platillo_id))];
  const { data: platillos } = await repository.list('platillos', {
    filters: { id: platilloIds },
    limit: platilloIds.length,
  });
  const platillosPorId = new Map(platillos.map((platillo) => [platillo.id, platillo]));

  for (const detail of data) {
    const platillo = platillosPorId.get(detail.platillo_id);
    // Se prefiere el snapshot de la línea y se cae al platillo cuando la fila
    // es antigua (antes de la migración 013).
    const item = {
      ...detail,
      precio_unitario: Number(detail.precio_unitario),
      subtotal: Number(detail.subtotal),
      platillo_nombre: platillo ? platillo.nombre : null,
      estacion: detail.estacion || (platillo && platillo.estacion) || 'parrilla',
      curso: detail.curso || (platillo && platillo.curso) || 'fondo',
      prep_min: platillo && platillo.tiempo_prep_min !== undefined
        ? platillo.tiempo_prep_min
        : null,
      entregado_en: detail.entregado_en ?? null,
    };
    if (!map.has(detail.pedido_id)) {
      map.set(detail.pedido_id, []);
    }
    map.get(detail.pedido_id).push(item);
  }
  return map;
}

async function mesasPorId(pedidos) {
  const ids = [...new Set(pedidos.filter((pedido) => pedido.mesa_id).map((pedido) => pedido.mesa_id))];
  if (ids.length === 0) {
    return new Map();
  }
  const { data } = await repository.list('mesas', { filters: { id: ids }, limit: 100 });
  return new Map(data.map((mesa) => [mesa.id, mesa.numero]));
}

async function listKds(query = {}) {
  const estado = query.estado ? requiredEnum(query.estado, 'estado', ESTADOS_PLATO) : null;

  if (!db.isSupabase()) {
    const sla = Number(store.getConfig('kds_sla_min')) || 30;
    const activos = store.state.pedidos
      .filter((pedido) => ESTADOS_ACTIVOS.includes(pedido.estado))
      .sort((a, b) => a.fecha_pedido.localeCompare(b.fecha_pedido));

    const detallesMemoria = new Map();
    const completos = activos.map((pedido) => {
      const detalles = pedidosLib.detallesDePedido(pedido.id);
      detallesMemoria.set(pedido.id, detalles);
      const mesa = pedido.mesa_id ? store.find('mesas', pedido.mesa_id) : null;
      return kdsPedido(pedido, detalles, sla, mesa ? mesa.numero : null);
    });

    const data = completos.filter((pedido) => !estado
      || pedido.detalles.some((detalle) => detalle.estado_preparacion === estado));
    const { all_day, all_day_total } = calcularAllDay(activos, detallesMemoria);

    return {
      data,
      meta: {
        total: data.length,
        prioritarios: data.filter((pedido) => pedido.prioritario).length,
        sla_min: sla,
        generado_en: store.nowIso(),
        all_day,
        all_day_total,
      },
    };
  }

  // Todos los pedidos activos se traen en una sola consulta (1 000) para que
  // el all-day sea global y no dependa de una página. Las líneas y las mesas
  // se resuelven por lote (sin N+1).
  const [{ data: pedidos }, sla] = await Promise.all([
    repository.list('pedidos', {
      filters: { estado: ESTADOS_ACTIVOS },
      orderBy: 'fecha_pedido',
      ascending: true,
      limit: 1000,
    }),
    slaKds(),
  ]);

  const [detallesMap, mesasMap] = await Promise.all([
    detallesDeVarios(pedidos.map((pedido) => pedido.id)),
    mesasPorId(pedidos),
  ]);

  const completos = pedidos.map((pedido) => kdsPedido(
    pedido,
    detallesMap.get(pedido.id) || [],
    sla,
    mesasMap.get(pedido.mesa_id),
  ));

  const data = completos.filter((pedido) => !estado
    || pedido.detalles.some((detalle) => detalle.estado_preparacion === estado));
  const { all_day, all_day_total } = calcularAllDay(pedidos, detallesMap);

  return {
    data,
    meta: {
      total: data.length,
      prioritarios: data.filter((pedido) => pedido.prioritario).length,
      sla_min: sla,
      generado_en: db.nowIso(),
      all_day,
      all_day_total,
    },
  };
}

async function actualizarEstadoPlato(pedidoId, detalleId, body) {
  const payload = requiredObject(body);
  const estado = requiredEnum(payload.estado, 'estado', ['en_preparacion', 'listo']);

  if (!db.isSupabase()) {
    const pedido = store.findOrThrow('pedidos', parseId(pedidoId), 'Pedido');
    const detalle = store.findOrThrow('pedido_detalles', parseId(detalleId), 'Línea de pedido');

    if (detalle.pedido_id !== pedido.id) {
      throw new AppError(404, 'NOT_FOUND', 'La línea no pertenece al pedido indicado.');
    }
    if (!ESTADOS_ACTIVOS.includes(pedido.estado)) {
      throw new AppError(409, 'CONFLICT', 'El pedido no está en cocina.');
    }

    const ahora = store.nowIso();
    const platilloLinea = store.find('platillos', detalle.platillo_id);
    // Las bebidas nacen listas y no se pueden devolver a preparación.
    const estadoFinal = estacionDeDetalle(detalle, platilloLinea) === 'bar'
      ? 'listo'
      : estado;

    detalle.estado_preparacion = estadoFinal;
    if (estadoFinal === 'en_preparacion') {
      detalle.fecha_inicio_prep = detalle.fecha_inicio_prep || ahora;
      detalle.fecha_listo = null;
      if (!pedido.fecha_inicio_prep) {
        pedido.fecha_inicio_prep = ahora;
      }
    } else {
      detalle.fecha_listo = detalle.fecha_listo || ahora;
    }

    const lineas = store.state.pedido_detalles.filter((item) => item.pedido_id === pedido.id);
    const todasListas = lineas.every((item) => item.estado_preparacion === 'listo');

    if (todasListas) {
      pedido.estado = 'servido';
      pedido.fecha_listo = ahora;
    } else if (pedido.estado === 'servido') {
      pedido.estado = 'en_cocina';
      pedido.fecha_listo = null;
    }

    return {
      pedido_id: pedido.id,
      pedido_numero: pedido.numero,
      pedido_estado: pedido.estado,
      todas_listas: todasListas,
      linea: {
        ...detalle,
        platillo_nombre: (platilloLinea && platilloLinea.nombre) || null,
        estacion: estacionDeDetalle(detalle, platilloLinea),
        curso: detalle.curso || (platilloLinea && platilloLinea.curso) || 'fondo',
        prep_min: platilloLinea && platilloLinea.tiempo_prep_min !== undefined
          ? platilloLinea.tiempo_prep_min
          : null,
        entregado_en: detalle.entregado_en ?? null,
      },
    };
  }

  const pedido = await db.findOrThrow('pedidos', parseId(pedidoId), 'Pedido');
  const detalle = await db.findOrThrow('pedido_detalles', parseId(detalleId), 'Línea de pedido');

  if (detalle.pedido_id !== pedido.id) {
    throw new AppError(404, 'NOT_FOUND', 'La línea no pertenece al pedido indicado.');
  }
  if (!ESTADOS_ACTIVOS.includes(pedido.estado)) {
    throw new AppError(409, 'CONFLICT', 'El pedido no está en cocina.');
  }

  const ahora = db.nowIso();
  const platilloLinea = await repository.getById('platillos', detalle.platillo_id);
  const estadoFinal = estacionDeDetalle(detalle, platilloLinea) === 'bar'
    ? 'listo'
    : estado;

  const patchDetalle = { estado_preparacion: estadoFinal };
  if (estadoFinal === 'en_preparacion') {
    patchDetalle.fecha_inicio_prep = detalle.fecha_inicio_prep || ahora;
    patchDetalle.fecha_listo = null;
  } else {
    patchDetalle.fecha_listo = detalle.fecha_listo || ahora;
  }

  await repository.update('pedido_detalles', detalle.id, patchDetalle);

  if (estadoFinal === 'en_preparacion' && !pedido.fecha_inicio_prep) {
    await repository.update('pedidos', pedido.id, { fecha_inicio_prep: ahora });
  }

  const { data: lineas } = await repository.list('pedido_detalles', {
    filters: { pedido_id: pedido.id },
    orderBy: 'id',
    ascending: true,
    limit: 100,
  });
  const todasListas = lineas.every((item) => item.estado_preparacion === 'listo');

  let nuevoEstado = pedido.estado;
  let fechaListo = pedido.fecha_listo;
  if (todasListas) {
    nuevoEstado = 'servido';
    fechaListo = ahora;
  } else if (pedido.estado === 'servido') {
    nuevoEstado = 'en_cocina';
    fechaListo = null;
  }

  if (nuevoEstado !== pedido.estado || fechaListo !== pedido.fecha_listo) {
    await repository.update('pedidos', pedido.id, {
      estado: nuevoEstado,
      fecha_listo: fechaListo,
    });
  }

  return {
    pedido_id: pedido.id,
    pedido_numero: pedido.numero,
    pedido_estado: nuevoEstado,
    todas_listas: todasListas,
    linea: {
      ...detalle,
      ...patchDetalle,
      platillo_nombre: platilloLinea ? platilloLinea.nombre : null,
      estacion: estacionDeDetalle(detalle, platilloLinea),
      curso: detalle.curso || (platilloLinea && platilloLinea.curso) || 'fondo',
      prep_min: platilloLinea && platilloLinea.tiempo_prep_min !== undefined
        ? platilloLinea.tiempo_prep_min
        : null,
      entregado_en: detalle.entregado_en ?? null,
    },
  };
}

async function ingredientesPedido(pedidoId) {
  if (!db.isSupabase()) {
    const pedido = store.findOrThrow('pedidos', parseId(pedidoId), 'Pedido');
    const detalles = pedidosLib.detallesDePedido(pedido.id);

    return {
      pedido_id: pedido.id,
      numero: pedido.numero,
      observaciones: pedido.observaciones,
      platos: detalles.map((detail) => {
        const ficha = pedidosLib.fichaDePlatillo(detail.platillo_id);
        const ingredientes = ficha
          ? store.state.fichas_tecnicas_detalle
              .filter((item) => item.ficha_id === ficha.id)
              .map((item) => {
                const insumo = store.find('insumos', item.insumo_id);
                return {
                  insumo_id: item.insumo_id,
                  insumo: insumo ? insumo.nombre : null,
                  cantidad: item.cantidad,
                  unidad_medida: insumo ? insumo.unidad_medida : null,
                };
              })
          : [];
        return {
          detalle_id: detail.id,
          platillo_id: detail.platillo_id,
          platillo: detail.platillo_nombre,
          cantidad: detail.cantidad,
          notas: detail.notas,
          estado_preparacion: detail.estado_preparacion,
          ingredientes,
        };
      }),
    };
  }

  const pedido = await db.findOrThrow('pedidos', parseId(pedidoId), 'Pedido');
  const detalles = await pedidosDb.detallesDePedido(pedido.id);
  const platilloIds = [...new Set(detalles.map((detail) => detail.platillo_id))];

  const fichas = platilloIds.length
    ? (await repository.list('fichas_tecnicas', {
        filters: { platillo_id: platilloIds, activa: true },
        limit: 100,
      })).data
    : [];
  const fichaPorPlatillo = new Map(fichas.map((ficha) => [ficha.platillo_id, ficha]));
  const fichaIds = fichas.map((ficha) => ficha.id);

  const ingredientesFicha = fichaIds.length
    ? (await repository.list('fichas_tecnicas_detalle', {
        filters: { ficha_id: fichaIds },
        limit: 100,
      })).data
    : [];
  const insumoIds = [...new Set(ingredientesFicha.map((item) => item.insumo_id))];
  const insumos = insumoIds.length
    ? (await repository.list('insumos', { filters: { id: insumoIds }, limit: 100 })).data
    : [];
  const insumoPorId = new Map(insumos.map((insumo) => [insumo.id, insumo]));

  return {
    pedido_id: pedido.id,
    numero: pedido.numero,
    observaciones: pedido.observaciones,
    platos: detalles.map((detail) => {
      const ficha = fichaPorPlatillo.get(detail.platillo_id);
      const ingredientes = ficha
        ? ingredientesFicha
            .filter((item) => item.ficha_id === ficha.id)
            .map((item) => {
              const insumo = insumoPorId.get(item.insumo_id);
              return {
                insumo_id: item.insumo_id,
                insumo: insumo ? insumo.nombre : null,
                cantidad: Number(item.cantidad),
                unidad_medida: insumo ? insumo.unidad_medida : null,
              };
            })
        : [];
      return {
        detalle_id: detail.id,
        platillo_id: detail.platillo_id,
        platillo: detail.platillo_nombre,
        cantidad: detail.cantidad,
        notas: detail.notas,
        estado_preparacion: detail.estado_preparacion,
        ingredientes,
      };
    }),
  };
}

async function metricas(query = {}) {
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');

  if (!db.isSupabase()) {
    const lineas = store.state.pedido_detalles.filter((detail) => {
      if (!detail.fecha_inicio_prep || !detail.fecha_listo) {
        return false;
      }
      const fecha = detail.fecha_listo.slice(0, 10);
      return (!desde || fecha >= desde) && (!hasta || fecha <= hasta);
    });

    const tiempos = lineas.map(
      (detail) => (Date.parse(detail.fecha_listo) - Date.parse(detail.fecha_inicio_prep)) / 60000,
    );
    const promedio = tiempos.length
      ? store.round2(tiempos.reduce((sum, value) => sum + value, 0) / tiempos.length)
      : 0;
    const sla = Number(store.getConfig('kds_sla_min')) || 30;

    return {
      desde: desde || null,
      hasta: hasta || null,
      platos_listos: lineas.length,
      tiempo_promedio_min: promedio,
      platos_prioritarios: tiempos.filter((value) => value > sla).length,
      sla_min: sla,
    };
  }

  const { data } = await repository.list('pedido_detalles', {
    orderBy: 'id',
    ascending: true,
    limit: 100,
  });
  const lineas = data
    .filter((detail) => detail.fecha_inicio_prep && detail.fecha_listo)
    .filter((detail) => {
      const fecha = fechaLima(detail.fecha_listo);
      return (!desde || fecha >= desde) && (!hasta || fecha <= hasta);
    });

  const tiempos = lineas.map(
    (detail) => (Date.parse(detail.fecha_listo) - Date.parse(detail.fecha_inicio_prep)) / 60000,
  );
  const promedio = tiempos.length
    ? store.round2(tiempos.reduce((sum, value) => sum + value, 0) / tiempos.length)
    : 0;
  const sla = await slaKds();

  return {
    desde: desde || null,
    hasta: hasta || null,
    platos_listos: lineas.length,
    tiempo_promedio_min: promedio,
    platos_prioritarios: tiempos.filter((value) => value > sla).length,
    sla_min: sla,
  };
}

async function pedidosListos(query = {}) {
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');

  if (!db.isSupabase()) {
    const data = store.state.pedidos
      .filter((pedido) => pedido.estado === 'servido' && pedido.estado_pago !== 'pagado')
      .filter((pedido) => !pedido.fecha_entrega && pedido.estado_entrega !== 'entregado')
      .filter((pedido) => !desde || fechaLima(pedido.fecha_listo) >= desde)
      .filter((pedido) => !hasta || fechaLima(pedido.fecha_listo) <= hasta)
      .sort((a, b) => (b.fecha_listo || b.fecha_pedido).localeCompare(a.fecha_listo || a.fecha_pedido))
      .map((pedido) => {
        const detalle = pedidosLib.pedidoConDetalles(pedido);
        const mesa = pedido.mesa_id ? store.find('mesas', pedido.mesa_id) : null;
        return {
          id: pedido.id,
          numero: pedido.numero,
          canal: pedido.canal,
          tipo_consumo: pedido.tipo_consumo,
          mesa_numero: mesa ? mesa.numero : null,
          cuenta_id: pedido.cuenta_id,
          estado_entrega: pedido.estado_entrega || null,
          entregado_en: pedido.fecha_entrega || null,
          todos_entregados: detalle.detalles.length > 0
            && detalle.detalles.every((item) => Boolean(item.entregado_en)),
          fecha_listo: pedido.fecha_listo,
          minutos_esperando: minutosDesde(pedido.fecha_listo),
          detalles: detalle.detalles,
        };
      });

    const resultado = paginate(data, query);
    return {
      ...resultado,
      meta: { ...resultado.meta, generado_en: store.nowIso() },
    };
  }

  const filters = {
    estado: 'servido',
    estado_pago: { op: 'neq', value: 'pagado' },
    // Un pedido totalmente entregado deja la bandeja para todos.
    fecha_entrega: null,
  };
  if (desde || hasta) {
    filters.fecha_listo = {
      op: 'between',
      value: [
        `${desde || '1970-01-01'}T00:00:00-05:00`,
        `${hasta || '2999-12-31'}T23:59:59.999-05:00`,
      ],
    };
  }

  const { page, limit } = pageParams(query);
  const { data: pedidos, meta } = await repository.list('pedidos', {
    filters,
    orderBy: 'fecha_listo',
    ascending: false,
    page,
    limit,
  });

  const [detallesMap, mesasMap] = await Promise.all([
    detallesDeVarios(pedidos.map((pedido) => pedido.id)),
    mesasPorId(pedidos),
  ]);

  const data = pedidos
    .filter((pedido) => pedido.estado_entrega !== 'entregado')
    .map((pedido) => {
      const detalles = detallesMap.get(pedido.id) || [];
      return {
        id: pedido.id,
        numero: pedido.numero,
        canal: pedido.canal,
        tipo_consumo: pedido.tipo_consumo,
        mesa_numero: mesasMap.get(pedido.mesa_id) || null,
        cuenta_id: pedido.cuenta_id,
        estado_entrega: pedido.estado_entrega || null,
        entregado_en: pedido.fecha_entrega || null,
        todos_entregados: detalles.length > 0
          && detalles.every((item) => Boolean(item.entregado_en)),
        fecha_listo: pedido.fecha_listo,
        minutos_esperando: minutosDesde(pedido.fecha_listo),
        detalles,
      };
    });

  return { data, meta: { ...meta, generado_en: db.nowIso() } };
}

// ---------------------------------------------------------------------
// KDS v2 — entrega por línea, entrega de ronda y atajo "todo listo".
// ---------------------------------------------------------------------

async function entregarPlato(pedidoId, detalleId, usuario) {
  if (!db.isSupabase()) {
    const pedido = store.findOrThrow('pedidos', parseId(pedidoId), 'Pedido');
    const detalle = store.findOrThrow('pedido_detalles', parseId(detalleId), 'Línea de pedido');

    if (detalle.pedido_id !== pedido.id) {
      throw new AppError(404, 'NOT_FOUND', 'La línea no pertenece al pedido indicado.');
    }
    validarEntregable(pedido);

    if (detalle.estado_preparacion !== 'listo' && !detalle.entregado_en) {
      throw new AppError(409, 'PLATO_NO_LISTO', 'El plato todavía no está listo para entregarse.');
    }

    const ahora = store.nowIso();
    if (!detalle.entregado_en) {
      detalle.entregado_en = ahora;
      detalle.entregado_por_id = usuario.id;
    }

    const lineas = store.state.pedido_detalles.filter((item) => item.pedido_id === pedido.id);
    const todosEntregados = lineas.every((item) => Boolean(item.entregado_en));

    if (todosEntregados) {
      pedido.estado_entrega = 'entregado';
      pedido.fecha_entrega = pedido.fecha_entrega || ahora;
    } else if (!pedido.estado_entrega) {
      pedido.estado_entrega = 'pendiente';
    }

    return {
      pedido_id: pedido.id,
      pedido_estado_entrega: pedido.estado_entrega,
      todos_entregados: todosEntregados,
      detalle: {
        id: detalle.id,
        entregado_en: detalle.entregado_en,
        entregado_por_id: detalle.entregado_por_id,
      },
    };
  }

  const pedido = await db.findOrThrow('pedidos', parseId(pedidoId), 'Pedido');
  const detalle = await db.findOrThrow('pedido_detalles', parseId(detalleId), 'Línea de pedido');

  if (detalle.pedido_id !== pedido.id) {
    throw new AppError(404, 'NOT_FOUND', 'La línea no pertenece al pedido indicado.');
  }
  validarEntregable(pedido);

  if (detalle.estado_preparacion !== 'listo' && !detalle.entregado_en) {
    throw new AppError(409, 'PLATO_NO_LISTO', 'El plato todavía no está listo para entregarse.');
  }

  const ahora = db.nowIso();
  let entregadoEn = detalle.entregado_en;
  let entregadoPorId = detalle.entregado_por_id;
  if (!entregadoEn) {
    const actualizado = await repository.update('pedido_detalles', detalle.id, {
      entregado_en: ahora,
      entregado_por_id: usuario.id,
    });
    entregadoEn = actualizado ? actualizado.entregado_en : ahora;
    entregadoPorId = usuario.id;
  }

  const { data: lineas } = await repository.list('pedido_detalles', {
    filters: { pedido_id: pedido.id },
    orderBy: 'id',
    ascending: true,
    limit: 1000,
  });
  const todosEntregados = lineas.length > 0
    && lineas.every((item) => Boolean(item.entregado_en));

  let estadoEntrega = pedido.estado_entrega;
  if (todosEntregados) {
    estadoEntrega = 'entregado';
  } else if (!estadoEntrega) {
    estadoEntrega = 'pendiente';
  }
  const fechaEntrega = todosEntregados
    ? (pedido.fecha_entrega || ahora)
    : pedido.fecha_entrega;

  if (estadoEntrega !== pedido.estado_entrega || fechaEntrega !== pedido.fecha_entrega) {
    await repository.update('pedidos', pedido.id, {
      estado_entrega: estadoEntrega,
      fecha_entrega: fechaEntrega,
    });
  }

  return {
    pedido_id: pedido.id,
    pedido_estado_entrega: estadoEntrega,
    todos_entregados: todosEntregados,
    detalle: {
      id: detalle.id,
      entregado_en: entregadoEn,
      entregado_por_id: entregadoPorId,
    },
  };
}

async function entregarRonda(pedidoId, usuario) {
  if (!db.isSupabase()) {
    const pedido = store.findOrThrow('pedidos', parseId(pedidoId), 'Pedido');
    validarEntregable(pedido);

    const lineas = store.state.pedido_detalles.filter((item) => item.pedido_id === pedido.id);
    const pendientes = lineas.filter(
      (item) => !item.entregado_en && item.estado_preparacion !== 'listo',
    ).length;
    if (pendientes > 0) {
      throw new AppError(
        409,
        'PLATOS_PENDIENTES',
        'Hay platos que todavía no están listos para entregar.',
        [{ pendientes }],
      );
    }

    const ahora = store.nowIso();
    for (const linea of lineas) {
      if (!linea.entregado_en) {
        linea.entregado_en = ahora;
        linea.entregado_por_id = usuario.id;
      }
    }
    pedido.estado_entrega = 'entregado';
    pedido.fecha_entrega = pedido.fecha_entrega || ahora;

    return {
      pedido_id: pedido.id,
      estado_entrega: 'entregado',
      entregado_en: pedido.fecha_entrega,
    };
  }

  const pedido = await db.findOrThrow('pedidos', parseId(pedidoId), 'Pedido');
  validarEntregable(pedido);

  const { data: lineas } = await repository.list('pedido_detalles', {
    filters: { pedido_id: pedido.id },
    orderBy: 'id',
    ascending: true,
    limit: 1000,
  });
  const pendientes = lineas.filter(
    (item) => !item.entregado_en && item.estado_preparacion !== 'listo',
  ).length;
  if (pendientes > 0) {
    throw new AppError(
      409,
      'PLATOS_PENDIENTES',
      'Hay platos que todavía no están listos para entregar.',
      [{ pendientes }],
    );
  }

  const ahora = db.nowIso();
  await repository.updateWhere(
    'pedido_detalles',
    { pedido_id: pedido.id, entregado_en: null },
    { entregado_en: ahora, entregado_por_id: usuario.id },
  );

  const fechaEntrega = pedido.fecha_entrega || ahora;
  await repository.update('pedidos', pedido.id, {
    estado_entrega: 'entregado',
    fecha_entrega: fechaEntrega,
  });

  return {
    pedido_id: pedido.id,
    estado_entrega: 'entregado',
    entregado_en: fechaEntrega,
  };
}

async function marcarTodoListo(pedidoId) {
  if (!db.isSupabase()) {
    const pedido = store.findOrThrow('pedidos', parseId(pedidoId), 'Pedido');
    validarEntregable(pedido);

    const ahora = store.nowIso();
    const lineas = store.state.pedido_detalles.filter((item) => item.pedido_id === pedido.id);
    for (const linea of lineas) {
      if (linea.entregado_en) {
        continue;
      }
      if (linea.estado_preparacion === 'pendiente' || linea.estado_preparacion === 'en_preparacion') {
        linea.estado_preparacion = 'listo';
        linea.fecha_listo = ahora;
        if (!linea.fecha_inicio_prep) {
          linea.fecha_inicio_prep = ahora;
        }
      }
    }

    const todasListas = lineas.length > 0
      && lineas.every((item) => item.estado_preparacion === 'listo');
    if (todasListas) {
      pedido.estado = 'servido';
      pedido.fecha_listo = ahora;
    }

    return {
      pedido_id: pedido.id,
      estado: pedido.estado,
      fecha_listo: pedido.fecha_listo,
      todas_listas: todasListas,
    };
  }

  const pedido = await db.findOrThrow('pedidos', parseId(pedidoId), 'Pedido');
  validarEntregable(pedido);

  const ahora = db.nowIso();
  await repository.updateWhere(
    'pedido_detalles',
    {
      pedido_id: pedido.id,
      entregado_en: null,
      estado_preparacion: ['pendiente', 'en_preparacion'],
    },
    { estado_preparacion: 'listo', fecha_listo: ahora },
  );

  const { data: lineas } = await repository.list('pedido_detalles', {
    filters: { pedido_id: pedido.id },
    orderBy: 'id',
    ascending: true,
    limit: 1000,
  });
  const todasListas = lineas.length > 0
    && lineas.every((item) => item.estado_preparacion === 'listo');
  const fechaListo = todasListas ? ahora : pedido.fecha_listo;

  if (todasListas) {
    await repository.update('pedidos', pedido.id, {
      estado: 'servido',
      fecha_listo: fechaListo,
    });
  }

  return {
    pedido_id: pedido.id,
    estado: todasListas ? 'servido' : pedido.estado,
    fecha_listo: fechaListo,
    todas_listas: todasListas,
  };
}

module.exports = {
  ESTADOS_PLATO,
  listKds,
  actualizarEstadoPlato,
  entregarPlato,
  entregarRonda,
  marcarTodoListo,
  ingredientesPedido,
  metricas,
  pedidosListos,
  kdsPedido,
};
