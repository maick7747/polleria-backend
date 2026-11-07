'use strict';

const store = require('../../data/store');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredString,
  requiredNumber,
  requiredEnum,
  optionalString,
  optionalDate,
  paginate,
  parseId,
} = require('../../middleware/validate');

const RESOLUCIONES = ['re_preparar', 'corregir', 'reembolso_total', 'reembolso_parcial'];
const METODOS_REEMBOLSO = ['efectivo', 'tarjeta', 'yape', 'plin', 'transferencia'];

function enriquecerDevolucion(devolucion) {
  const pedido = store.find('pedidos', devolucion.pedido_id);
  const merma = devolucion.merma_id ? store.find('mermas', devolucion.merma_id) : null;
  const detalle = devolucion.pedido_detalle_id
    ? store.find('pedido_detalles', devolucion.pedido_detalle_id)
    : null;
  const platillo = detalle ? store.find('platillos', detalle.platillo_id) : null;

  return {
    ...devolucion,
    pedido_numero: pedido ? pedido.numero : null,
    pedido_total: pedido ? pedido.total : null,
    platillo: platillo ? platillo.nombre : null,
    merma: merma ? { id: merma.id, estado: merma.estado, costo_estimado: merma.costo_estimado } : null,
    reembolsos: store.state.reembolsos.filter((item) => item.devolucion_id === devolucion.id),
  };
}

function listDevoluciones(query = {}) {
  const estado = query.estado
    ? requiredEnum(query.estado, 'estado', ['pendiente', 'aceptada', 'rechazada'])
    : null;
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');

  const data = store.state.devoluciones
    .filter((item) => !estado || item.estado === estado)
    .filter((item) => !desde || item.fecha_reporte.slice(0, 10) >= desde)
    .filter((item) => !hasta || item.fecha_reporte.slice(0, 10) <= hasta)
    .sort((a, b) => b.id - a.id)
    .map(enriquecerDevolucion);

  return paginate(data, query);
}

function getDevolucion(id) {
  return enriquecerDevolucion(store.findOrThrow('devoluciones', parseId(id), 'Devolución'));
}

function crearDevolucion(body, usuario) {
  const payload = requiredObject(body);
  const pedidoId = requiredNumber(payload.pedido_id, 'pedido_id', { min: 1 });
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
    pedido_id: pedido.id,
    pedido_detalle_id: detalleId,
    fecha_reporte: store.nowIso(),
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
    registrado_por_id: usuario.id,
    creado_en: store.nowIso(),
  };
  store.state.devoluciones.push(devolucion);
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

function resolverDevolucion(id, body, usuario) {
  const devolucion = store.findOrThrow('devoluciones', parseId(id), 'Devolución');
  const payload = requiredObject(body);
  const estado = requiredEnum(payload.estado, 'estado', ['aceptada', 'rechazada']);

  if (devolucion.estado !== 'pendiente') {
    throw new AppError(409, 'CONFLICT', 'La devolución ya fue resuelta.');
  }

  if (estado === 'rechazada') {
    devolucion.estado = 'rechazada';
    devolucion.decidido_por_id = usuario.id;
    devolucion.fecha_resolucion = store.nowIso();
    devolucion.detalle_resolucion = optionalString(payload.detalle, 'detalle', { max: 1000 });
    return enriquecerDevolucion(devolucion);
  }

  const resolucion = requiredEnum(payload.resolucion, 'resolucion', RESOLUCIONES);
  devolucion.estado = 'aceptada';
  devolucion.resolucion = resolucion;
  devolucion.decidido_por_id = usuario.id;
  devolucion.fecha_resolucion = store.nowIso();
  devolucion.monto_reembolsado = payload.monto_reembolsado === undefined
    ? 0
    : requiredNumber(payload.monto_reembolsado, 'monto_reembolsado', { min: 0 });

  if (resolucion !== 'corregir') {
    const merma = crearMermaPorDevolucion(devolucion, usuario);
    if (merma) {
      devolucion.merma_id = merma.id;
    }
  }

  return enriquecerDevolucion(devolucion);
}

function registrarReembolso(id, body, usuario) {
  const devolucion = store.findOrThrow('devoluciones', parseId(id), 'Devolución');
  const payload = requiredObject(body);

  if (devolucion.estado !== 'aceptada') {
    throw new AppError(409, 'CONFLICT', 'Solo se reembolsa una devolución aceptada.');
  }
  if (!['reembolso_total', 'reembolso_parcial'].includes(devolucion.resolucion)) {
    throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'La resolución no contempla reembolso.');
  }

  const metodo = requiredEnum(payload.metodo, 'metodo', METODOS_REEMBOLSO);
  const monto = requiredNumber(payload.monto, 'monto', { min: 0.01 });

  const reembolso = {
    id: store.nextId('reembolsos'),
    devolucion_id: devolucion.id,
    pedido_id: devolucion.pedido_id,
    metodo,
    monto: store.round2(monto),
    referencia: optionalString(payload.referencia, 'referencia', { max: 60 }),
    estado: optionalString(payload.estado, 'estado', { max: 30 }) || 'registrado',
    fecha: store.nowIso(),
    usuario_id: usuario.id,
  };
  store.state.reembolsos.push(reembolso);
  devolucion.monto_reembolsado = store.round2(devolucion.monto_reembolsado + reembolso.monto);

  return {
    reembolso,
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
