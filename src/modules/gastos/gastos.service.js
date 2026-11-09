'use strict';

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const {
  requiredObject,
  requiredString,
  requiredNumber,
  requiredEnum,
  optionalString,
  optionalDate,
  paginate,
  pageParams,
  parseId,
  parseSort,
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
const CAMPOS_ORDEN_GASTO = ['id', 'fecha', 'monto', 'categoria'];

function aNumero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function valorOrden(fila, campo) {
  if (campo === 'id' || campo === 'monto') {
    return aNumero(fila[campo]);
  }
  const valor = fila[campo];
  return valor === null || valor === undefined ? '' : String(valor);
}

// Desempate por id descendente: mismo criterio que el listado histórico
// (`fecha-id` comparado como texto), ahora explícito y estable en la página.
function ordenarGastos(filas, campo, ascending) {
  const direccion = ascending ? 1 : -1;
  return [...filas].sort((izq, der) => {
    const a = valorOrden(izq, campo);
    const b = valorOrden(der, campo);
    if (a < b) return -1 * direccion;
    if (a > b) return 1 * direccion;
    return aNumero(der.id) - aNumero(izq.id);
  });
}

function gastoDTO(gasto, nombreUsuario) {
  return {
    ...gasto,
    monto: db.round2(aNumero(gasto.monto)),
    registrado_por: nombreUsuario === undefined ? null : nombreUsuario,
  };
}

function filtrosGastos(query = {}) {
  const categoria = query.categoria ? requiredEnum(query.categoria, 'categoria', CATEGORIAS) : null;
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');
  const q = query.q ? String(query.q).trim() : '';
  const { campo, ascending } = parseSort(query.sort, CAMPOS_ORDEN_GASTO, 'fecha:desc', 'sort');
  return { categoria, desde, hasta, q, sort: campo, ascending };
}

function listGastosMemoria(filtros, query) {
  const buscado = filtros.q.toLowerCase();
  const filtrados = store.state.gastos
    .filter((gasto) => !filtros.categoria || gasto.categoria === filtros.categoria)
    .filter((gasto) => !filtros.desde || gasto.fecha >= filtros.desde)
    .filter((gasto) => !filtros.hasta || gasto.fecha <= filtros.hasta)
    .filter(
      (gasto) =>
        !buscado || String(gasto.descripcion || '').toLowerCase().includes(buscado),
    );

  const ordenados = ordenarGastos(filtrados, filtros.sort, filtros.ascending);
  const data = ordenados.map((gasto) => {
    const usuario = store.find('usuarios', gasto.usuario_id);
    return gastoDTO(gasto, usuario ? usuario.nombre : null);
  });

  return paginate(data, query);
}

async function listGastosSupabase(filtros, query) {
  const { page, limit } = pageParams(query);

  let consulta = repository.table('gastos').select('*', { count: 'exact' });
  if (filtros.categoria) {
    consulta = consulta.eq('categoria', filtros.categoria);
  }
  if (filtros.desde) {
    consulta = consulta.gte('fecha', filtros.desde);
  }
  if (filtros.hasta) {
    consulta = consulta.lte('fecha', filtros.hasta);
  }
  if (filtros.q) {
    consulta = consulta.ilike('descripcion', `%${filtros.q}%`);
  }
  consulta = consulta
    .order(filtros.sort, { ascending: filtros.ascending })
    .order('id', { ascending: false });

  const inicio = (page - 1) * limit;
  const { data, error, count } = await consulta.range(inicio, inicio + limit - 1);
  if (error) {
    throw db.persistenceError('No se pudieron listar los gastos.', error);
  }

  const gastos = data || [];
  const usuarioIds = [...new Set(gastos.map((gasto) => gasto.usuario_id))];
  const usuarios = usuarioIds.length
    ? await repository.list('usuarios', { select: 'id, nombre', filters: { id: usuarioIds }, limit: 1000 })
    : { data: [] };
  const nombres = new Map((usuarios.data || []).map((usuario) => [usuario.id, usuario.nombre]));

  const total = typeof count === 'number' ? count : gastos.length;
  return {
    data: gastos.map((gasto) => gastoDTO(gasto, nombres.get(gasto.usuario_id) || null)),
    meta: { page, limit, total, pages: total === 0 ? 0 : Math.ceil(total / limit) },
  };
}

async function listGastos(query = {}) {
  const filtros = filtrosGastos(query);
  if (db.isSupabase()) {
    return listGastosSupabase(filtros, query);
  }
  return listGastosMemoria(filtros, query);
}

async function getGasto(id) {
  const gasto = await db.findOrThrow('gastos', parseId(id), 'Gasto');
  if (!db.isSupabase()) {
    const usuario = store.find('usuarios', gasto.usuario_id);
    return gastoDTO(gasto, usuario ? usuario.nombre : null);
  }
  const usuario = await repository.getById('usuarios', gasto.usuario_id);
  return gastoDTO(gasto, usuario ? usuario.nombre : null);
}

async function crearGasto(body, usuario) {
  const payload = requiredObject(body);
  await db.requireCajaAbierta();

  const gasto = {
    fecha: optionalDate(payload.fecha, 'fecha') || db.today(),
    categoria: requiredEnum(payload.categoria, 'categoria', CATEGORIAS),
    descripcion: requiredString(payload.descripcion, 'descripcion', { max: 200 }),
    monto: requiredNumber(payload.monto, 'monto', { min: 0.01 }),
    metodo_pago: requiredEnum(payload.metodo_pago, 'metodo_pago', METODOS),
    descuenta_caja_chica: payload.descuenta_caja_chica === undefined
      ? true
      : Boolean(payload.descuenta_caja_chica),
    comprobante_url: optionalString(payload.comprobante_url, 'comprobante_url', { max: 255 }),
    usuario_id: usuario.id,
  };

  if (!db.isSupabase()) {
    const registro = { id: store.nextId('gastos'), ...gasto, creado_en: store.nowIso() };
    store.state.gastos.push(registro);
    const registrado = store.find('usuarios', registro.usuario_id);
    return gastoDTO(registro, registrado ? registrado.nombre : null);
  }

  let creado;
  try {
    creado = await repository.insert('gastos', gasto);
  } catch (error) {
    throw db.persistenceError('No se pudo registrar el gasto.', error);
  }

  let nombreRegistrado = usuario.nombre || null;
  if (!nombreRegistrado) {
    const fila = await repository.getById('usuarios', usuario.id);
    nombreRegistrado = fila ? fila.nombre : null;
  }
  return gastoDTO(creado, nombreRegistrado);
}

async function actualizarGasto(id, body) {
  const gasto = await db.findOrThrow('gastos', parseId(id), 'Gasto');
  const payload = requiredObject(body);

  const patch = {};
  if (payload.categoria !== undefined) {
    patch.categoria = requiredEnum(payload.categoria, 'categoria', CATEGORIAS);
  }
  if (payload.descripcion !== undefined) {
    patch.descripcion = requiredString(payload.descripcion, 'descripcion', { max: 200 });
  }
  if (payload.monto !== undefined) {
    patch.monto = requiredNumber(payload.monto, 'monto', { min: 0.01 });
  }
  if (payload.metodo_pago !== undefined) {
    patch.metodo_pago = requiredEnum(payload.metodo_pago, 'metodo_pago', METODOS);
  }
  if (payload.fecha !== undefined) {
    patch.fecha = optionalDate(payload.fecha, 'fecha') || gasto.fecha;
  }
  if (payload.comprobante_url !== undefined) {
    patch.comprobante_url = optionalString(payload.comprobante_url, 'comprobante_url', { max: 255 });
  }

  if (!db.isSupabase()) {
    Object.assign(gasto, patch);
    gasto.actualizado_en = store.nowIso();
    const usuario = store.find('usuarios', gasto.usuario_id);
    return gastoDTO(gasto, usuario ? usuario.nombre : null);
  }

  // `gastos` no tiene columna actualizado_en en el esquema v1: la marca de
  // tiempo la aporta la base cuando exista el trigger; aquí no se inventa.
  if (Object.keys(patch).length === 0) {
    // Sin campos no se emite un UPDATE vacío (PostgREST lo rechaza).
    const actual = await repository.getById('usuarios', gasto.usuario_id);
    return gastoDTO(gasto, actual ? actual.nombre : null);
  }

  let actualizado;
  try {
    actualizado = await repository.update('gastos', gasto.id, patch);
  } catch (error) {
    throw db.persistenceError('No se pudo actualizar el gasto.', error);
  }
  const usuario = await repository.getById('usuarios', gasto.usuario_id);
  return gastoDTO(actualizado || { ...gasto, ...patch }, usuario ? usuario.nombre : null);
}

// PostgREST limita la respuesta a 1000 filas; el resumen debe cubrir todo el
// rango, así que se recorre por lotes.
async function todasLasFilas(crearConsulta) {
  const tamano = 1000;
  const filas = [];
  for (let inicio = 0; ; inicio += tamano) {
    const { data, error } = await crearConsulta().range(inicio, inicio + tamano - 1);
    if (error) {
      throw db.persistenceError('No se pudo calcular el resumen de gastos.', error);
    }
    const lote = data || [];
    filas.push(...lote);
    if (lote.length < tamano) {
      break;
    }
  }
  return filas;
}

async function resumenGastos(query = {}) {
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');

  if (!db.isSupabase()) {
    const filtrados = store.state.gastos
      .filter((gasto) => !desde || gasto.fecha >= desde)
      .filter((gasto) => !hasta || gasto.fecha <= hasta);

    const porCategoria = CATEGORIAS.map((categoria) => {
      const items = filtrados.filter((gasto) => gasto.categoria === categoria);
      return {
        categoria,
        registros: items.length,
        total: store.round2(items.reduce((sum, gasto) => sum + gasto.monto, 0)),
      };
    }).filter((item) => item.registros > 0);

    return {
      desde: desde || null,
      hasta: hasta || null,
      total: store.round2(filtrados.reduce((sum, gasto) => sum + gasto.monto, 0)),
      registros: filtrados.length,
      por_categoria: porCategoria,
    };
  }

  const filas = await todasLasFilas(() => {
    let consulta = repository.table('gastos').select('categoria, monto');
    if (desde) {
      consulta = consulta.gte('fecha', desde);
    }
    if (hasta) {
      consulta = consulta.lte('fecha', hasta);
    }
    return consulta.order('id', { ascending: true });
  });

  const acumulado = new Map();
  let total = 0;
  for (const fila of filas) {
    const monto = aNumero(fila.monto);
    total += monto;
    const actual = acumulado.get(fila.categoria) || { registros: 0, total: 0 };
    actual.registros += 1;
    actual.total += monto;
    acumulado.set(fila.categoria, actual);
  }

  const porCategoria = CATEGORIAS.map((categoria) => {
    const datos = acumulado.get(categoria) || { registros: 0, total: 0 };
    return {
      categoria,
      registros: datos.registros,
      total: db.round2(datos.total),
    };
  }).filter((item) => item.registros > 0);

  return {
    desde: desde || null,
    hasta: hasta || null,
    total: db.round2(total),
    registros: filas.length,
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
