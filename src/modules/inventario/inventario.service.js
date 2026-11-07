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
  parseId,
} = require('../../middleware/validate');

const TIPOS_MOVIMIENTO = ['entrada', 'salida', 'merma', 'ajuste', 'devolucion'];

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

async function listInventario(query = {}) {
  const estado = query.estado ? String(query.estado) : null;
  const q = query.q ? String(query.q).trim().toLowerCase() : '';
  if (estado && !['ok', 'bajo', 'critico'].includes(estado)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El estado debe ser ok, bajo o critico.', [
      { field: 'estado', value: estado },
    ]);
  }

  if (!db.isSupabase()) {
    const data = store.state.insumos
      .filter((insumo) => insumo.activo)
      .map(insumoResumen)
      .filter((insumo) => !estado || insumo.estado === estado)
      .filter((insumo) => !q || insumo.nombre.toLowerCase().includes(q) || insumo.codigo.toLowerCase().includes(q))
      .sort((a, b) => a.nombre.localeCompare(b.nombre));

    const resultado = paginate(data, query);
    return {
      ...resultado,
      meta: {
        ...resultado.meta,
        total_alertas: data.filter((insumo) => insumo.estado !== 'ok').length,
      },
    };
  }

  const { data } = await repository.list('insumos', {
    filters: { activo: true },
    orderBy: 'nombre',
    ascending: true,
    limit: 100,
  });
  const data2 = data
    .map(insumoResumen)
    .filter((insumo) => !estado || insumo.estado === estado)
    .filter((insumo) => !q || insumo.nombre.toLowerCase().includes(q) || insumo.codigo.toLowerCase().includes(q))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  const resultado = paginate(data2, query);
  return {
    ...resultado,
    meta: {
      ...resultado.meta,
      total_alertas: data2.filter((insumo) => insumo.estado !== 'ok').length,
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
    limit: 100,
  });
  const data2 = data
    .filter((insumo) => Number(insumo.stock_actual) <= Number(insumo.stock_minimo))
    .map(insumoResumen)
    .sort((a, b) => b.faltante - a.faltante);

  return { data: data2, meta: { total: data2.length, generado_en: db.nowIso() } };
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
  historialMovimientos,
  verificarStock,
  aplicarAjustes,
  actualizarMinimo,
};
