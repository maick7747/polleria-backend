'use strict';

const store = require('../../data/store');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredString,
  requiredInt,
  requiredNumber,
  requiredEnum,
  optionalString,
  optionalDate,
  paginate,
  parseId,
} = require('../../middleware/validate');

const CATEGORIAS = ['cocina', 'salon', 'delivery', 'oficina', 'limpieza'];
const ESTADOS = ['activo', 'en_reparacion', 'dado_de_baja'];
const TIPOS_MANT = ['preventivo', 'correctivo'];
const DECISIONES = ['reparar', 'reemplazar'];

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

function mantenimientosDe(activoId) {
  return store.state.mantenimientos
    .filter((item) => item.activo_id === Number(activoId))
    .sort((a, b) => b.id - a.id);
}

function activoResumen(activo) {
  const mantenimientos = mantenimientosDe(activo.id);
  const ultimo = mantenimientos[0] || null;
  return {
    ...activo,
    antiguedad_meses: mesesEntre(activo.fecha_adquisicion),
    vida_util_vencida: activo.vida_util_meses !== null
      && mesesEntre(activo.fecha_adquisicion) > activo.vida_util_meses,
    mantenimientos: mantenimientos.length,
    ultimo_mantenimiento: ultimo
      ? { id: ultimo.id, tipo: ultimo.tipo, fecha: ultimo.fecha, estado: ultimo.estado }
      : null,
  };
}

function listActivos(query = {}) {
  const categoria = query.categoria
    ? requiredEnum(query.categoria, 'categoria', CATEGORIAS)
    : null;
  const estado = query.estado ? requiredEnum(query.estado, 'estado', ESTADOS) : null;
  const q = query.q ? String(query.q).trim().toLowerCase() : '';

  const data = store.state.activos
    .filter((activo) => !categoria || activo.categoria === categoria)
    .filter((activo) => !estado || activo.estado === estado)
    .filter((activo) => !q || activo.nombre.toLowerCase().includes(q))
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map(activoResumen);

  return paginate(data, query);
}

function getActivo(id, body) {
  const activo = store.findOrThrow('activos', parseId(id), 'Activo');
  return {
    ...activoResumen(activo),
    historial: mantenimientosDe(activo.id),
  };
}

function crearActivo(body, usuario) {
  const payload = requiredObject(body);
  const activo = {
    id: store.nextId('activos'),
    nombre: requiredString(payload.nombre, 'nombre', { max: 120 }),
    categoria: requiredEnum(payload.categoria, 'categoria', CATEGORIAS),
    cantidad: requiredInt(payload.cantidad, 'cantidad', { min: 1 }),
    costo_adquisicion: requiredNumber(payload.costo_adquisicion, 'costo_adquisicion', { min: 0 }),
    vida_util_meses: payload.vida_util_meses === undefined
      ? null
      : requiredInt(payload.vida_util_meses, 'vida_util_meses', { min: 1 }),
    fecha_adquisicion: optionalDate(payload.fecha_adquisicion, 'fecha_adquisicion') || store.today(),
    estado: 'activo',
    fecha_baja: null,
    motivo_baja: null,
    usuario_id: usuario.id,
    creado_en: store.nowIso(),
    actualizado_en: store.nowIso(),
  };
  store.state.activos.push(activo);
  return activoResumen(activo);
}

function actualizarActivo(id, body) {
  const activo = store.findOrThrow('activos', parseId(id), 'Activo');
  const payload = requiredObject(body);

  if (payload.nombre !== undefined) {
    activo.nombre = requiredString(payload.nombre, 'nombre', { max: 120 });
  }
  if (payload.categoria !== undefined) {
    activo.categoria = requiredEnum(payload.categoria, 'categoria', CATEGORIAS);
  }
  if (payload.cantidad !== undefined) {
    activo.cantidad = requiredInt(payload.cantidad, 'cantidad', { min: 1 });
  }
  if (payload.costo_adquisicion !== undefined) {
    activo.costo_adquisicion = requiredNumber(payload.costo_adquisicion, 'costo_adquisicion', { min: 0 });
  }
  if (payload.vida_util_meses !== undefined) {
    activo.vida_util_meses = payload.vida_util_meses === null
      ? null
      : requiredInt(payload.vida_util_meses, 'vida_util_meses', { min: 1 });
  }
  if (payload.estado !== undefined) {
    activo.estado = requiredEnum(payload.estado, 'estado', ESTADOS);
    if (activo.estado === 'dado_de_baja' && !activo.fecha_baja) {
      activo.fecha_baja = store.today();
    }
  }
  activo.actualizado_en = store.nowIso();
  return activoResumen(activo);
}

function alertasActivos(query = {}) {
  const severidadFiltro = query.severidad ? String(query.severidad) : null;
  const alertas = [];

  for (const activo of store.state.activos) {
    if (activo.estado === 'en_reparacion') {
      alertas.push({
        activo_id: activo.id,
        activo: activo.nombre,
        tipo: 'dano',
        severidad: 'alta',
        mensaje: 'Activo en reparación; revisar autorización y costos.',
      });
    }

    if (activo.vida_util_meses !== null && mesesEntre(activo.fecha_adquisicion) > activo.vida_util_meses) {
      alertas.push({
        activo_id: activo.id,
        activo: activo.nombre,
        tipo: 'vida_util',
        severidad: 'media',
        mensaje: 'Vida útil superada; evaluar reemplazo.',
      });
    }

    for (const mantenimiento of mantenimientosDe(activo.id)) {
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

  const data = severidadFiltro ? alertas.filter((item) => item.severidad === severidadFiltro) : alertas;
  return { data, meta: { total: data.length, generado_en: store.nowIso() } };
}

function listMantenimientos(activoId) {
  store.findOrThrow('activos', parseId(activoId), 'Activo');
  return { data: mantenimientosDe(activoId), meta: { total: mantenimientosDe(activoId).length } };
}

function crearMantenimiento(id, body, usuario) {
  const activo = store.findOrThrow('activos', parseId(id), 'Activo');
  const payload = requiredObject(body);
  const tipo = requiredEnum(payload.tipo, 'tipo', TIPOS_MANT);

  const mantenimiento = {
    id: store.nextId('mantenimientos'),
    activo_id: activo.id,
    tipo,
    fecha: optionalDate(payload.fecha, 'fecha') || store.today(),
    programada_para: optionalDate(payload.programada_para, 'programada_para') || null,
    descripcion: requiredString(payload.descripcion, 'descripcion', { max: 300 }),
    costo_reparacion: payload.costo_reparacion === undefined
      ? 0
      : requiredNumber(payload.costo_reparacion, 'costo_reparacion', { min: 0 }),
    costo_reposicion: payload.costo_reposicion === undefined
      ? 0
      : requiredNumber(payload.costo_reposicion, 'costo_reposicion', { min: 0 }),
    decision: payload.decision
      ? requiredEnum(payload.decision, 'decision', DECISIONES)
      : null,
    estado: 'programado',
    usuario_id: usuario.id,
    creado_en: store.nowIso(),
  };
  store.state.mantenimientos.push(mantenimiento);
  return mantenimiento;
}

function autorizarMantenimiento(id, body) {
  const mantenimiento = store.findOrThrow('mantenimientos', parseId(id), 'Mantenimiento');
  const payload = requiredObject(body);
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
    activo: activoResumen(activo),
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
