'use strict';

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredNumber,
  optionalString,
  optionalDate,
  parseId,
  pageParams,
  parseSort,
} = require('../../middleware/validate');

const CAMPOS_ORDEN_CUADRE = ['fecha', 'id', 'diferencia'];

function rangoDia(fecha) {
  const start = new Date(`${fecha}T00:00:00-05:00`);
  const end = new Date(start.getTime() + 86400000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function totalPagosSupabase(fecha) {
  const { start, end } = rangoDia(fecha);
  const { data, error } = await repository
    .table('pagos')
    .select('monto')
    .gte('fecha', start)
    .lt('fecha', end);
  if (error) {
    throw db.persistenceError('No se pudieron leer los pagos del día.', error);
  }
  return store.round2(
    data.reduce((sum, pago) => sum + Number(pago.monto), 0),
  );
}

async function totalReembolsosSupabase(fecha) {
  const { start, end } = rangoDia(fecha);
  const { data, error } = await repository
    .table('devoluciones')
    .select('monto_reembolsado')
    .eq('estado', 'aceptada')
    .gte('fecha_resolucion', start)
    .lt('fecha_resolucion', end);
  if (error) {
    throw db.persistenceError('No se pudieron leer los reembolsos del día.', error);
  }
  return store.round2(
    data.reduce((sum, devolucion) => sum + Number(devolucion.monto_reembolsado || 0), 0),
  );
}

async function resumenDe(fecha, fondoInicial, efectivoContado = null, pagosDigitales = 0) {
  let totalVentas;
  let totalGastos;
  let totalReembolsos;

  if (!db.isSupabase()) {
    totalVentas = store.round2(
      store.state.pagos
        .filter((pago) => pago.fecha.slice(0, 10) === fecha)
        .reduce((sum, pago) => sum + pago.monto, 0),
    );
    totalGastos = store.round2(
      store.state.gastos
        .filter((gasto) => gasto.fecha === fecha)
        .reduce((sum, gasto) => sum + gasto.monto, 0),
    );
    totalReembolsos = store.round2(
      store.state.reembolsos
        .filter((item) => item.fecha.slice(0, 10) === fecha)
        .reduce((sum, item) => sum + item.monto, 0),
    );
  } else {
    const [ventas, { data: gastos }, reembolsos] = await Promise.all([
      totalPagosSupabase(fecha),
      repository.list('gastos', {
        filters: { fecha },
        orderBy: 'id',
        ascending: true,
        limit: 100,
      }),
      totalReembolsosSupabase(fecha),
    ]);
    totalVentas = ventas;
    totalGastos = store.round2(
      gastos.reduce((sum, gasto) => sum + Number(gasto.monto), 0),
    );
    totalReembolsos = reembolsos;
  }

  const totalEgresos = store.round2(totalGastos + totalReembolsos);
  const montoEsperado = store.round2(Number(fondoInicial) + totalVentas - totalEgresos);
  const totalReal = efectivoContado === null
    ? null
    : store.round2(Number(efectivoContado) + Number(pagosDigitales));
  const diferencia = totalReal === null ? null : store.round2(totalReal - montoEsperado);

  return {
    total_ventas: totalVentas,
    total_gastos: totalGastos,
    total_reembolsos: totalReembolsos,
    total_egresos: totalEgresos,
    monto_esperado: montoEsperado,
    efectivo_contado: efectivoContado,
    pagos_digitales: store.round2(pagosDigitales),
    total_real: totalReal,
    diferencia,
    alerta: diferencia !== null && Math.abs(diferencia) > 0.009,
  };
}

function normalizarCuadre(cuadre, resumen) {
  return {
    ...cuadre,
    fondo_inicial: Number(cuadre.fondo_inicial),
    total_ventas: Number(cuadre.total_ventas),
    total_egresos: Number(cuadre.total_egresos),
    monto_esperado: Number(cuadre.monto_esperado),
    efectivo_contado: cuadre.efectivo_contado === null ? null : Number(cuadre.efectivo_contado),
    pagos_digitales: Number(cuadre.pagos_digitales),
    total_real: cuadre.total_real === null ? null : Number(cuadre.total_real),
    diferencia: cuadre.diferencia === null ? null : Number(cuadre.diferencia),
    resumen,
  };
}

async function obtenerCuadre(fechaParam) {
  const fecha = optionalDate(fechaParam, 'fecha') || store.today();

  if (!db.isSupabase()) {
    const cuadre = store.state.cuadres_caja.find((item) => item.fecha === fecha);
    if (!cuadre) {
      return null;
    }
    return normalizarCuadre(
      cuadre,
      await resumenDe(fecha, cuadre.fondo_inicial, cuadre.efectivo_contado, cuadre.pagos_digitales),
    );
  }

  const cuadre = await db.findOne('cuadres_caja', { fecha });
  if (!cuadre) {
    return null;
  }
  return normalizarCuadre(
    cuadre,
    await resumenDe(
      fecha,
      Number(cuadre.fondo_inicial),
      cuadre.efectivo_contado === null ? null : Number(cuadre.efectivo_contado),
      Number(cuadre.pagos_digitales),
    ),
  );
}

async function getCuadrePorId(id) {
  if (!db.isSupabase()) {
    const cuadre = store.findOrThrow('cuadres_caja', parseId(id), 'Cuadre de caja');
    return normalizarCuadre(
      cuadre,
      await resumenDe(
        cuadre.fecha,
        cuadre.fondo_inicial,
        cuadre.efectivo_contado,
        cuadre.pagos_digitales,
      ),
    );
  }

  const cuadre = await db.findOrThrow('cuadres_caja', parseId(id), 'Cuadre de caja');
  return normalizarCuadre(
    cuadre,
    await resumenDe(
      cuadre.fecha,
      Number(cuadre.fondo_inicial),
      cuadre.efectivo_contado === null ? null : Number(cuadre.efectivo_contado),
      Number(cuadre.pagos_digitales),
    ),
  );
}

async function apertura(body, usuario) {
  const payload = requiredObject(body);
  const fecha = optionalDate(payload.fecha, 'fecha') || store.today();
  const fondoInicial = requiredNumber(payload.fondo_inicial, 'fondo_inicial', { min: 0 });
  const observaciones = optionalString(payload.observaciones, 'observaciones', { max: 300 });

  if (!db.isSupabase()) {
    if (store.state.cuadres_caja.some((cuadre) => cuadre.fecha === fecha)) {
      throw new AppError(409, 'CUADRE_YA_EXISTE', 'Ya existe un cuadre de caja para esa fecha.');
    }

    const cuadre = {
      id: store.nextId('cuadres_caja'),
      fecha,
      estado: 'abierta',
      fondo_inicial: fondoInicial,
      usuario_apertura_id: usuario.id,
      fecha_apertura: store.nowIso(),
      total_ventas: 0,
      total_egresos: 0,
      monto_esperado: 0,
      efectivo_contado: null,
      pagos_digitales: 0,
      total_real: null,
      diferencia: null,
      observaciones,
      usuario_cierre_id: null,
      fecha_cierre: null,
    };
    store.state.cuadres_caja.push(cuadre);
    return getCuadrePorId(cuadre.id);
  }

  if (await db.findOne('cuadres_caja', { fecha })) {
    throw new AppError(409, 'CUADRE_YA_EXISTE', 'Ya existe un cuadre de caja para esa fecha.');
  }

  let cuadre;
  try {
    cuadre = await repository.insert('cuadres_caja', {
      fecha,
      estado: 'abierta',
      fondo_inicial: fondoInicial,
      usuario_apertura_id: usuario.id,
      fecha_apertura: db.nowIso(),
      total_ventas: 0,
      total_egresos: 0,
      monto_esperado: 0,
      pagos_digitales: 0,
      observaciones,
    });
  } catch (error) {
    if (String(error.code) === '23505') {
      throw new AppError(409, 'CUADRE_YA_EXISTE', 'Ya existe un cuadre de caja para esa fecha.');
    }
    throw db.persistenceError('No se pudo abrir el cuadre de caja.', error);
  }

  return getCuadrePorId(cuadre.id);
}

async function cierre(id, body, usuario) {
  const payload = requiredObject(body);

  if (!db.isSupabase()) {
    const cuadre = store.findOrThrow('cuadres_caja', parseId(id), 'Cuadre de caja');
    if (cuadre.estado !== 'abierta') {
      throw new AppError(409, 'CONFLICT', 'El cuadre ya está cerrado.');
    }

    const efectivo = requiredNumber(payload.efectivo_contado, 'efectivo_contado', { min: 0 });
    const digitales = payload.pagos_digitales === undefined
      ? 0
      : requiredNumber(payload.pagos_digitales, 'pagos_digitales', { min: 0 });
    const observaciones = optionalString(payload.observaciones, 'observaciones', { max: 300 });
    const resumen = await resumenDe(cuadre.fecha, cuadre.fondo_inicial, efectivo, digitales);

    if (resumen.alerta && !observaciones) {
      throw new AppError(
        422,
        'BUSINESS_RULE_VIOLATION',
        'La diferencia de caja no es cero; registre una observación.',
        [{ diferencia: resumen.diferencia, monto_esperado: resumen.monto_esperado, total_real: resumen.total_real }],
      );
    }

    cuadre.estado = 'cerrada';
    cuadre.total_ventas = resumen.total_ventas;
    cuadre.total_egresos = resumen.total_egresos;
    cuadre.monto_esperado = resumen.monto_esperado;
    cuadre.efectivo_contado = efectivo;
    cuadre.pagos_digitales = digitales;
    cuadre.total_real = resumen.total_real;
    cuadre.diferencia = resumen.diferencia;
    cuadre.observaciones = observaciones;
    cuadre.usuario_cierre_id = usuario.id;
    cuadre.fecha_cierre = store.nowIso();

    return getCuadrePorId(cuadre.id);
  }

  const cuadre = await db.findOrThrow('cuadres_caja', parseId(id), 'Cuadre de caja');
  if (cuadre.estado !== 'abierta') {
    throw new AppError(409, 'CONFLICT', 'El cuadre ya está cerrado.');
  }

  const efectivo = requiredNumber(payload.efectivo_contado, 'efectivo_contado', { min: 0 });
  const digitales = payload.pagos_digitales === undefined
    ? 0
    : requiredNumber(payload.pagos_digitales, 'pagos_digitales', { min: 0 });
  const observaciones = optionalString(payload.observaciones, 'observaciones', { max: 300 });
  const resumen = await resumenDe(cuadre.fecha, Number(cuadre.fondo_inicial), efectivo, digitales);

  if (resumen.alerta && !observaciones) {
    throw new AppError(
      422,
      'BUSINESS_RULE_VIOLATION',
      'La diferencia de caja no es cero; registre una observación.',
      [{ diferencia: resumen.diferencia, monto_esperado: resumen.monto_esperado, total_real: resumen.total_real }],
    );
  }

  try {
    await repository.update('cuadres_caja', cuadre.id, {
      estado: 'cerrada',
      total_ventas: resumen.total_ventas,
      total_egresos: resumen.total_egresos,
      monto_esperado: resumen.monto_esperado,
      efectivo_contado: efectivo,
      pagos_digitales: digitales,
      total_real: resumen.total_real,
      diferencia: resumen.diferencia,
      observaciones,
      usuario_cierre_id: usuario.id,
      fecha_cierre: db.nowIso(),
    });
  } catch (error) {
    throw db.persistenceError('No se pudo cerrar el cuadre de caja.', error);
  }

  return getCuadrePorId(cuadre.id);
}

async function resumenCuadre(id) {
  return (await getCuadrePorId(id)).resumen;
}

function cuadreFila(cuadre) {
  const numero = (valor) => (valor === null || valor === undefined ? null : Number(valor));
  return {
    ...cuadre,
    fondo_inicial: Number(cuadre.fondo_inicial) || 0,
    total_ventas: Number(cuadre.total_ventas) || 0,
    total_egresos: Number(cuadre.total_egresos) || 0,
    monto_esperado: Number(cuadre.monto_esperado) || 0,
    efectivo_contado: numero(cuadre.efectivo_contado),
    pagos_digitales: Number(cuadre.pagos_digitales) || 0,
    total_real: numero(cuadre.total_real),
    diferencia: numero(cuadre.diferencia),
  };
}

function valorOrdenCuadre(fila, campo) {
  if (campo === 'id') {
    return Number(fila.id) || 0;
  }
  if (campo === 'diferencia') {
    return fila.diferencia === null || fila.diferencia === undefined
      ? null
      : Number(fila.diferencia);
  }
  return String(fila.fecha ?? '');
}

function compararCuadres(izquierda, derecha, campo, ascending) {
  const direccion = ascending ? 1 : -1;
  const a = valorOrdenCuadre(izquierda, campo);
  const b = valorOrdenCuadre(derecha, campo);

  // Los importes nulos (cuadres abiertos) van al final sin importar el orden.
  if (a === null && b === null) {
    return Number(derecha.id) - Number(izquierda.id);
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  if (a < b) {
    return -1 * direccion;
  }
  if (a > b) {
    return 1 * direccion;
  }
  return Number(derecha.id) - Number(izquierda.id);
}

async function historialCuadres(query = {}) {
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');
  const { campo, ascending } = parseSort(
    query.sort,
    CAMPOS_ORDEN_CUADRE,
    'fecha:desc',
    'sort',
  );
  const { page, limit } = pageParams(query);
  const sort = `${campo}:${ascending ? 'asc' : 'desc'}`;

  if (!db.isSupabase()) {
    const filas = store.state.cuadres_caja
      .filter((cuadre) => !desde || String(cuadre.fecha) >= desde)
      .filter((cuadre) => !hasta || String(cuadre.fecha) <= hasta)
      .sort((izquierda, derecha) => compararCuadres(izquierda, derecha, campo, ascending))
      .map(cuadreFila);

    const total = filas.length;
    const inicio = (page - 1) * limit;
    return {
      data: filas.slice(inicio, inicio + limit),
      meta: {
        page,
        limit,
        total,
        pages: total === 0 ? 0 : Math.ceil(total / limit),
        desde: desde || null,
        hasta: hasta || null,
        sort,
      },
    };
  }

  let consulta = repository.table('cuadres_caja').select('*', { count: 'exact' });
  if (desde) {
    consulta = consulta.gte('fecha', desde);
  }
  if (hasta) {
    consulta = consulta.lte('fecha', hasta);
  }
  consulta = consulta.order(campo, { ascending });
  if (campo !== 'id') {
    consulta = consulta.order('id', { ascending: false });
  }

  const inicio = (page - 1) * limit;
  const { data, error, count } = await consulta.range(inicio, inicio + limit - 1);
  if (error) {
    throw db.persistenceError('No se pudo leer el historial de cuadres de caja.', error);
  }

  const total = typeof count === 'number' ? count : (data || []).length;
  return {
    data: (data || []).map(cuadreFila),
    meta: {
      page,
      limit,
      total,
      pages: total === 0 ? 0 : Math.ceil(total / limit),
      desde: desde || null,
      hasta: hasta || null,
      sort,
    },
  };
}

module.exports = {
  resumenDe,
  obtenerCuadre,
  getCuadrePorId,
  apertura,
  cierre,
  resumenCuadre,
  historialCuadres,
};
