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

const CATEGORIAS = [
  'servicios_basicos',
  'alquiler',
  'mantenimiento',
  'personal',
  'transporte',
  'limpieza',
  'impuestos',
  'otros',
];
const METODOS = ['efectivo', 'tarjeta', 'yape', 'plin', 'transferencia'];

function enriquecerGasto(gasto) {
  const usuario = store.find('usuarios', gasto.usuario_id);
  return { ...gasto, registrado_por: usuario ? usuario.nombre : null };
}

function listGastos(query = {}) {
  const categoria = query.categoria ? requiredEnum(query.categoria, 'categoria', CATEGORIAS) : null;
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');

  const data = store.state.gastos
    .filter((gasto) => !categoria || gasto.categoria === categoria)
    .filter((gasto) => !desde || gasto.fecha >= desde)
    .filter((gasto) => !hasta || gasto.fecha <= hasta)
    .sort((a, b) => `${b.fecha}-${b.id}`.localeCompare(`${a.fecha}-${a.id}`))
    .map(enriquecerGasto);

  return paginate(data, query);
}

function getGasto(id) {
  return enriquecerGasto(store.findOrThrow('gastos', parseId(id), 'Gasto'));
}

function crearGasto(body, usuario) {
  const payload = requiredObject(body);
  store.requireCajaAbierta();

  const gasto = {
    id: store.nextId('gastos'),
    fecha: optionalDate(payload.fecha, 'fecha') || store.today(),
    categoria: requiredEnum(payload.categoria, 'categoria', CATEGORIAS),
    descripcion: requiredString(payload.descripcion, 'descripcion', { max: 200 }),
    monto: requiredNumber(payload.monto, 'monto', { min: 0.01 }),
    metodo_pago: requiredEnum(payload.metodo_pago, 'metodo_pago', METODOS),
    descuenta_caja_chica: payload.descuenta_caja_chica === undefined
      ? true
      : Boolean(payload.descuenta_caja_chica),
    comprobante_url: optionalString(payload.comprobante_url, 'comprobante_url', { max: 255 }),
    usuario_id: usuario.id,
    creado_en: store.nowIso(),
  };
  store.state.gastos.push(gasto);
  return enriquecerGasto(gasto);
}

function actualizarGasto(id, body) {
  const gasto = store.findOrThrow('gastos', parseId(id), 'Gasto');
  const payload = requiredObject(body);

  if (payload.categoria !== undefined) {
    gasto.categoria = requiredEnum(payload.categoria, 'categoria', CATEGORIAS);
  }
  if (payload.descripcion !== undefined) {
    gasto.descripcion = requiredString(payload.descripcion, 'descripcion', { max: 200 });
  }
  if (payload.monto !== undefined) {
    gasto.monto = requiredNumber(payload.monto, 'monto', { min: 0.01 });
  }
  if (payload.metodo_pago !== undefined) {
    gasto.metodo_pago = requiredEnum(payload.metodo_pago, 'metodo_pago', METODOS);
  }
  if (payload.fecha !== undefined) {
    gasto.fecha = optionalDate(payload.fecha, 'fecha') || gasto.fecha;
  }
  if (payload.comprobante_url !== undefined) {
    gasto.comprobante_url = optionalString(payload.comprobante_url, 'comprobante_url', { max: 255 });
  }
  gasto.actualizado_en = store.nowIso();

  return enriquecerGasto(gasto);
}

function resumenGastos(query = {}) {
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');

  const filtered = store.state.gastos
    .filter((gasto) => !desde || gasto.fecha >= desde)
    .filter((gasto) => !hasta || gasto.fecha <= hasta);

  const porCategoria = CATEGORIAS.map((categoria) => {
    const items = filtered.filter((gasto) => gasto.categoria === categoria);
    return {
      categoria,
      registros: items.length,
      total: store.round2(items.reduce((sum, gasto) => sum + gasto.monto, 0)),
    };
  }).filter((item) => item.registros > 0);

  return {
    desde: desde || null,
    hasta: hasta || null,
    total: store.round2(filtered.reduce((sum, gasto) => sum + gasto.monto, 0)),
    registros: filtered.length,
    por_categoria: porCategoria,
  };
}

module.exports = {
  CATEGORIAS,
  METODOS,
  listGastos,
  getGasto,
  crearGasto,
  actualizarGasto,
  resumenGastos,
};
