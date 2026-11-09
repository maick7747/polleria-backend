'use strict';

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredInt,
  requiredNumber,
  requiredArray,
  optionalString,
  optionalDate,
  paginate,
  pageParams,
  parseId,
  parseSort,
} = require('../../middleware/validate');

const TIPOS_MOVIMIENTO = ['entrada', 'salida', 'merma', 'ajuste', 'devolucion'];
const CAMPOS_ORDEN_MOVIMIENTO = ['id', 'fecha', 'cantidad'];

function fechaLima(iso) {
  if (!iso) {
    return null;
  }
  return new Date(Date.parse(iso) - 5 * 3600000).toISOString().slice(0, 10);
}

function estadoStock(insumo) {
  const actual = Number(insumo.stock_actual);
  const minimo = Number(insumo.stock_minimo);
  if (!(minimo > 0)) {
    return 'ok';
  }
  if (actual <= minimo * 0.5) {
    return 'critico';
  }
  if (actual <= minimo) {
    return 'bajo';
  }
  return 'ok';
}

function insumoResumen(insumo) {
  return {
    ...insumo,
    stock_actual: Number(insumo.stock_actual),
    stock_minimo: Number(insumo.stock_minimo),
    costo_promedio: Number(insumo.costo_promedio),
    umbral_merma_pct: Number(insumo.umbral_merma_pct) || 0,
    estado: estadoStock(insumo),
    faltante: store.round3(Math.max(0, Number(insumo.stock_minimo) - Number(insumo.stock_actual))),
    valor_stock: store.round2(Number(insumo.stock_actual) * Number(insumo.costo_promedio)),
  };
}

function totalesInventario(insumos) {
  const totalOk = insumos.filter((insumo) => insumo.estado === 'ok').length;
  const totalBajo = insumos.filter((insumo) => insumo.estado === 'bajo').length;
  const totalCritico = insumos.filter((insumo) => insumo.estado === 'critico').length;
  const valorInventario = store.round2(
    insumos.reduce((suma, insumo) => suma + Number(insumo.valor_stock || 0), 0),
  );
  return {
    total_insumos: insumos.length,
    total_ok: totalOk,
    total_bajo: totalBajo,
    total_critico: totalCritico,
    total_alertas: totalBajo + totalCritico,
    valor_inventario: valorInventario,
  };
}

async function listInventario(query = {}) {
  const estado = query.estado ? String(query.estado) : null;
  const q = query.q ? String(query.q).trim().toLowerCase() : '';
  if (estado && !['ok', 'bajo', 'critico'].includes(estado)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El estado debe ser ok, bajo o critico.', [
      { field: 'estado', value: estado },
    ]);
  }

  if (!db.isSupabase()) {
    const todos = store.state.insumos
      .filter((insumo) => insumo.activo)
      .map(insumoResumen)
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
    const data = todos
      .filter((insumo) => !estado || insumo.estado === estado)
      .filter((insumo) => !q || insumo.nombre.toLowerCase().includes(q) || insumo.codigo.toLowerCase().includes(q));

    const resultado = paginate(data, query);
    return {
      ...resultado,
      meta: {
        ...resultado.meta,
        ...totalesInventario(todos),
      },
    };
  }

  const { data } = await repository.list('insumos', {
    filters: { activo: true },
    orderBy: 'nombre',
    ascending: true,
    limit: 1000,
  });
  const todos = data
    .map(insumoResumen)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  const data2 = todos
    .filter((insumo) => !estado || insumo.estado === estado)
    .filter((insumo) => !q || insumo.nombre.toLowerCase().includes(q) || insumo.codigo.toLowerCase().includes(q));

  const resultado = paginate(data2, query);
  return {
    ...resultado,
    meta: {
      ...resultado.meta,
      ...totalesInventario(todos),
    },
  };
}

async function listAlertas() {
  if (!db.isSupabase()) {
    const data = store.state.insumos
      .filter((insumo) => insumo.activo && insumo.stock_actual <= insumo.stock_minimo)
      .map(insumoResumen)
      .sort((a, b) => b.faltante - a.faltante);

    return { data, meta: { total: data.length, generado_en: store.nowIso() } };
  }

  const { data } = await repository.list('insumos', {
    filters: { activo: true },
    orderBy: 'nombre',
    ascending: true,
    limit: 1000,
  });
  const data2 = data
    .filter((insumo) => Number(insumo.stock_actual) <= Number(insumo.stock_minimo))
    .map(insumoResumen)
    .sort((a, b) => b.faltante - a.faltante);

  return { data: data2, meta: { total: data2.length, generado_en: db.nowIso() } };
}

function finExclusivo(fecha) {
  const [anio, mes, dia] = fecha.split('-').map(Number);
  const siguiente = new Date(Date.UTC(anio, mes - 1, dia + 1));
  return siguiente.toISOString().slice(0, 10);
}

function valorOrdenMovimiento(fila, campo) {
  if (campo === 'id' || campo === 'cantidad') {
    return Number(fila[campo]) || 0;
  }
  const valor = fila[campo];
  return valor === null || valor === undefined ? '' : String(valor);
}

function ordenarMovimientos(filas, campo, ascending) {
  const direccion = ascending ? 1 : -1;
  return [...filas].sort((izq, der) => {
    const a = valorOrdenMovimiento(izq, campo);
    const b = valorOrdenMovimiento(der, campo);
    if (a < b) return -1 * direccion;
    if (a > b) return 1 * direccion;
    return (Number(der.id) || 0) - (Number(izq.id) || 0);
  });
}

function movimientoDTO(movimiento, insumo, usuario) {
  return {
    ...movimiento,
    cantidad: Number(movimiento.cantidad),
    stock_resultante: movimiento.stock_resultante === null || movimiento.stock_resultante === undefined
      ? null
      : Number(movimiento.stock_resultante),
    insumo: insumo ? insumo.nombre : null,
    usuario: usuario ? usuario.nombre : null,
  };
}

function filtrosMovimiento(query = {}) {
  const tipo = query.tipo ? String(query.tipo) : null;
  if (tipo && !TIPOS_MOVIMIENTO.includes(tipo)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Tipo de movimiento inválido.', [
      { field: 'tipo', value: tipo },
    ]);
  }
  const insumoId = query.insumo_id ? parseId(query.insumo_id, 'insumo_id') : null;
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');
  const { campo, ascending } = parseSort(
    query.sort,
    CAMPOS_ORDEN_MOVIMIENTO,
    'fecha:desc',
    'sort',
  );
  return { tipo, insumoId, desde, hasta, sort: campo, ascending };
}

function listMovimientosMemoria(filtros, query) {
  const filtrados = store.state.movimientos_inventario
    .filter((movimiento) => !filtros.tipo || movimiento.tipo === filtros.tipo)
    .filter((movimiento) => !filtros.insumoId || movimiento.insumo_id === filtros.insumoId)
    .filter((movimiento) => !filtros.desde || movimiento.fecha.slice(0, 10) >= filtros.desde)
    .filter((movimiento) => !filtros.hasta || movimiento.fecha.slice(0, 10) <= filtros.hasta);

  const ordenados = ordenarMovimientos(filtrados, filtros.sort, filtros.ascending);
  const data = ordenados.map((movimiento) =>
    movimientoDTO(
      movimiento,
      store.find('insumos', movimiento.insumo_id),
      store.find('usuarios', movimiento.usuario_id),
    ),
  );
  return paginate(data, query);
}

async function listMovimientosSupabase(filtros, query) {
  const { page, limit } = pageParams(query);

  let consulta = repository
    .table('movimientos_inventario')
    .select('*', { count: 'exact' });
  if (filtros.tipo) {
    consulta = consulta.eq('tipo', filtros.tipo);
  }
  if (filtros.insumoId) {
    consulta = consulta.eq('insumo_id', filtros.insumoId);
  }
  if (filtros.desde) {
    consulta = consulta.gte('fecha', filtros.desde);
  }
  if (filtros.hasta) {
    consulta = consulta.lt('fecha', finExclusivo(filtros.hasta));
  }
  consulta = consulta
    .order(filtros.sort, { ascending: filtros.ascending })
    .order('id', { ascending: false });

  const inicio = (page - 1) * limit;
  const { data, error, count } = await consulta.range(inicio, inicio + limit - 1);
  if (error) {
    throw db.persistenceError('No se pudieron listar los movimientos de inventario.', error);
  }

  const filas = data || [];
  const insumoIds = [...new Set(filas.map((fila) => fila.insumo_id))];
  const usuarioIds = [...new Set(filas.map((fila) => fila.usuario_id))];
  const [insumos, usuarios] = await Promise.all([
    insumoIds.length
      ? repository.list('insumos', {
        select: 'id, nombre',
        filters: { id: insumoIds },
        limit: 1000,
      })
      : { data: [] },
    usuarioIds.length
      ? repository.list('usuarios', {
        select: 'id, nombre',
        filters: { id: usuarioIds },
        limit: 1000,
      })
      : { data: [] },
  ]);
  const nombresInsumo = new Map((insumos.data || []).map((insumo) => [insumo.id, insumo]));
  const nombresUsuario = new Map((usuarios.data || []).map((usuario) => [usuario.id, usuario]));

  const total = typeof count === 'number' ? count : filas.length;
  return {
    data: filas.map((movimiento) =>
      movimientoDTO(
        movimiento,
        nombresInsumo.get(movimiento.insumo_id),
        nombresUsuario.get(movimiento.usuario_id),
      ),
    ),
    meta: { page, limit, total, pages: total === 0 ? 0 : Math.ceil(total / limit) },
  };
}

async function listMovimientos(query = {}) {
  const filtros = filtrosMovimiento(query);
  if (db.isSupabase()) {
    return listMovimientosSupabase(filtros, query);
  }
  return listMovimientosMemoria(filtros, query);
}

async function historialMovimientos(insumoId, query = {}) {
  const id = parseId(insumoId, 'insumo_id');
  const tipo = query.tipo ? String(query.tipo) : null;
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');

  if (tipo && !TIPOS_MOVIMIENTO.includes(tipo)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Tipo de movimiento inválido.', [
      { field: 'tipo', value: tipo },
    ]);
  }

  if (!db.isSupabase()) {
    store.findOrThrow('insumos', id, 'Insumo');
    const data = store.state.movimientos_inventario
      .filter((movimiento) => movimiento.insumo_id === id)
      .filter((movimiento) => !tipo || movimiento.tipo === tipo)
      .filter((movimiento) => !desde || movimiento.fecha.slice(0, 10) >= desde)
      .filter((movimiento) => !hasta || movimiento.fecha.slice(0, 10) <= hasta)
      .sort((a, b) => b.fecha.localeCompare(a.fecha))
      .map((movimiento) => {
        const usuario = store.find('usuarios', movimiento.usuario_id);
        return { ...movimiento, usuario: usuario ? usuario.nombre : null };
      });

    return paginate(data, query);
  }

  await db.findOrThrow('insumos', id, 'Insumo');
  const filters = { insumo_id: id };
  if (tipo) {
    filters.tipo = tipo;
  }
  const { data } = await repository.list('movimientos_inventario', {
    filters,
    orderBy: 'fecha',
    ascending: false,
    limit: 100,
  });
  const filtrados = data
    .filter((movimiento) => !desde || fechaLima(movimiento.fecha) >= desde)
    .filter((movimiento) => !hasta || fechaLima(movimiento.fecha) <= hasta);

  const usuarioIds = [...new Set(filtrados.map((movimiento) => movimiento.usuario_id))];
  const usuarios = usuarioIds.length
    ? (await repository.list('usuarios', { filters: { id: usuarioIds }, limit: 100 })).data
    : [];
  const nombres = new Map(usuarios.map((usuario) => [usuario.id, usuario.nombre]));

  const mapped = filtrados.map((movimiento) => ({
    ...movimiento,
    cantidad: Number(movimiento.cantidad),
    stock_resultante: Number(movimiento.stock_resultante),
    usuario: nombres.get(movimiento.usuario_id) || null,
  }));

  return paginate(mapped, query);
}

async function verificarStock(body) {
  const payload = requiredObject(body);
  const items = requiredArray(payload.items, 'items', { max: 200 });

  if (!db.isSupabase()) {
    const diferencias = items.map((item, index) => {
      const insumoId = requiredInt(item.insumo_id, `items[${index}].insumo_id`, { min: 1 });
      const insumo = store.findOrThrow('insumos', insumoId, 'Insumo');
      const conteo = requiredNumber(item.conteo_fisico, `items[${index}].conteo_fisico`, { min: 0 });
      const diferencia = store.round3(conteo - insumo.stock_actual);
      return {
        insumo_id: insumo.id,
        insumo: insumo.nombre,
        unidad_medida: insumo.unidad_medida,
        stock_sistema: insumo.stock_actual,
        conteo_fisico: conteo,
        diferencia,
        ajuste_propuesto: diferencia,
        requiere_ajuste: Math.abs(diferencia) > 0.0005,
      };
    });

    return {
      aplicado: false,
      diferencias,
      resumen: {
        items: diferencias.length,
        con_diferencia: diferencias.filter((item) => item.requiere_ajuste).length,
      },
    };
  }

  const diferencias = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const insumoId = requiredInt(item.insumo_id, `items[${index}].insumo_id`, { min: 1 });
    const insumo = await db.findOrThrow('insumos', insumoId, 'Insumo');
    const conteo = requiredNumber(item.conteo_fisico, `items[${index}].conteo_fisico`, { min: 0 });
    const diferencia = store.round3(conteo - Number(insumo.stock_actual));
    diferencias.push({
      insumo_id: insumo.id,
      insumo: insumo.nombre,
      unidad_medida: insumo.unidad_medida,
      stock_sistema: Number(insumo.stock_actual),
      conteo_fisico: conteo,
      diferencia,
      ajuste_propuesto: diferencia,
      requiere_ajuste: Math.abs(diferencia) > 0.0005,
    });
  }

  return {
    aplicado: false,
    diferencias,
    resumen: {
      items: diferencias.length,
      con_diferencia: diferencias.filter((item) => item.requiere_ajuste).length,
    },
  };
}

async function aplicarAjustes(body, usuario) {
  const payload = requiredObject(body);
  const items = requiredArray(payload.items, 'items', { max: 200 });

  if (!db.isSupabase()) {
    const movimientos = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const insumoId = requiredInt(item.insumo_id, `items[${index}].insumo_id`, { min: 1 });
      const insumo = store.findOrThrow('insumos', insumoId, 'Insumo');
      const objetivo = requiredNumber(item.cantidad, `items[${index}].cantidad`, { min: 0 });
      const delta = store.round3(objetivo - insumo.stock_actual);

      if (Math.abs(delta) <= 0.0005) {
        continue;
      }

      movimientos.push(
        store.applyMovement({
          insumo_id: insumo.id,
          tipo: 'ajuste',
          cantidad: Math.abs(delta),
          stock_resultante: objetivo,
          referencia_tipo: 'ajuste',
          referencia_id: null,
          usuario_id: usuario.id,
          observacion: optionalString(item.observacion, `items[${index}].observacion`, { max: 300 })
            || `Ajuste de inventario (${delta > 0 ? '+' : ''}${delta})`,
        }),
      );
    }

    return { movimientos, total: movimientos.length };
  }

  const movimientos = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const insumoId = requiredInt(item.insumo_id, `items[${index}].insumo_id`, { min: 1 });
    const insumo = await db.findOrThrow('insumos', insumoId, 'Insumo');
    const objetivo = requiredNumber(item.cantidad, `items[${index}].cantidad`, { min: 0 });
    const delta = store.round3(objetivo - Number(insumo.stock_actual));

    if (Math.abs(delta) <= 0.0005) {
      continue;
    }

    movimientos.push(
      await db.applyMovement({
        insumo_id: insumo.id,
        tipo: 'ajuste',
        cantidad: Math.abs(delta),
        stock_resultante: objetivo,
        referencia_tipo: 'ajuste',
        referencia_id: null,
        usuario_id: usuario.id,
        observacion: optionalString(item.observacion, `items[${index}].observacion`, { max: 300 })
          || `Ajuste de inventario (${delta > 0 ? '+' : ''}${delta})`,
      }),
    );
  }

  return { movimientos, total: movimientos.length };
}

async function actualizarMinimo(insumoId, body) {
  const payload = requiredObject(body);
  const nuevoMinimo = requiredNumber(payload.stock_minimo, 'stock_minimo', { min: 0 });

  if (!db.isSupabase()) {
    const insumo = store.findOrThrow('insumos', parseId(insumoId, 'insumo_id'), 'Insumo');
    insumo.stock_minimo = nuevoMinimo;
    insumo.actualizado_en = store.nowIso();
    return insumoResumen(insumo);
  }

  const insumo = await db.findOrThrow('insumos', parseId(insumoId, 'insumo_id'), 'Insumo');
  const actualizado = await repository.update('insumos', insumo.id, {
    stock_minimo: nuevoMinimo,
  });
  return insumoResumen(actualizado || { ...insumo, stock_minimo: nuevoMinimo });
}

module.exports = {
  estadoStock,
  listInventario,
  listAlertas,
  listMovimientos,
  historialMovimientos,
  verificarStock,
  aplicarAjustes,
  actualizarMinimo,
};
