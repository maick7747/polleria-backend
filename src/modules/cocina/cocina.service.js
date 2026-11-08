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
    observaciones: pedido.observaciones,
    detalles,
  };
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
    limit: 100,
  });
  if (data.length === 0) {
    return map;
  }

  const platilloIds = [...new Set(data.map((item) => item.platillo_id))];
  const { data: platillos } = await repository.list('platillos', {
    filters: { id: platilloIds },
    limit: 100,
  });
  const nombres = new Map(platillos.map((platillo) => [platillo.id, platillo.nombre]));

  for (const detail of data) {
    const item = {
      ...detail,
      precio_unitario: Number(detail.precio_unitario),
      subtotal: Number(detail.subtotal),
      platillo_nombre: nombres.get(detail.platillo_id) || null,
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
    const data = store.state.pedidos
      .filter((pedido) => ESTADOS_ACTIVOS.includes(pedido.estado))
      .filter((pedido) => {
        if (!estado) {
          return true;
        }
        return store.state.pedido_detalles.some(
          (detail) => detail.pedido_id === pedido.id && detail.estado_preparacion === estado,
        );
      })
      .sort((a, b) => a.fecha_pedido.localeCompare(b.fecha_pedido))
      .map((pedido) => {
        const mesa = pedido.mesa_id ? store.find('mesas', pedido.mesa_id) : null;
        return kdsPedido(
          pedido,
          pedidosLib.detallesDePedido(pedido.id),
          Number(store.getConfig('kds_sla_min')) || 30,
          mesa ? mesa.numero : null,
        );
      });

    return {
      data,
      meta: {
        total: data.length,
        prioritarios: data.filter((pedido) => pedido.prioritario).length,
        sla_min: Number(store.getConfig('kds_sla_min')) || 30,
        generado_en: store.nowIso(),
      },
    };
  }

  const [{ data: pedidos }, sla] = await Promise.all([
    repository.list('pedidos', {
      filters: { estado: ESTADOS_ACTIVOS },
      orderBy: 'fecha_pedido',
      ascending: true,
      limit: 100,
    }),
    slaKds(),
  ]);

  const [detallesMap, mesasMap] = await Promise.all([
    detallesDeVarios(pedidos.map((pedido) => pedido.id)),
    mesasPorId(pedidos),
  ]);

  const data = pedidos
    .filter((pedido) => {
      if (!estado) {
        return true;
      }
      return (detallesMap.get(pedido.id) || []).some(
        (detail) => detail.estado_preparacion === estado,
      );
    })
    .map((pedido) => kdsPedido(
      pedido,
      detallesMap.get(pedido.id) || [],
      sla,
      mesasMap.get(pedido.mesa_id),
    ));

  return {
    data,
    meta: {
      total: data.length,
      prioritarios: data.filter((pedido) => pedido.prioritario).length,
      sla_min: sla,
      generado_en: db.nowIso(),
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
    detalle.estado_preparacion = estado;
    if (estado === 'en_preparacion') {
      detalle.fecha_inicio_prep = detalle.fecha_inicio_prep || ahora;
      detalle.fecha_listo = null;
      if (!pedido.fecha_inicio_prep) {
        pedido.fecha_inicio_prep = ahora;
      }
    } else {
      detalle.fecha_listo = ahora;
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
        platillo_nombre: (store.find('platillos', detalle.platillo_id) || {}).nombre || null,
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
  const patchDetalle = { estado_preparacion: estado };
  if (estado === 'en_preparacion') {
    patchDetalle.fecha_inicio_prep = detalle.fecha_inicio_prep || ahora;
    patchDetalle.fecha_listo = null;
  } else {
    patchDetalle.fecha_listo = ahora;
  }

  await repository.update('pedido_detalles', detalle.id, patchDetalle);

  if (estado === 'en_preparacion' && !pedido.fecha_inicio_prep) {
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

  const platillo = await repository.getById('platillos', detalle.platillo_id);

  return {
    pedido_id: pedido.id,
    pedido_numero: pedido.numero,
    pedido_estado: nuevoEstado,
    todas_listas: todasListas,
    linea: {
      ...detalle,
      ...patchDetalle,
      platillo_nombre: platillo ? platillo.nombre : null,
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

  const data = pedidos.map((pedido) => ({
    id: pedido.id,
    numero: pedido.numero,
    canal: pedido.canal,
    tipo_consumo: pedido.tipo_consumo,
    mesa_numero: mesasMap.get(pedido.mesa_id) || null,
    cuenta_id: pedido.cuenta_id,
    fecha_listo: pedido.fecha_listo,
    minutos_esperando: minutosDesde(pedido.fecha_listo),
    detalles: detallesMap.get(pedido.id) || [],
  }));

  return { data, meta: { ...meta, generado_en: db.nowIso() } };
}

module.exports = {
  ESTADOS_PLATO,
  listKds,
  actualizarEstadoPlato,
  ingredientesPedido,
  metricas,
  pedidosListos,
  kdsPedido,
};
