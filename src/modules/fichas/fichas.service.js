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
  requiredArray,
  optionalString,
  paginate,
  parseId,
} = require('../../middleware/validate');

function fichaDePlatillo(platilloId, soloActiva = true) {
  return store.state.fichas_tecnicas.find(
    (ficha) => ficha.platillo_id === Number(platilloId) && (!soloActiva || ficha.activa),
  ) || null;
}

function fichaConDetalle(platilloId) {
  const platillo = store.findOrThrow('platillos', parseId(platilloId), 'Platillo');
  const categoria = store.find('categorias_platillo', platillo.categoria_id);
  const ficha = fichaDePlatillo(platillo.id);

  if (!ficha) {
    return {
      ...platillo,
      categoria: categoria ? categoria.nombre : null,
      ficha: null,
      ingredientes: [],
      costo_porcion: 0,
      food_cost_pct: 0,
    };
  }

  const ingredientes = store.state.fichas_tecnicas_detalle
    .filter((detail) => detail.ficha_id === ficha.id)
    .map((detail) => {
      const insumo = store.find('insumos', detail.insumo_id);
      return {
        ...detail,
        insumo: insumo ? insumo.nombre : null,
        unidad_medida: insumo ? insumo.unidad_medida : null,
        costo_promedio: insumo ? insumo.costo_promedio : 0,
        costo_linea: store.round2(detail.cantidad * (insumo ? insumo.costo_promedio : 0)),
      };
    });

  const porciones = ficha.porciones_rendimiento || 1;
  const costoPorcion = store.round2(ficha.costo_total / porciones);

  return {
    ...platillo,
    categoria: categoria ? categoria.nombre : null,
    ficha,
    ingredientes,
    costo_porcion: costoPorcion,
    food_cost_pct: platillo.precio_venta > 0
      ? store.round2((costoPorcion / platillo.precio_venta) * 100)
      : 0,
  };
}

function listCategorias() {
  const data = store.state.categorias_platillo
    .filter((categoria) => categoria.activo)
    .sort((a, b) => a.orden - b.orden);
  return { data, meta: { total: data.length } };
}

function filtrosPlatillos(query = {}) {
  const categoriaId = query.categoria_id ? parseId(query.categoria_id, 'categoria_id') : null;
  const categoria = query.categoria ? String(query.categoria).trim().toLowerCase() : null;
  const q = query.q ? String(query.q).trim().toLowerCase() : '';
  let activo = null;
  if (query.activo !== undefined) {
    if (!['true', 'false', '1', '0'].includes(String(query.activo))) {
      throw new AppError(400, 'VALIDATION_ERROR', 'El filtro activo debe ser true o false.', [
        { field: 'activo', value: query.activo },
      ]);
    }
    activo = String(query.activo) === 'true' || String(query.activo) === '1';
  }
  return { categoriaId, categoria, q, activo };
}

function aplicarFiltrosPlatillos(platillos, { categoriaId, categoria, q, activo }) {
  return platillos
    .filter((platillo) => !categoriaId || platillo.categoria_id === categoriaId)
    .filter(
      (platillo) =>
        !categoria || String(platillo.categoria || '').toLowerCase() === categoria,
    )
    .filter((platillo) => activo === null || platillo.activo === activo)
    .filter((platillo) => !q || String(platillo.nombre || '').toLowerCase().includes(q))
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
}

function metaPlatillos(platillos) {
  const activos = platillos.filter((platillo) => platillo.activo);
  const categoriasMap = new Map();
  for (const platillo of activos) {
    const nombre = platillo.categoria || 'Sin categoría';
    categoriasMap.set(nombre, (categoriasMap.get(nombre) || 0) + 1);
  }

  const margenes = activos.map((platillo) =>
    db.round2(Number(platillo.precio_venta) - Number(platillo.costo_porcion)),
  );
  const foodCosts = activos.map((platillo) => Number(platillo.food_cost_pct) || 0);
  const costos = activos.map((platillo) => Number(platillo.costo_porcion) || 0);
  const promedio = (valores) =>
    valores.length === 0 ? 0 : valores.reduce((suma, valor) => suma + valor, 0) / valores.length;

  let mejor = null;
  let menor = null;
  for (const platillo of activos) {
    const margen = db.round2(Number(platillo.precio_venta) - Number(platillo.costo_porcion));
    const item = {
      id: platillo.id,
      nombre: platillo.nombre,
      margen,
      food_cost_pct: Number(platillo.food_cost_pct) || 0,
    };
    if (!mejor || margen > mejor.margen) {
      mejor = item;
    }
    if (!menor || margen < menor.margen) {
      menor = item;
    }
  }

  return {
    total_activos: activos.length,
    categorias: [...categoriasMap.entries()].map(([nombre, total]) => ({ nombre, total })),
    margen_promedio: db.round2(promedio(margenes)),
    food_cost_promedio: Math.round(promedio(foodCosts) * 10) / 10,
    costo_promedio: db.round2(promedio(costos)),
    sobre_30: foodCosts.filter((valor) => valor > 30).length,
    mejor,
    menor,
  };
}

async function enriquecerPlatillos(platillos) {
  if (!platillos || platillos.length === 0) {
    return [];
  }

  const platilloIds = platillos.map((platillo) => platillo.id);
  const [{ data: categorias }, { data: fichas }] = await Promise.all([
    repository.list('categorias_platillo', { limit: 100 }),
    repository.list('fichas_tecnicas', { filters: { platillo_id: platilloIds }, limit: 500 }),
  ]);

  const fichaIds = fichas.map((ficha) => ficha.id);
  const [{ data: detalles }, { data: insumos }] = await Promise.all([
    fichaIds.length
      ? repository.list('fichas_tecnicas_detalle', { filters: { ficha_id: fichaIds }, limit: 2000 })
      : { data: [] },
    repository.list('insumos', { limit: 500 }),
  ]);

  const categoriasPorId = new Map(categorias.map((categoria) => [categoria.id, categoria.nombre]));
  const insumosPorId = new Map(insumos.map((insumo) => [insumo.id, insumo]));
  const fichasPorPlatillo = new Map(fichas.map((ficha) => [ficha.platillo_id, ficha]));
  const detallesPorFicha = new Map();
  for (const detalle of detalles) {
    const lista = detallesPorFicha.get(detalle.ficha_id) || [];
    lista.push(detalle);
    detallesPorFicha.set(detalle.ficha_id, lista);
  }

  return platillos.map((platillo) => {
    const filaFicha = fichasPorPlatillo.get(platillo.id) || null;
    const ficha = filaFicha
      ? {
        ...filaFicha,
        porciones_rendimiento: Number(filaFicha.porciones_rendimiento),
        costo_total: Number(filaFicha.costo_total),
      }
      : null;
    const ingredientes = (ficha ? detallesPorFicha.get(ficha.id) || [] : []).map((detalle) => {
      const insumo = insumosPorId.get(detalle.insumo_id) || null;
      const costoPromedio = insumo ? Number(insumo.costo_promedio) : 0;
      const cantidad = Number(detalle.cantidad);
      return {
        ...detalle,
        cantidad,
        insumo: insumo ? insumo.nombre : null,
        unidad_medida: insumo ? insumo.unidad_medida : null,
        costo_promedio: costoPromedio,
        costo_linea: db.round2(cantidad * costoPromedio),
      };
    });
    const porciones = ficha ? Number(ficha.porciones_rendimiento) || 1 : 1;
    const costoPorcion = ficha ? db.round2(Number(ficha.costo_total) / porciones) : 0;
    const precio = Number(platillo.precio_venta);
    return {
      ...platillo,
      precio_venta: precio,
      categoria: categoriasPorId.get(platillo.categoria_id) ?? null,
      ficha,
      ingredientes,
      costo_porcion: costoPorcion,
      food_cost_pct: precio > 0 ? db.round2((costoPorcion / precio) * 100) : 0,
    };
  });
}

async function listPlatillosDesdeDb(query, filtros) {
  const { data: platillos } = await repository.list('platillos', {
    orderBy: 'nombre',
    ascending: true,
    limit: 500,
  });
  const normalizados = await enriquecerPlatillos(platillos);

  const resultado = paginate(aplicarFiltrosPlatillos(normalizados, filtros), {
    ...query,
    limit: query.limit || 50,
  });
  return {
    ...resultado,
    meta: {
      ...resultado.meta,
      ...metaPlatillos(normalizados),
    },
  };
}

async function platilloConDetalleDb(platilloId) {
  const platillo = await db.findOrThrow('platillos', parseId(platilloId), 'Platillo');
  const [detalle] = await enriquecerPlatillos([platillo]);
  return detalle;
}

async function obtenerPlatillo(platilloId) {
  if (db.isSupabase()) {
    return platilloConDetalleDb(platilloId);
  }
  return fichaConDetalle(platilloId);
}

async function listPlatillos(query = {}) {
  const filtros = filtrosPlatillos(query);

  if (db.isSupabase()) {
    return listPlatillosDesdeDb(query, filtros);
  }

  const normalizados = store.state.platillos.map((platillo) => fichaConDetalle(platillo.id));
  const resultado = paginate(aplicarFiltrosPlatillos(normalizados, filtros), query);
  return {
    ...resultado,
    meta: {
      ...resultado.meta,
      ...metaPlatillos(normalizados),
    },
  };
}

async function crearPlatillo(body) {
  const payload = requiredObject(body);
  const categoriaId = requiredInt(payload.categoria_id, 'categoria_id', { min: 1 });
  await db.findOrThrow('categorias_platillo', categoriaId, 'Categoría');

  const nombre = requiredString(payload.nombre, 'nombre', { max: 120 });
  const descripcion = optionalString(payload.descripcion, 'descripcion', { max: 300 });
  const precioVenta = requiredNumber(payload.precio_venta, 'precio_venta', { min: 0 });
  const imagenUrl = optionalString(payload.imagen_url, 'imagen_url', { max: 255 });

  if (!db.isSupabase()) {
    const platillo = {
      id: store.nextId('platillos'),
      categoria_id: categoriaId,
      nombre,
      descripcion,
      precio_venta: precioVenta,
      imagen_url: imagenUrl,
      activo: true,
      creado_en: store.nowIso(),
      actualizado_en: store.nowIso(),
    };
    store.state.platillos.push(platillo);
    return fichaConDetalle(platillo.id);
  }

  let creado;
  try {
    creado = await repository.insert('platillos', {
      categoria_id: categoriaId,
      nombre,
      descripcion,
      precio_venta: precioVenta,
      imagen_url: imagenUrl,
      activo: true,
    });
  } catch (error) {
    throw db.persistenceError('No se pudo registrar el platillo.', error);
  }

  return platilloConDetalleDb(creado.id);
}

async function actualizarPlatillo(id, body) {
  const platillo = await db.findOrThrow('platillos', parseId(id), 'Platillo');
  const payload = requiredObject(body);

  let categoriaId;
  if (payload.categoria_id !== undefined) {
    categoriaId = requiredInt(payload.categoria_id, 'categoria_id', { min: 1 });
    await db.findOrThrow('categorias_platillo', categoriaId, 'Categoría');
  }
  const nombre = payload.nombre !== undefined
    ? requiredString(payload.nombre, 'nombre', { max: 120 })
    : undefined;
  const descripcion = payload.descripcion !== undefined
    ? optionalString(payload.descripcion, 'descripcion', { max: 300 })
    : undefined;
  const precioVenta = payload.precio_venta !== undefined
    ? requiredNumber(payload.precio_venta, 'precio_venta', { min: 0 })
    : undefined;
  const imagenUrl = payload.imagen_url !== undefined
    ? optionalString(payload.imagen_url, 'imagen_url', { max: 255 })
    : undefined;

  if (!db.isSupabase()) {
    if (categoriaId !== undefined) {
      platillo.categoria_id = categoriaId;
    }
    if (nombre !== undefined) {
      platillo.nombre = nombre;
    }
    if (descripcion !== undefined) {
      platillo.descripcion = descripcion;
    }
    if (precioVenta !== undefined) {
      platillo.precio_venta = precioVenta;
    }
    if (imagenUrl !== undefined) {
      platillo.imagen_url = imagenUrl;
    }
    platillo.actualizado_en = store.nowIso();

    return fichaConDetalle(platillo.id);
  }

  const patch = { actualizado_en: db.nowIso() };
  if (categoriaId !== undefined) {
    patch.categoria_id = categoriaId;
  }
  if (nombre !== undefined) {
    patch.nombre = nombre;
  }
  if (descripcion !== undefined) {
    patch.descripcion = descripcion;
  }
  if (precioVenta !== undefined) {
    patch.precio_venta = precioVenta;
  }
  if (imagenUrl !== undefined) {
    patch.imagen_url = imagenUrl;
  }

  try {
    await repository.update('platillos', platillo.id, patch);
  } catch (error) {
    throw db.persistenceError('No se pudo actualizar el platillo.', error);
  }

  return platilloConDetalleDb(platillo.id);
}

async function cambiarActivo(id, body) {
  const platillo = await db.findOrThrow('platillos', parseId(id), 'Platillo');
  const payload = requiredObject(body);

  if (typeof payload.activo !== 'boolean') {
    throw new AppError(400, 'VALIDATION_ERROR', 'El campo "activo" debe ser booleano.', [
      { field: 'activo', value: payload.activo },
    ]);
  }

  if (!db.isSupabase()) {
    platillo.activo = payload.activo;
    platillo.actualizado_en = store.nowIso();
    return fichaConDetalle(platillo.id);
  }

  try {
    await repository.update('platillos', platillo.id, {
      activo: payload.activo,
      actualizado_en: db.nowIso(),
    });
  } catch (error) {
    throw db.persistenceError('No se pudo cambiar el estado del platillo.', error);
  }

  return platilloConDetalleDb(platillo.id);
}

function lineasFicha(items, insumosPorId) {
  const vistos = new Set();
  return items.map((item, index) => {
    const insumoId = requiredInt(item.insumo_id, `ingredientes[${index}].insumo_id`, { min: 1 });
    if (vistos.has(insumoId)) {
      throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'No se puede repetir un insumo en la ficha.', [
        { field: `ingredientes[${index}].insumo_id`, value: insumoId },
      ]);
    }
    vistos.add(insumoId);
    const insumo = insumosPorId
      ? insumosPorId.get(insumoId) || null
      : store.findOrThrow('insumos', insumoId, 'Insumo');
    if (!insumo) {
      throw new AppError(404, 'NOT_FOUND', `Insumo con id ${insumoId} no existe.`);
    }
    const cantidad = requiredNumber(item.cantidad, `ingredientes[${index}].cantidad`, { min: 0.001 });
    return {
      insumo_id: insumo.id,
      cantidad: store.round3(cantidad),
      costo_linea: store.round2(cantidad * Number(insumo.costo_promedio)),
    };
  });
}

async function guardarFicha(platilloId, body) {
  const platillo = await db.findOrThrow('platillos', parseId(platilloId), 'Platillo');
  const payload = requiredObject(body);
  const porciones = requiredInt(payload.porciones_rendimiento, 'porciones_rendimiento', { min: 1, max: 999 });
  const items = requiredArray(payload.ingredientes, 'ingredientes', { max: 100 });
  const notas = optionalString(payload.notas, 'notas', { max: 500 });

  let lineas;
  if (!db.isSupabase()) {
    lineas = lineasFicha(items, null);
  } else {
    const candidatos = [...new Set(
      items
        .map((item) => Number(item && item.insumo_id))
        .filter((numero) => Number.isInteger(numero) && numero > 0),
    )];
    const { data: insumos } = candidatos.length
      ? await repository.list('insumos', { filters: { id: candidatos }, limit: 1000 })
      : { data: [] };
    lineas = lineasFicha(items, new Map(insumos.map((insumo) => [insumo.id, insumo])));
  }

  const total = store.round2(lineas.reduce((suma, linea) => suma + linea.costo_linea, 0));

  if (!db.isSupabase()) {
    let ficha = store.state.fichas_tecnicas.find((item) => item.platillo_id === platillo.id);
    if (!ficha) {
      ficha = {
        id: store.nextId('fichas_tecnicas'),
        platillo_id: platillo.id,
        porciones_rendimiento: porciones,
        costo_total: 0,
        notas: null,
        activa: true,
        creado_en: store.nowIso(),
        actualizado_en: store.nowIso(),
      };
      store.state.fichas_tecnicas.push(ficha);
    }

    store.state.fichas_tecnicas_detalle = store.state.fichas_tecnicas_detalle.filter(
      (detail) => detail.ficha_id !== ficha.id,
    );
    for (const linea of lineas) {
      store.state.fichas_tecnicas_detalle.push({
        id: store.nextId('fichas_tecnicas_detalle'),
        ficha_id: ficha.id,
        insumo_id: linea.insumo_id,
        cantidad: linea.cantidad,
      });
    }

    ficha.porciones_rendimiento = porciones;
    ficha.costo_total = total;
    ficha.notas = notas;
    ficha.activa = true;
    ficha.actualizado_en = store.nowIso();

    return fichaConDetalle(platillo.id);
  }

  const ficha = await db.findOne('fichas_tecnicas', { platillo_id: platillo.id });

  if (ficha) {
    const anteriores = (await repository.list('fichas_tecnicas_detalle', {
      filters: { ficha_id: ficha.id },
      limit: 500,
    })).data || [];

    const { error } = await repository
      .table('fichas_tecnicas_detalle')
      .delete()
      .eq('ficha_id', ficha.id);
    if (error) {
      throw db.persistenceError('No se pudieron reemplazar los ingredientes de la ficha.', error);
    }

    try {
      await repository.update('fichas_tecnicas', ficha.id, {
        porciones_rendimiento: porciones,
        costo_total: total,
        notas,
        activa: true,
        actualizado_en: db.nowIso(),
      });
      await repository.insertMany(
        'fichas_tecnicas_detalle',
        lineas.map((linea) => ({
          ficha_id: ficha.id,
          insumo_id: linea.insumo_id,
          cantidad: linea.cantidad,
        })),
      );
    } catch (error) {
      // Compensación: se intenta devolver los ingredientes anteriores.
      if (anteriores.length > 0) {
        try {
          await repository.insertMany(
            'fichas_tecnicas_detalle',
            anteriores.map(({ id: _id, ...resto }) => resto),
          );
        } catch (restauracion) {
          // los ingredientes quedan perdidos; el error original se informa igual
        }
      }
      throw db.persistenceError('No se pudo guardar la ficha técnica.', error);
    }

    return platilloConDetalleDb(platillo.id);
  }

  let creada;
  try {
    creada = await repository.insert('fichas_tecnicas', {
      platillo_id: platillo.id,
      porciones_rendimiento: porciones,
      costo_total: total,
      notas,
      activa: true,
    });
  } catch (error) {
    throw db.persistenceError('No se pudo registrar la ficha técnica.', error);
  }

  try {
    await repository.insertMany(
      'fichas_tecnicas_detalle',
      lineas.map((linea) => ({
        ficha_id: creada.id,
        insumo_id: linea.insumo_id,
        cantidad: linea.cantidad,
      })),
    );
  } catch (error) {
    try {
      await repository.remove('fichas_tecnicas', creada.id);
    } catch (limpieza) {
      // la ficha queda sin ingredientes; el error original se informa igual
    }
    throw db.persistenceError('No se pudieron guardar los ingredientes de la ficha.', error);
  }

  return platilloConDetalleDb(platillo.id);
}

function listIngredientes(query = {}) {
  const categoria = query.categoria ? String(query.categoria) : null;
  const q = query.q ? String(query.q).trim().toLowerCase() : '';

  const data = store.state.insumos
    .filter((insumo) => insumo.activo)
    .filter((insumo) => !categoria || insumo.categoria === categoria)
    .filter((insumo) => !q || insumo.nombre.toLowerCase().includes(q) || insumo.codigo.toLowerCase().includes(q))
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map((insumo) => ({
      id: insumo.id,
      codigo: insumo.codigo,
      nombre: insumo.nombre,
      categoria: insumo.categoria,
      unidad_medida: insumo.unidad_medida,
      costo_promedio: insumo.costo_promedio,
      stock_actual: insumo.stock_actual,
    }));

  return paginate(data, query);
}

function listFichas(query = {}) {
  const data = store.state.platillos
    .filter((platillo) => platillo.activo)
    .map((platillo) => fichaConDetalle(platillo.id))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  return paginate(data, query);
}

module.exports = {
  fichaDePlatillo,
  fichaConDetalle,
  obtenerPlatillo,
  listCategorias,
  listPlatillos,
  crearPlatillo,
  actualizarPlatillo,
  cambiarActivo,
  guardarFicha,
  listIngredientes,
  listFichas,
};
