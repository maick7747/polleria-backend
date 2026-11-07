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

const CLASIFICACIONES = ['evitable', 'inevitable'];
const ORIGENES = ['registro_manual', 'devolucion', 'cancelacion'];

function enriquecerMerma(merma) {
  const tipo = store.find('tipos_merma', merma.tipo_merma_id);
  const insumo = merma.insumo_id ? store.find('insumos', merma.insumo_id) : null;
  const platillo = merma.platillo_id ? store.find('platillos', merma.platillo_id) : null;
  const usuario = store.find('usuarios', merma.usuario_registro_id);
  return {
    ...merma,
    tipo_merma: tipo ? tipo.nombre : null,
    insumo: insumo ? insumo.nombre : null,
    platillo: platillo ? platillo.nombre : null,
    registrado_por: usuario ? usuario.nombre : null,
  };
}

function costoEstimado({ insumo_id, platillo_id, cantidad }) {
  if (insumo_id) {
    const insumo = store.findOrThrow('insumos', insumo_id, 'Insumo');
    return store.round2(insumo.costo_promedio * cantidad);
  }

  const ficha = store.state.fichas_tecnicas.find(
    (item) => item.platillo_id === Number(platillo_id) && item.activa,
  );
  if (!ficha) {
    return 0;
  }
  const porciones = ficha.porciones_rendimiento || 1;
  return store.round2((ficha.costo_total / porciones) * cantidad);
}

function listTipos() {
  return { data: store.state.tipos_merma, meta: { total: store.state.tipos_merma.length } };
}

function listMermas(query = {}) {
  const estado = query.estado
    ? requiredEnum(query.estado, 'estado', ['pendiente', 'aprobada', 'rechazada'])
    : null;
  const tipoId = query.tipo_merma_id ? parseId(query.tipo_merma_id, 'tipo_merma_id') : null;
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');

  const data = store.state.mermas
    .filter((merma) => !estado || merma.estado === estado)
    .filter((merma) => !tipoId || merma.tipo_merma_id === tipoId)
    .filter((merma) => !desde || merma.fecha >= desde)
    .filter((merma) => !hasta || merma.fecha <= hasta)
    .sort((a, b) => b.id - a.id)
    .map(enriquecerMerma);

  return paginate(data, query);
}

function getMerma(id) {
  return enriquecerMerma(store.findOrThrow('mermas', parseId(id), 'Merma'));
}

function crearMerma(body, usuario) {
  const payload = requiredObject(body);
  const tipoId = requiredInt(payload.tipo_merma_id, 'tipo_merma_id', { min: 1 });
  store.findOrThrow('tipos_merma', tipoId, 'Tipo de merma');

  const insumoId = payload.insumo_id ? requiredInt(payload.insumo_id, 'insumo_id', { min: 1 }) : null;
  const platilloId = payload.platillo_id ? requiredInt(payload.platillo_id, 'platillo_id', { min: 1 }) : null;

  if (!insumoId && !platilloId) {
    throw new AppError(400, 'VALIDATION_ERROR', 'La merma requiere insumo_id o platillo_id.', [
      { field: 'insumo_id' },
    ]);
  }
  if (insumoId) {
    store.findOrThrow('insumos', insumoId, 'Insumo');
  }
  if (platilloId) {
    store.findOrThrow('platillos', platilloId, 'Platillo');
  }

  const cantidad = requiredNumber(payload.cantidad, 'cantidad', { min: 0.001 });
  const merma = {
    id: store.nextId('mermas'),
    tipo_merma_id: tipoId,
    insumo_id: insumoId,
    platillo_id: platilloId,
    cantidad: store.round3(cantidad),
    costo_estimado: costoEstimado({ insumo_id: insumoId, platillo_id: platilloId, cantidad }),
    clasificacion: requiredEnum(payload.clasificacion, 'clasificacion', CLASIFICACIONES),
    causa_raiz: optionalString(payload.causa_raiz, 'causa_raiz', { max: 200 }),
    motivo: requiredString(payload.motivo, 'motivo', { max: 300 }),
    fecha: optionalDate(payload.fecha, 'fecha') || store.today(),
    estado: 'pendiente',
    usuario_registro_id: usuario.id,
    usuario_aprueba_id: null,
    fecha_resolucion: null,
    observacion_resolucion: null,
    origen: payload.origen
      ? requiredEnum(payload.origen, 'origen', ORIGENES)
      : 'registro_manual',
    creado_en: store.nowIso(),
  };
  store.state.mermas.push(merma);
  return enriquecerMerma(merma);
}

function aprobarMerma(id, body, usuario) {
  const merma = store.findOrThrow('mermas', parseId(id), 'Merma');
  const payload = body && typeof body === 'object' ? body : {};

  if (merma.estado !== 'pendiente') {
    throw new AppError(409, 'MERMA_YA_RESUELTA', 'La merma ya fue aprobada o rechazada.');
  }

  const movimientos = [];

  if (merma.insumo_id) {
    movimientos.push(
      store.applyMovement({
        insumo_id: merma.insumo_id,
        tipo: 'merma',
        cantidad: merma.cantidad,
        referencia_tipo: 'merma',
        referencia_id: merma.id,
        usuario_id: usuario.id,
        observacion: `Merma aprobada: ${merma.motivo}`,
      }),
    );
  } else {
    const ficha = store.state.fichas_tecnicas.find(
      (item) => item.platillo_id === merma.platillo_id && item.activa,
    );
    if (!ficha) {
      throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'El platillo no tiene ficha técnica para descontar stock.');
    }

    const porciones = ficha.porciones_rendimiento || 1;
    const requerimientos = store.state.fichas_tecnicas_detalle
      .filter((item) => item.ficha_id === ficha.id)
      .map((item) => ({
        insumo_id: item.insumo_id,
        cantidad: store.round3((item.cantidad / porciones) * merma.cantidad),
      }));

    for (const requerimiento of requerimientos) {
      const insumo = store.findOrThrow('insumos', requerimiento.insumo_id, 'Insumo');
      if (insumo.stock_actual + 0.0005 < requerimiento.cantidad) {
        throw new AppError(409, 'STOCK_INSUFICIENTE', `No hay stock suficiente de ${insumo.nombre}.`, [
          {
            insumo_id: insumo.id,
            disponible: insumo.stock_actual,
            requerido: requerimiento.cantidad,
          },
        ]);
      }
    }

    for (const requerimiento of requerimientos) {
      movimientos.push(
        store.applyMovement({
          insumo_id: requerimiento.insumo_id,
          tipo: 'merma',
          cantidad: requerimiento.cantidad,
          referencia_tipo: 'merma',
          referencia_id: merma.id,
          usuario_id: usuario.id,
          observacion: `Merma de platillo: ${merma.motivo}`,
        }),
      );
    }
  }

  const ahora = store.nowIso();
  merma.estado = 'aprobada';
  merma.usuario_aprueba_id = usuario.id;
  merma.fecha_resolucion = ahora;
  merma.observacion_resolucion = optionalString(payload.observacion, 'observacion', { max: 300 });

  return {
    ...enriquecerMerma(merma),
    movimientos_inventario: movimientos.length,
  };
}

function rechazarMerma(id, body, usuario) {
  const merma = store.findOrThrow('mermas', parseId(id), 'Merma');
  const payload = requiredObject(body || {});

  if (merma.estado !== 'pendiente') {
    throw new AppError(409, 'MERMA_YA_RESUELTA', 'La merma ya fue aprobada o rechazada.');
  }

  merma.estado = 'rechazada';
  merma.usuario_aprueba_id = usuario.id;
  merma.fecha_resolucion = store.nowIso();
  merma.observacion_resolucion = optionalString(payload.observacion, 'observacion', { max: 300 });

  return enriquecerMerma(merma);
}

module.exports = {
  CLASIFICACIONES,
  ORIGENES,
  enriquecerMerma,
  listTipos,
  listMermas,
  getMerma,
  crearMerma,
  aprobarMerma,
  rechazarMerma,
};
