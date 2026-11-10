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

// PostgREST devuelve como máximo 1000 filas por consulta: los totales del
// cuadre se leen por lotes hasta agotar (sin topes silenciosos).
const LIMITE_FILAS = 1000;

function rangoDia(fecha) {
  const start = new Date(`${fecha}T00:00:00-05:00`);
  const end = new Date(start.getTime() + 86400000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function leerTodas(crearConsulta, mensaje) {
  const filas = [];
  for (let inicio = 0; ; inicio += LIMITE_FILAS) {
    const { data, error } = await crearConsulta().range(inicio, inicio + LIMITE_FILAS - 1);
    if (error) {
      throw db.persistenceError(mensaje, error);
    }
    const lote = data || [];
    filas.push(...lote);
    if (lote.length < LIMITE_FILAS) {
      break;
    }
  }
  return filas;
}

async function totalPagosSupabase(fecha) {
  const { start, end } = rangoDia(fecha);
  const pagos = await leerTodas(
    () => repository
      .table('pagos')
      .select('monto, metodo')
      .gte('fecha', start)
      .lt('fecha', end)
      .order('id', { ascending: true }),
    'No se pudieron leer los pagos del día.',
  );
  let efectivo = 0;
  let digital = 0;
  for (const pago of pagos) {
    const monto = Number(pago.monto) || 0;
    if (pago.metodo === 'efectivo') {
      efectivo += monto;
    } else {
      digital += monto;
    }
  }
  return {
    total: store.round2(efectivo + digital),
    efectivo: store.round2(efectivo),
    digital: store.round2(digital),
  };
}

async function totalReembolsosSupabase(fecha) {
  const { start, end } = rangoDia(fecha);
  const reembolsos = await leerTodas(
    () => repository
      .table('devoluciones')
      .select('monto_reembolsado')
      .eq('estado', 'aceptada')
      .gte('fecha_resolucion', start)
      .lt('fecha_resolucion', end)
      .order('id', { ascending: true }),
    'No se pudieron leer los reembolsos del día.',
  );
  return store.round2(
    reembolsos.reduce((sum, devolucion) => sum + Number(devolucion.monto_reembolsado || 0), 0),
  );
}

async function resumenDe(fecha, fondoInicial, efectivoContado = null, pagosDigitales = 0) {
  let totalVentas;
  let ventasEfectivo;
  let ventasDigital;
  let totalGastos;
  let totalReembolsos;

  if (!db.isSupabase()) {
    const pagosDia = store.state.pagos.filter((pago) => pago.fecha.slice(0, 10) === fecha);
    ventasEfectivo = store.round2(
      pagosDia
        .filter((pago) => pago.metodo === 'efectivo')
        .reduce((sum, pago) => sum + pago.monto, 0),
    );
    ventasDigital = store.round2(
      pagosDia
        .filter((pago) => pago.metodo !== 'efectivo')
        .reduce((sum, pago) => sum + pago.monto, 0),
    );
    totalVentas = store.round2(ventasEfectivo + ventasDigital);
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
    const [ventas, gastos, reembolsos] = await Promise.all([
      totalPagosSupabase(fecha),
      leerTodas(
        () => repository
          .table('gastos')
          .select('monto')
          .eq('fecha', fecha)
          .order('id', { ascending: true }),
        'No se pudieron leer los gastos del día.',
      ),
      totalReembolsosSupabase(fecha),
    ]);
    totalVentas = ventas.total;
    ventasEfectivo = ventas.efectivo;
    ventasDigital = ventas.digital;
    totalGastos = store.round2(
      gastos.reduce((sum, gasto) => sum + Number(gasto.monto), 0),
    );
    totalReembolsos = reembolsos;
  }

  const totalEgresos = store.round2(totalGastos + totalReembolsos);
  const montoEsperado = store.round2(Number(fondoInicial) + totalVentas - totalEgresos);
  // Desglose por canal: el efectivo esperado incluye el fondo y descuenta los
  // egresos (que salen del cajón); lo digital solo refleja cobros digitales.
  const esperadoEfectivo = store.round2(Number(fondoInicial) + ventasEfectivo - totalEgresos);
  const esperadoDigital = store.round2(ventasDigital);
  const totalReal = efectivoContado === null
    ? null
    : store.round2(Number(efectivoContado) + Number(pagosDigitales));
  const diferencia = totalReal === null ? null : store.round2(totalReal - montoEsperado);
  const diferenciaEfectivo = efectivoContado === null
    ? null
    : store.round2(Number(efectivoContado) - esperadoEfectivo);
  const diferenciaDigital = efectivoContado === null
    ? null
    : store.round2(Number(pagosDigitales) - esperadoDigital);

  return {
    total_ventas: totalVentas,
    ventas_efectivo: ventasEfectivo,
    ventas_digital: ventasDigital,
    total_gastos: totalGastos,
    total_reembolsos: totalReembolsos,
    total_egresos: totalEgresos,
    monto_esperado: montoEsperado,
    esperado_efectivo: esperadoEfectivo,
    esperado_digital: esperadoDigital,
    efectivo_contado: efectivoContado,
    pagos_digitales: store.round2(pagosDigitales),
    total_real: totalReal,
    diferencia,
    diferencia_efectivo: diferenciaEfectivo,
    diferencia_digital: diferenciaDigital,
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
    reabierto_en: cuadre.reabierto_en === undefined ? null : cuadre.reabierto_en,
    usuario_reabre_id: cuadre.usuario_reabre_id === undefined ? null : cuadre.usuario_reabre_id,
    motivo_reapertura: cuadre.motivo_reapertura === undefined ? null : cuadre.motivo_reapertura,
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

function esAdmin(usuario) {
  const roles = Array.isArray(usuario && usuario.roles) ? usuario.roles : [];
  return roles.includes('Dueño/Admin') || roles.includes('Admin');
}

async function contarCuentasAbiertas(fecha = store.today()) {
  const dia = String(fecha).slice(0, 10);
  if (!db.isSupabase()) {
    return store.state.cuentas.filter(
      (cuenta) => cuenta.estado === 'abierta' && store.fechaDe(cuenta.fecha_apertura) === dia,
    ).length;
  }
  const { start, end } = rangoDia(dia);
  const { count, error } = await repository
    .table('cuentas')
    .select('id', { count: 'exact', head: true })
    .eq('estado', 'abierta')
    .gte('fecha_apertura', start)
    .lt('fecha_apertura', end);
  if (error) {
    throw db.persistenceError('No se pudieron contar las cuentas abiertas.', error);
  }
  return Number(count) || 0;
}

async function validarCierrePermitido(cuadre, usuario) {
  if (String(cuadre.fecha).slice(0, 10) !== store.today() && !esAdmin(usuario)) {
    throw new AppError(
      403,
      'SOLO_ADMIN',
      'Solo el Dueño/Admin puede cerrar la caja de un día anterior.',
    );
  }

  const fecha = String(cuadre.fecha).slice(0, 10);
  const cantidad = await contarCuentasAbiertas(fecha);
  if (cantidad > 0) {
    throw new AppError(
      409,
      'CUENTAS_ABIERTAS',
      `Hay ${cantidad} cuentas abiertas del ${fecha}. Cóbralas o cancélalas antes de cerrar la caja.`,
      [{ cantidad, fecha }],
    );
  }
}

async function cajaAnteriorAbierta(fecha) {
  if (!db.isSupabase()) {
    return store.state.cuadres_caja
      .filter((cuadre) => cuadre.estado === 'abierta' && String(cuadre.fecha).slice(0, 10) < fecha)
      .sort((izquierda, derecha) => {
        const porFecha = String(derecha.fecha).localeCompare(String(izquierda.fecha));
        return porFecha !== 0 ? porFecha : Number(derecha.id) - Number(izquierda.id);
      })[0] || null;
  }

  const { data, error } = await repository
    .table('cuadres_caja')
    .select('*')
    .eq('estado', 'abierta')
    .lt('fecha', fecha)
    .order('fecha', { ascending: false })
    .order('id', { ascending: false })
    .limit(1);
  if (error) {
    throw db.persistenceError('No se pudo verificar la caja anterior.', error);
  }
  return (data || [])[0] || null;
}

function bloquearCajaAnterior(anterior) {
  const fecha = String(anterior.fecha).slice(0, 10);
  throw new AppError(
    409,
    'CAJA_ANTERIOR_ABIERTA',
    `La caja del ${fecha} sigue abierta. Ciérrala antes de abrir la de hoy.`,
    [{ id: anterior.id, fecha }],
  );
}

async function apertura(body, usuario) {
  const payload = requiredObject(body);
  const fecha = optionalDate(payload.fecha, 'fecha') || store.today();
  const fondoInicial = requiredNumber(payload.fondo_inicial, 'fondo_inicial', { min: 0 });
  const observaciones = optionalString(payload.observaciones, 'observaciones', { max: 300 });

  const anterior = await cajaAnteriorAbierta(fecha);
  if (anterior) {
    bloquearCajaAnterior(anterior);
  }

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
    await validarCierrePermitido(cuadre, usuario);
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
  await validarCierrePermitido(cuadre, usuario);
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

// Hora local (Lima) en formato HH:mm a partir de un ISO generado por store/db.
function horaCorta(iso) {
  const match = String(iso || '').match(/T(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : '';
}

function validarReapertura(cuadre, hoy, ayer) {
  if (cuadre.estado !== 'cerrada') {
    throw new AppError(409, 'CUADRE_NO_CERRADO', 'Solo se puede reabrir un cuadre cerrado.');
  }
  const fecha = String(cuadre.fecha).slice(0, 10);
  if (fecha !== hoy && fecha !== ayer) {
    throw new AppError(
      422,
      'CUADRE_FUERA_DE_RANGO',
      'Solo se puede reabrir el cuadre del día (o el de ayer si el cierre pasó la medianoche).',
    );
  }
}

function patchReapertura(cuadre, motivo, ahora, usuario) {
  const previas = cuadre.observaciones ? String(cuadre.observaciones).trim() : '';
  const nota = `Reabierto ${horaCorta(ahora)} · ${motivo}`.slice(0, 300);
  // La nota de reapertura siempre se conserva completa; lo que se recorta
  // (si hace falta) es el texto previo para no pasar de 300 caracteres.
  const espacio = Math.max(0, 300 - nota.length - 3);
  const recorte = previas.slice(0, espacio).trim();
  const observaciones = recorte ? `${recorte} | ${nota}` : nota;

  return {
    estado: 'abierta',
    usuario_cierre_id: null,
    fecha_cierre: null,
    efectivo_contado: null,
    pagos_digitales: 0,
    total_real: null,
    diferencia: null,
    reabierto_en: ahora,
    usuario_reabre_id: usuario && usuario.id !== undefined ? usuario.id : null,
    motivo_reapertura: motivo,
    observaciones,
  };
}

async function reabrir(id, body, usuario) {
  const payload = requiredObject(body);
  const motivo = optionalString(payload.motivo, 'motivo', { max: 300 });

  if (!motivo || motivo.length < 5) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      'El campo "motivo" es obligatorio y debe tener entre 5 y 300 caracteres.',
      [{ field: 'motivo', value: payload.motivo === undefined ? null : payload.motivo }],
    );
  }

  const hoy = store.today();
  const ayer = store.dateInDays(-1);

  if (!db.isSupabase()) {
    const cuadre = store.findOrThrow('cuadres_caja', parseId(id), 'Cuadre de caja');
    validarReapertura(cuadre, hoy, ayer);
    Object.assign(cuadre, patchReapertura(cuadre, motivo, db.nowIso(), usuario));
    return getCuadrePorId(cuadre.id);
  }

  const cuadre = await db.findOrThrow('cuadres_caja', parseId(id), 'Cuadre de caja');
  validarReapertura(cuadre, hoy, ayer);

  try {
    await repository.update('cuadres_caja', cuadre.id, patchReapertura(cuadre, motivo, db.nowIso(), usuario));
  } catch (error) {
    throw db.persistenceError('No se pudo reabrir el cuadre de caja.', error);
  }

  return getCuadrePorId(cuadre.id);
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
    reabierto_en: cuadre.reabierto_en === undefined ? null : cuadre.reabierto_en,
    usuario_reabre_id: cuadre.usuario_reabre_id === undefined ? null : cuadre.usuario_reabre_id,
    motivo_reapertura: cuadre.motivo_reapertura === undefined ? null : cuadre.motivo_reapertura,
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

async function listPendientes() {
  const hoy = store.today();
  let pendientes;

  if (!db.isSupabase()) {
    pendientes = store.state.cuadres_caja
      .filter((cuadre) => cuadre.estado === 'abierta' && String(cuadre.fecha).slice(0, 10) < hoy)
      .sort((izquierda, derecha) => {
        const porFecha = String(derecha.fecha).localeCompare(String(izquierda.fecha));
        return porFecha !== 0 ? porFecha : Number(derecha.id) - Number(izquierda.id);
      });
  } else {
    const { data, error } = await repository
      .table('cuadres_caja')
      .select('*')
      .eq('estado', 'abierta')
      .lt('fecha', hoy)
      .order('fecha', { ascending: false })
      .order('id', { ascending: false });
    if (error) {
      throw db.persistenceError('No se pudieron leer las cajas pendientes.', error);
    }
    pendientes = data || [];
  }

  const data = [];
  for (const pendiente of pendientes) {
    const cuadre = await getCuadrePorId(pendiente.id);
    data.push({
      id: cuadre.id,
      fecha: cuadre.fecha,
      estado: cuadre.estado,
      fondo_inicial: cuadre.fondo_inicial,
      total_ventas: cuadre.total_ventas,
      total_egresos: cuadre.total_egresos,
      monto_esperado: cuadre.monto_esperado,
      resumen: cuadre.resumen,
    });
  }

  return { data };
}

module.exports = {
  resumenDe,
  obtenerCuadre,
  getCuadrePorId,
  apertura,
  cierre,
  reabrir,
  resumenCuadre,
  historialCuadres,
  listPendientes,
};
