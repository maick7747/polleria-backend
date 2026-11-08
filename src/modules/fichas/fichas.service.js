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
  return { categoriaId, q, activo };
}

function aplicarFiltrosPlatillos(platillos, { categoriaId, q, activo }) {
  return platillos
    .filter((platillo) => !categoriaId || platillo.categoria_id === categoriaId)
    .filter((platillo) => activo === null || platillo.activo === activo)
    .filter((platillo) => !q || String(platillo.nombre || '').toLowerCase().includes(q))
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
}

async function listPlatillosDesdeDb(query, filtros) {
  const [
    { data: platillos },
    { data: categorias },
    { data: fichas },
    { data: detalles },
    { data: insumos },
  ] = await Promise.all([
    repository.list('platillos', { orderBy: 'nombre', ascending: true, limit: 500 }),
    repository.list('categorias_platillo', { limit: 100 }),
    repository.list('fichas_tecnicas', { limit: 500 }),
    repository.list('fichas_tecnicas_detalle', { limit: 2000 }),
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

  const normalizados = platillos.map((platillo) => {
    const ficha = fichasPorPlatillo.get(platillo.id) || null;
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

  return paginate(aplicarFiltrosPlatillos(normalizados, filtros), {
    ...query,
    limit: query.limit || 50,
  });
}

async function listPlatillos(query = {}) {
  const filtros = filtrosPlatillos(query);

  if (db.isSupabase()) {
    return listPlatillosDesdeDb(query, filtros);
  }

  const data = aplicarFiltrosPlatillos(store.state.platillos, filtros).map((platillo) =>
    fichaConDetalle(platillo.id),
  );

  return paginate(data, query);
}

function crearPlatillo(body) {
  const payload = requiredObject(body);
  const categoriaId = requiredInt(payload.categoria_id, 'categoria_id', { min: 1 });
  store.findOrThrow('categorias_platillo', categoriaId, 'Categoría');

  const platillo = {
    id: store.nextId('platillos'),
    categoria_id: categoriaId,
    nombre: requiredString(payload.nombre, 'nombre', { max: 120 }),
    descripcion: optionalString(payload.descripcion, 'descripcion', { max: 300 }),
    precio_venta: requiredNumber(payload.precio_venta, 'precio_venta', { min: 0 }),
    imagen_url: optionalString(payload.imagen_url, 'imagen_url', { max: 255 }),
    activo: true,
    creado_en: store.nowIso(),
    actualizado_en: store.nowIso(),
  };
  store.state.platillos.push(platillo);
  return fichaConDetalle(platillo.id);
}

function actualizarPlatillo(id, body) {
  const platillo = store.findOrThrow('platillos', parseId(id), 'Platillo');
  const payload = requiredObject(body);

  if (payload.categoria_id !== undefined) {
    const categoriaId = requiredInt(payload.categoria_id, 'categoria_id', { min: 1 });
    store.findOrThrow('categorias_platillo', categoriaId, 'Categoría');
    platillo.categoria_id = categoriaId;
  }
  if (payload.nombre !== undefined) {
    platillo.nombre = requiredString(payload.nombre, 'nombre', { max: 120 });
  }
  if (payload.descripcion !== undefined) {
    platillo.descripcion = optionalString(payload.descripcion, 'descripcion', { max: 300 });
  }
  if (payload.precio_venta !== undefined) {
    platillo.precio_venta = requiredNumber(payload.precio_venta, 'precio_venta', { min: 0 });
  }
  if (payload.imagen_url !== undefined) {
    platillo.imagen_url = optionalString(payload.imagen_url, 'imagen_url', { max: 255 });
  }
  platillo.actualizado_en = store.nowIso();

  return fichaConDetalle(platillo.id);
}

function cambiarActivo(id, body) {
  const platillo = store.findOrThrow('platillos', parseId(id), 'Platillo');
  const payload = requiredObject(body);

  if (typeof payload.activo !== 'boolean') {
    throw new AppError(400, 'VALIDATION_ERROR', 'El campo "activo" debe ser booleano.', [
      { field: 'activo', value: payload.activo },
    ]);
  }

  platillo.activo = payload.activo;
  platillo.actualizado_en = store.nowIso();
  return fichaConDetalle(platillo.id);
}

function guardarFicha(platilloId, body) {
  const platillo = store.findOrThrow('platillos', parseId(platilloId), 'Platillo');
  const payload = requiredObject(body);
  const porciones = requiredInt(payload.porciones_rendimiento, 'porciones_rendimiento', { min: 1, max: 999 });
  const items = requiredArray(payload.ingredientes, 'ingredientes', { max: 100 });

  const vistos = new Set();
  const lineas = items.map((item, index) => {
    const insumoId = requiredInt(item.insumo_id, `ingredientes[${index}].insumo_id`, { min: 1 });
    if (vistos.has(insumoId)) {
      throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'No se puede repetir un insumo en la ficha.', [
        { field: `ingredientes[${index}].insumo_id`, value: insumoId },
      ]);
    }
    vistos.add(insumoId);
    const insumo = store.findOrThrow('insumos', insumoId, 'Insumo');
    const cantidad = requiredNumber(item.cantidad, `ingredientes[${index}].cantidad`, { min: 0.001 });
    return {
      insumo_id: insumo.id,
      cantidad: store.round3(cantidad),
      costo_linea: store.round2(cantidad * insumo.costo_promedio),
    };
  });

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
  let total = 0;
  for (const linea of lineas) {
    total += linea.costo_linea;
    store.state.fichas_tecnicas_detalle.push({
      id: store.nextId('fichas_tecnicas_detalle'),
      ficha_id: ficha.id,
      insumo_id: linea.insumo_id,
      cantidad: linea.cantidad,
    });
  }

  ficha.porciones_rendimiento = porciones;
  ficha.costo_total = store.round2(total);
  ficha.notas = optionalString(payload.notas, 'notas', { max: 500 });
  ficha.activa = true;
  ficha.actualizado_en = store.nowIso();

  return fichaConDetalle(platillo.id);
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
  listCategorias,
  listPlatillos,
  crearPlatillo,
  actualizarPlatillo,
  cambiarActivo,
  guardarFicha,
  listIngredientes,
  listFichas,
};
