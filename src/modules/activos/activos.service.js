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
  optionalString,
  optionalDate,
  optionalAfter,
  paginate,
  pageParams,
  metaPaginada,
  parseId,
  parseSort,
} = require('../../middleware/validate');

const CATEGORIAS = ['cocina', 'salon', 'delivery', 'oficina', 'limpieza'];
const ESTADOS = ['activo', 'en_reparacion', 'dado_de_baja'];
const TIPOS_MANT = ['preventivo', 'correctivo'];
const DECISIONES = ['reparar', 'reemplazar'];
const CAMPOS_ORDEN = ['id', 'nombre', 'fecha_adquisicion', 'costo_adquisicion', 'estado'];

function aNumero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function valorOrden(fila, campo) {
  if (campo === 'id' || campo === 'costo_adquisicion') {
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

function mesesEntre(fecha, referencia = new Date()) {
  const start = new Date(`${fecha}T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    return 0;
  }
  return Math.max(
    0,
    (referencia.getFullYear() - start.getFullYear()) * 12 + referencia.getMonth() - start.getMonth(),
  );
}

function mantenimientoDTO(mantenimiento) {
  return {
    ...mantenimiento,
    costo_reparacion: db.round2(aNumero(mantenimiento.costo_reparacion)),
    costo_reposicion: db.round2(aNumero(mantenimiento.costo_reposicion)),
    fecha_autorizacion: mantenimiento.fecha_autorizacion === undefined
      ? null
      : mantenimiento.fecha_autorizacion,
  };
}

function activoDTO(activo, mantenimientos = []) {
  const ordenados = [...mantenimientos].sort((a, b) => aNumero(b.id) - aNumero(a.id));
  const ultimo = ordenados[0] || null;
  const meses = mesesEntre(activo.fecha_adquisicion);
  const vida = activo.vida_util_meses === null || activo.vida_util_meses === undefined
    ? null
    : Number(activo.vida_util_meses);
  // Próximo mantenimiento: la fecha programada más cercana entre los que
  // siguen pendientes (estado "programado"). Null si no hay ninguno.
  const programados = mantenimientos
    .filter((item) => item && item.estado === 'programado' && item.programada_para)
    .map((item) => String(item.programada_para))
    .sort();
  const proximoMantenimiento = programados.length > 0 ? programados[0] : null;
  return {
    ...activo,
    cantidad: Number(activo.cantidad),
    costo_adquisicion: db.round2(aNumero(activo.costo_adquisicion)),
    vida_util_meses: vida,
    antiguedad_meses: meses,
    vida_util_vencida: vida !== null && meses > vida,
    mantenimientos: ordenados.length,
    proximo_mantenimiento: proximoMantenimiento,
    ultimo_mantenimiento: ultimo
      ? {
        id: ultimo.id,
        tipo: ultimo.tipo,
        fecha: ultimo.fecha,
        estado: ultimo.estado,
      }
      : null,
  };
}

function mantenimientosDe(activoId) {
  return store.state.mantenimientos
    .filter((item) => item.activo_id === Number(activoId))
    .sort((a, b) => b.id - a.id);
}

async function mantenimientosPorActivo(activoIds) {
  const ids = [...new Set(activoIds.map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  if (ids.length === 0) {
    return new Map();
  }
  const { data } = await repository.list('mantenimientos', {
    filters: { activo_id: ids },
    orderBy: 'id',
    ascending: false,
    limit: 1000,
  });
  const mapa = new Map();
  for (const mantenimiento of data || []) {
    const lista = mapa.get(mantenimiento.activo_id) || [];
    lista.push(mantenimientoDTO(mantenimiento));
    mapa.set(mantenimiento.activo_id, lista);
  }
  return mapa;
}

function filtrosActivo(query = {}) {
  const categoria = query.categoria
    ? requiredEnum(query.categoria, 'categoria', CATEGORIAS)
    : null;
  const estado = query.estado ? requiredEnum(query.estado, 'estado', ESTADOS) : null;
  const q = query.q ? String(query.q).trim() : '';
  const { campo, ascending } = parseSort(query.sort, CAMPOS_ORDEN, 'id:desc', 'sort');
  const after = optionalAfter(query);
  return { categoria, estado, q, sort: campo, ascending, after };
}

function listActivosMemoria(filtros, query) {
  const buscado = filtros.q.toLowerCase();
  const filtrados = store.state.activos
    .filter((activo) => !filtros.categoria || activo.categoria === filtros.categoria)
    .filter((activo) => !filtros.estado || activo.estado === filtros.estado)
    .filter((activo) => !filtros.after || Number(activo.id) > filtros.after)
    .filter((activo) => !buscado || String(activo.nombre).toLowerCase().includes(buscado));

  const ordenados = ordenar(filtrados, filtros.sort, filtros.ascending);
  const data = ordenados.map((activo) => activoDTO(activo, mantenimientosDe(activo.id)));
  return paginate(data, query, { cursor: true });
}

async function listActivosSupabase(filtros, query) {
  const { page, limit } = pageParams(query);

  let consulta = repository.table('activos').select('*', { count: 'exact' });
  if (filtros.after) {
    consulta = consulta.gt('id', filtros.after);
  }
  if (filtros.categoria) {
    consulta = consulta.eq('categoria', filtros.categoria);
  }
  if (filtros.estado) {
    consulta = consulta.eq('estado', filtros.estado);
  }
  if (filtros.q) {
    consulta = consulta.ilike('nombre', `%${filtros.q}%`);
  }
  consulta = consulta
    .order(filtros.sort, { ascending: filtros.ascending })
    .order('id', { ascending: false });

  const inicio = (page - 1) * limit;
  const { data, error, count } = await consulta.range(inicio, inicio + limit - 1);
  if (error) {
    throw db.persistenceError('No se pudieron listar los activos.', error);
  }

  const filas = data || [];
  const mapa = await mantenimientosPorActivo(filas.map((activo) => activo.id));
  const total = typeof count === 'number' ? count : filas.length;
  const salida = filas.map((activo) => activoDTO(activo, mapa.get(activo.id) || []));
  return {
    data: salida,
    meta: metaPaginada({ page, limit, total }, salida, inicio),
  };
}

async function listActivos(query = {}) {
  const filtros = filtrosActivo(query);
  if (db.isSupabase()) {
    return listActivosSupabase(filtros, query);
  }
  return listActivosMemoria(filtros, query);
}

async function getActivo(id) {
  const activo = await db.findOrThrow('activos', parseId(id), 'Activo');
  if (!db.isSupabase()) {
    return {
      ...activoDTO(activo, mantenimientosDe(activo.id)),
      historial: mantenimientosDe(activo.id),
    };
  }
  const { data } = await repository.list('mantenimientos', {
    filters: { activo_id: activo.id },
    orderBy: 'id',
    ascending: false,
    limit: 1000,
  });
  const historial = (data || []).map(mantenimientoDTO);
  return { ...activoDTO(activo, historial), historial };
}

async function crearActivo(body, usuario) {
  const payload = requiredObject(body);

  const base = {
    nombre: requiredString(payload.nombre, 'nombre', { max: 120 }),
    categoria: requiredEnum(payload.categoria, 'categoria', CATEGORIAS),
    cantidad: requiredInt(payload.cantidad, 'cantidad', { min: 1 }),
    costo_adquisicion: requiredNumber(payload.costo_adquisicion, 'costo_adquisicion', { min: 0 }),
    vida_util_meses: payload.vida_util_meses === undefined || payload.vida_util_meses === null
      ? null
      : requiredInt(payload.vida_util_meses, 'vida_util_meses', { min: 1 }),
    fecha_adquisicion: optionalDate(payload.fecha_adquisicion, 'fecha_adquisicion') || db.today(),
    estado: 'activo',
    fecha_baja: null,
    motivo_baja: null,
    usuario_id: usuario.id,
  };

  if (!db.isSupabase()) {
    const activo = {
      id: store.nextId('activos'),
      ...base,
      creado_en: store.nowIso(),
      actualizado_en: store.nowIso(),
    };
    store.state.activos.push(activo);
    return activoDTO(activo, []);
  }

  let creado;
  try {
    creado = await repository.insert('activos', base);
  } catch (error) {
    throw db.persistenceError('No se pudo registrar el activo.', error);
  }
  return activoDTO(creado, []);
}

async function actualizarActivo(id, body) {
  const activo = await db.findOrThrow('activos', parseId(id), 'Activo');
  const payload = requiredObject(body);

  const patch = {};
  if (payload.nombre !== undefined) {
    patch.nombre = requiredString(payload.nombre, 'nombre', { max: 120 });
  }
  if (payload.categoria !== undefined) {
    patch.categoria = requiredEnum(payload.categoria, 'categoria', CATEGORIAS);
  }
  if (payload.cantidad !== undefined) {
    patch.cantidad = requiredInt(payload.cantidad, 'cantidad', { min: 1 });
  }
  if (payload.costo_adquisicion !== undefined) {
    patch.costo_adquisicion = requiredNumber(payload.costo_adquisicion, 'costo_adquisicion', { min: 0 });
  }
  if (payload.vida_util_meses !== undefined) {
    patch.vida_util_meses = payload.vida_util_meses === null
      ? null
      : requiredInt(payload.vida_util_meses, 'vida_util_meses', { min: 1 });
  }
  if (payload.estado !== undefined) {
    patch.estado = requiredEnum(payload.estado, 'estado', ESTADOS);
  }
  if (payload.motivo_baja !== undefined) {
    patch.motivo_baja = optionalString(payload.motivo_baja, 'motivo_baja', { max: 300 });
  }
  if (payload.fecha_baja !== undefined) {
    patch.fecha_baja = payload.fecha_baja === null || payload.fecha_baja === ''
      ? null
      : (optionalDate(payload.fecha_baja, 'fecha_baja') || null);
  }
  if (payload.fecha_adquisicion !== undefined) {
    patch.fecha_adquisicion = optionalDate(payload.fecha_adquisicion, 'fecha_adquisicion')
      || activo.fecha_adquisicion;
  }

  const estadoFinal = patch.estado === undefined ? activo.estado : patch.estado;
  if (estadoFinal === 'dado_de_baja' && !patch.fecha_baja) {
    // chk_activo_baja exige fecha_baja cuando el estado es dado_de_baja.
    patch.fecha_baja = activo.fecha_baja || db.today();
  }

  if (!db.isSupabase()) {
    Object.assign(activo, patch);
    activo.actualizado_en = store.nowIso();
    return activoDTO(activo, mantenimientosDe(activo.id));
  }

  if (Object.keys(patch).length === 0) {
    const mapa = await mantenimientosPorActivo([activo.id]);
    return activoDTO(activo, mapa.get(activo.id) || []);
  }

  let actualizado;
  try {
    actualizado = await repository.update('activos', activo.id, patch);
  } catch (error) {
    throw db.persistenceError('No se pudo actualizar el activo.', error);
  }
  const mapa = await mantenimientosPorActivo([activo.id]);
  return activoDTO(actualizado || { ...activo, ...patch }, mapa.get(activo.id) || []);
}

function construirAlertas(activos, mantenimientos) {
  const porActivo = new Map();
  for (const mantenimiento of mantenimientos) {
    const lista = porActivo.get(mantenimiento.activo_id) || [];
    lista.push(mantenimiento);
    porActivo.set(mantenimiento.activo_id, lista);
  }
  for (const lista of porActivo.values()) {
    lista.sort((a, b) => b.id - a.id);
  }

  const alertas = [];
  for (const activo of activos) {
    if (activo.estado === 'en_reparacion') {
      alertas.push({
        activo_id: activo.id,
        activo: activo.nombre,
        tipo: 'dano',
        severidad: 'alta',
        mensaje: 'Activo en reparación; revisar autorización y costos.',
      });
    }

    const vida = activo.vida_util_meses === null || activo.vida_util_meses === undefined
      ? null
      : Number(activo.vida_util_meses);
    if (vida !== null && mesesEntre(activo.fecha_adquisicion) > vida) {
      alertas.push({
        activo_id: activo.id,
        activo: activo.nombre,
        tipo: 'vida_util',
        severidad: 'media',
        mensaje: 'Vida útil superada; evaluar reemplazo.',
      });
    }

    for (const mantenimiento of porActivo.get(activo.id) || []) {
      if (mantenimiento.estado !== 'programado' || !mantenimiento.programada_para) {
        continue;
      }
      const dias = Math.round(
        (Date.parse(`${mantenimiento.programada_para}T00:00:00`) - Date.now()) / 86400000,
      );
      if (dias <= 30) {
        alertas.push({
          activo_id: activo.id,
          activo: activo.nombre,
          mantenimiento_id: mantenimiento.id,
          tipo: 'mantenimiento_preventivo',
          severidad: dias < 0 ? 'alta' : 'media',
          mensaje: dias < 0
            ? `Mantenimiento preventivo vencido hace ${Math.abs(dias)} días.`
            : `Mantenimiento preventivo en ${dias} días.`,
        });
      }
    }
  }
  return alertas;
}

async function alertasActivos(query = {}) {
  const severidadFiltro = query.severidad ? String(query.severidad) : null;

  if (!db.isSupabase()) {
    const alertas = construirAlertas(store.state.activos, store.state.mantenimientos);
    const data = severidadFiltro ? alertas.filter((item) => item.severidad === severidadFiltro) : alertas;
    return { data, meta: { total: data.length, generado_en: store.nowIso() } };
  }

  const { data: activos } = await repository.list('activos', {
    orderBy: 'id',
    ascending: true,
    limit: 1000,
  });
  const { data: mantenimientos } = await repository.list('mantenimientos', {
    orderBy: 'id',
    ascending: true,
    limit: 1000,
  });
  const alertas = construirAlertas(activos || [], mantenimientos || []);
  const data = severidadFiltro ? alertas.filter((item) => item.severidad === severidadFiltro) : alertas;
  return { data, meta: { total: data.length, generado_en: db.nowIso() } };
}

async function listMantenimientos(activoId) {
  const id = parseId(activoId, 'activo_id');
  await db.findOrThrow('activos', id, 'Activo');

  if (!db.isSupabase()) {
    const data = mantenimientosDe(id);
    return { data, meta: { total: data.length } };
  }

  const { data } = await repository.list('mantenimientos', {
    filters: { activo_id: id },
    orderBy: 'id',
    ascending: false,
    limit: 1000,
  });
  const filas = (data || []).map(mantenimientoDTO);
  return { data: filas, meta: { total: filas.length } };
}

async function crearMantenimiento(id, body, usuario) {
  const activo = await db.findOrThrow('activos', parseId(id), 'Activo');
  const payload = requiredObject(body);
  const tipo = requiredEnum(payload.tipo, 'tipo', TIPOS_MANT);
  const decision = payload.decision ? requiredEnum(payload.decision, 'decision', DECISIONES) : null;

  if (db.isSupabase() && tipo === 'correctivo' && !decision) {
    throw new AppError(
      422,
      'BUSINESS_RULE_VIOLATION',
      'Un mantenimiento correctivo requiere decisión (reparar o reemplazar) por la restricción chk_mant_correctivo.',
      [{ field: 'decision' }],
    );
  }

  const mantenimiento = {
    activo_id: activo.id,
    tipo,
    fecha: optionalDate(payload.fecha, 'fecha') || db.today(),
    programada_para: optionalDate(payload.programada_para, 'programada_para') || null,
    descripcion: requiredString(payload.descripcion, 'descripcion', { max: 300 }),
    costo_reparacion: payload.costo_reparacion === undefined
      ? 0
      : requiredNumber(payload.costo_reparacion, 'costo_reparacion', { min: 0 }),
    costo_reposicion: payload.costo_reposicion === undefined
      ? 0
      : requiredNumber(payload.costo_reposicion, 'costo_reposicion', { min: 0 }),
    decision,
    estado: 'programado',
    usuario_id: usuario.id,
  };

  if (!db.isSupabase()) {
    const registro = {
      id: store.nextId('mantenimientos'),
      ...mantenimiento,
      fecha_autorizacion: null,
      creado_en: store.nowIso(),
    };
    store.state.mantenimientos.push(registro);
    return registro;
  }

  let creado;
  try {
    creado = await repository.insert('mantenimientos', mantenimiento);
  } catch (error) {
    throw db.persistenceError('No se pudo registrar el mantenimiento.', error);
  }
  return mantenimientoDTO(creado);
}

async function autorizarMantenimientoSupabase(mantenimiento, payload) {
  const activo = await db.findOrThrow('activos', mantenimiento.activo_id, 'Activo');

  const sugerida = aNumero(mantenimiento.costo_reparacion) < aNumero(mantenimiento.costo_reposicion)
    ? 'reparar'
    : 'reemplazar';
  const decision = payload.decision
    ? requiredEnum(payload.decision, 'decision', DECISIONES)
    : sugerida;

  const patchMantenimiento = {
    decision,
    estado: decision === 'reparar' ? 'en_proceso' : 'completado',
    fecha_autorizacion: db.nowIso(),
  };

  let actualizado;
  try {
    actualizado = await repository.update('mantenimientos', mantenimiento.id, patchMantenimiento);
  } catch (error) {
    throw db.persistenceError('No se pudo autorizar el mantenimiento.', error);
  }

  const patchActivo = decision === 'reparar'
    ? { estado: 'en_reparacion' }
    : {
      estado: 'dado_de_baja',
      fecha_baja: db.today(),
      motivo_baja: `Reemplazado por mantenimiento #${mantenimiento.id}`,
    };

  let activoActualizado;
  try {
    activoActualizado = await repository.update('activos', activo.id, patchActivo);
  } catch (error) {
    // Compensación: se revierte el mantenimiento a su estado previo.
    try {
      await repository.update('mantenimientos', mantenimiento.id, {
        decision: mantenimiento.decision,
        estado: mantenimiento.estado,
      });
    } catch (compensacionError) {
      error.compensacion = compensacionError.message;
    }
    throw db.persistenceError('No se pudo actualizar el activo del mantenimiento.', error);
  }

  const mapa = await mantenimientosPorActivo([activo.id]);
  const activoFinal = activoActualizado || { ...activo, ...patchActivo };
  return {
    mantenimiento: mantenimientoDTO(
      actualizado || { ...mantenimiento, ...patchMantenimiento },
    ),
    activo: activoDTO(activoFinal, mapa.get(activo.id) || []),
    sugerencia: sugerida,
    coincide_regla: decision === sugerida,
  };
}

async function autorizarMantenimiento(id, body) {
  const mantenimiento = await db.findOrThrow('mantenimientos', parseId(id), 'Mantenimiento');
  const payload = requiredObject(body);

  if (db.isSupabase()) {
    return autorizarMantenimientoSupabase(mantenimiento, payload);
  }

  const activo = store.findOrThrow('activos', mantenimiento.activo_id, 'Activo');

  const sugerida = mantenimiento.costo_reparacion < mantenimiento.costo_reposicion
    ? 'reparar'
    : 'reemplazar';
  const decision = payload.decision
    ? requiredEnum(payload.decision, 'decision', DECISIONES)
    : sugerida;

  mantenimiento.decision = decision;
  mantenimiento.estado = decision === 'reparar' ? 'en_proceso' : 'completado';
  mantenimiento.fecha_autorizacion = store.nowIso();

  if (decision === 'reparar') {
    activo.estado = 'en_reparacion';
  } else {
    activo.estado = 'dado_de_baja';
    activo.fecha_baja = store.today();
    activo.motivo_baja = `Reemplazado por mantenimiento #${mantenimiento.id}`;
  }
  activo.actualizado_en = store.nowIso();

  return {
    mantenimiento,
    activo: activoDTO(activo, mantenimientosDe(activo.id)),
    sugerencia: sugerida,
    coincide_regla: decision === sugerida,
  };
}

module.exports = {
  CATEGORIAS,
  ESTADOS,
  listActivos,
  getActivo,
  crearActivo,
  actualizarActivo,
  alertasActivos,
  listMantenimientos,
  crearMantenimiento,
  autorizarMantenimiento,
};
