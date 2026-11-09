'use strict';

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');

// PostgREST devuelve como máximo 1000 filas por consulta. Los agregados del
// día recorren la tabla por lotes de este tamaño.
const LIMITE_FILAS = 1000;

function sumBy(items, predicate, selector) {
  return store.round2(
    items.filter(predicate).reduce((total, item) => total + Number(selector(item)), 0),
  );
}

// Rango del día operativo en hora de Lima (-05:00), igual que cuadre-caja.
function rangoDia(fecha) {
  const start = new Date(`${fecha}T00:00:00-05:00`);
  const end = new Date(start.getTime() + 86400000);
  return { start: start.toISOString(), end: end.toISOString() };
}

const DIAS_SEMANA = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

// Desplaza una fecha YYYY-MM-DD en días de calendario (sin hora ni zona).
function fechaEnDias(fecha, dias) {
  const [anio, mes, dia] = String(fecha).split('-').map(Number);
  const base = new Date(Date.UTC(anio, mes - 1, dia));
  base.setUTCDate(base.getUTCDate() + Number(dias));
  return base.toISOString().slice(0, 10);
}

// Letra del día de la semana para una fecha de calendario.
function diaDeLaSemana(fecha) {
  const [anio, mes, dia] = String(fecha).split('-').map(Number);
  return DIAS_SEMANA[new Date(Date.UTC(anio, mes - 1, dia)).getUTCDay()];
}

// Fecha operativa (Lima, -05:00) de un timestamp de `pagos.fecha`.
function fechaLima(valor) {
  const texto = String(valor === null || valor === undefined ? '' : valor);
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    return texto;
  }
  const fecha = new Date(texto);
  if (Number.isNaN(fecha.getTime())) {
    return texto.slice(0, 10);
  }
  return new Date(fecha.getTime() - 5 * 3600000).toISOString().slice(0, 10);
}

function ventasDelDia(pagos, fecha) {
  return store.round2(
    pagos.reduce(
      (total, pago) => (fechaLima(pago.fecha) === fecha ? total + Number(pago.monto) : total),
      0,
    ),
  );
}

// Últimos 7 días (incluido `fecha`) con los pagos agrupados por día operativo.
function serieSemana(pagos, fecha) {
  const dias = [];
  for (let desplazamiento = 6; desplazamiento >= 0; desplazamiento -= 1) {
    const dia = fechaEnDias(fecha, -desplazamiento);
    dias.push({ fecha: dia, dia: diaDeLaSemana(dia), monto: 0 });
  }

  const posiciones = new Map(dias.map((item, indice) => [item.fecha, indice]));
  for (const pago of pagos) {
    const indice = posiciones.get(fechaLima(pago.fecha));
    if (indice === undefined) {
      continue;
    }
    dias[indice].monto = store.round2(dias[indice].monto + Number(pago.monto));
  }

  return dias;
}

// ---------------------------------------------------------------------
// DB_MODE=memory (comportamiento histórico)
// ---------------------------------------------------------------------
function getDashboardMemoria(fecha) {
  const pagos = store.state.pagos.filter((pago) => pago.fecha.slice(0, 10) === fecha);
  const gastos = store.state.gastos.filter((gasto) => gasto.fecha === fecha);
  const reembolsos = store.state.reembolsos.filter((item) => item.fecha.slice(0, 10) === fecha);
  const pedidos = store.state.pedidos.filter((pedido) => pedido.fecha_pedido.slice(0, 10) === fecha);

  // Pagos de la ventana semanal (una sola pasada en memoria).
  const desdeSemana = fechaEnDias(fecha, -6);
  const pagosSemana = store.state.pagos.filter((pago) => {
    const dia = fechaLima(pago.fecha);
    return dia >= desdeSemana && dia <= fecha;
  });
  const ventasAyer = ventasDelDia(pagosSemana, fechaEnDias(fecha, -1));

  const ventas = sumBy(pagos, () => true, (pago) => pago.monto);
  const egresos = store.round2(
    sumBy(gastos, () => true, (gasto) => gasto.monto) +
      sumBy(reembolsos, () => true, (item) => item.monto),
  );

  const detallePorPlatillo = new Map();
  const pedidosDelDia = new Set(pedidos.map((pedido) => pedido.id));
  for (const detail of store.state.pedido_detalles) {
    if (!pedidosDelDia.has(detail.pedido_id)) {
      continue;
    }
    const current = detallePorPlatillo.get(detail.platillo_id) || { cantidad: 0, monto: 0 };
    current.cantidad += detail.cantidad;
    current.monto = store.round2(current.monto + detail.subtotal);
    detallePorPlatillo.set(detail.platillo_id, current);
  }

  const topPlatillos = Array.from(detallePorPlatillo.entries())
    .map(([platilloId, values]) => {
      const platillo = store.find('platillos', platilloId);
      return {
        platillo_id: platilloId,
        platillo: platillo ? platillo.nombre : null,
        cantidad: values.cantidad,
        monto: values.monto,
      };
    })
    .sort((a, b) => b.cantidad - a.cantidad)
    .slice(0, 5);

  const alertasStock = store.state.insumos
    .filter((insumo) => insumo.activo && insumo.stock_actual <= insumo.stock_minimo)
    .map((insumo) => ({
      insumo_id: insumo.id,
      nombre: insumo.nombre,
      stock_actual: insumo.stock_actual,
      stock_minimo: insumo.stock_minimo,
      faltante: store.round3(insumo.stock_minimo - insumo.stock_actual),
    }))
    .sort((a, b) => b.faltante - a.faltante);

  const caja = store.state.cuadres_caja.find((item) => item.fecha === fecha) || null;

  return {
    fecha,
    ventas_ayer: ventasAyer,
    serie_semana: serieSemana(pagosSemana, fecha),
    kpis: {
      ventas,
      egresos,
      ganancia_neta: store.round2(ventas - egresos),
      pedidos: pedidos.length,
      ticket_promedio: pagos.length > 0 ? store.round2(ventas / pagos.length) : 0,
      cuentas_abiertas: store.state.cuentas.filter((cuenta) => cuenta.estado === 'abierta').length,
      mesas_ocupadas: store.state.mesas.filter((mesa) => mesa.estado === 'ocupada').length,
      pedidos_en_cocina: store.state.pedidos.filter((pedido) => pedido.estado === 'en_cocina').length,
      mermas_pendientes: store.state.mermas.filter((merma) => merma.estado === 'pendiente').length,
      devoluciones_pendientes: store.state.devoluciones.filter((item) => item.estado === 'pendiente').length,
      alertas_stock: alertasStock.length,
    },
    caja: caja
      ? {
          id: caja.id,
          estado: caja.estado,
          fondo_inicial: caja.fondo_inicial,
          total_ventas: caja.total_ventas,
          total_egresos: caja.total_egresos,
          monto_esperado: caja.monto_esperado,
        }
      : null,
    alertas: {
      stock: alertasStock.slice(0, 10),
      mermas_pendientes: store.state.mermas
        .filter((merma) => merma.estado === 'pendiente')
        .map((merma) => ({ id: merma.id, motivo: merma.motivo, costo_estimado: merma.costo_estimado })),
      devoluciones_pendientes: store.state.devoluciones
        .filter((item) => item.estado === 'pendiente')
        .map((item) => ({ id: item.id, motivo: item.motivo, pedido_id: item.pedido_id })),
    },
    top_platillos: topPlatillos,
  };
}

// ---------------------------------------------------------------------
// Helpers Supabase
// ---------------------------------------------------------------------
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

async function contar(tabla, aplicar, mensaje) {
  let consulta = repository.table(tabla).select('*', { count: 'exact', head: true });
  consulta = aplicar ? aplicar(consulta) : consulta;
  const { count, error } = await consulta;
  if (error) {
    throw db.persistenceError(mensaje, error);
  }
  return typeof count === 'number' ? count : 0;
}

// Detalles de los pedidos del día: .in() en lotes de 100 pedidos y paginado
// interno de 1000 filas para no chocar con el tope de PostgREST.
async function detallesDelDia(pedidoIds) {
  const filas = [];
  const tamano = 100;

  for (let inicio = 0; inicio < pedidoIds.length; inicio += tamano) {
    const lote = pedidoIds.slice(inicio, inicio + tamano);
    for (let salto = 0; ; salto += LIMITE_FILAS) {
      const { data, error } = await repository
        .table('pedido_detalles')
        .select('platillo_id, cantidad, subtotal')
        .in('pedido_id', lote)
        .range(salto, salto + LIMITE_FILAS - 1);
      if (error) {
        throw db.persistenceError('No se pudo leer el detalle de los pedidos del día.', error);
      }
      const trozo = data || [];
      filas.push(...trozo);
      if (trozo.length < LIMITE_FILAS) {
        break;
      }
    }
  }

  return filas;
}

async function nombresDePlatillos(ids) {
  const mapa = new Map();
  const limpios = [...new Set(
    (ids || [])
      .map(Number)
      .filter((id) => Number.isFinite(id) && id > 0),
  )];
  const tamano = 500;

  for (let inicio = 0; inicio < limpios.length; inicio += tamano) {
    const lote = limpios.slice(inicio, inicio + tamano);
    const { data, error } = await repository
      .table('platillos')
      .select('id,nombre')
      .in('id', lote);
    if (error) {
      throw db.persistenceError('No se pudieron resolver los platillos del top.', error);
    }
    for (const fila of data || []) {
      mapa.set(fila.id, fila.nombre);
    }
  }

  return mapa;
}

// ---------------------------------------------------------------------
// DB_MODE=supabase
// ---------------------------------------------------------------------
async function getDashboardSupabase(fecha) {
  const { start, end } = rangoDia(fecha);

  const [
    pagos,
    pagosSemana,
    gastos,
    reembolsos,
    pedidosDelDia,
    cuentasAbiertas,
    mesasOcupadas,
    pedidosEnCocina,
    mermasPendientes,
    devolucionesPendientes,
    insumos,
    cuadres,
  ] = await Promise.all([
    leerTodas(
      () => repository.table('pagos').select('monto').gte('fecha', start).lt('fecha', end),
      'No se pudieron leer los pagos del día.',
    ),
    // Serie semanal + ventas de ayer: una sola consulta para los 7 días.
    leerTodas(
      () => repository
        .table('pagos')
        .select('fecha,monto')
        .gte('fecha', rangoDia(fechaEnDias(fecha, -6)).start)
        .lt('fecha', end),
      'No se pudieron leer los pagos de la semana.',
    ),
    leerTodas(
      () => repository.table('gastos').select('monto').eq('fecha', fecha),
      'No se pudieron leer los gastos del día.',
    ),
    leerTodas(
      () => repository
        .table('devoluciones')
        .select('monto_reembolsado')
        .eq('estado', 'aceptada')
        .gte('fecha_resolucion', start)
        .lt('fecha_resolucion', end),
      'No se pudieron leer los reembolsos del día.',
    ),
    leerTodas(
      () => repository.table('pedidos').select('id').gte('fecha_pedido', start).lt('fecha_pedido', end),
      'No se pudieron leer los pedidos del día.',
    ),
    contar('cuentas', (query) => query.eq('estado', 'abierta'), 'No se pudieron contar las cuentas abiertas.'),
    contar('mesas', (query) => query.eq('estado', 'ocupada'), 'No se pudieron contar las mesas ocupadas.'),
    contar('pedidos', (query) => query.eq('estado', 'en_cocina'), 'No se pudieron contar los pedidos en cocina.'),
    leerTodas(
      () => repository.table('mermas').select('id,motivo,costo_estimado').eq('estado', 'pendiente'),
      'No se pudieron leer las mermas pendientes.',
    ),
    leerTodas(
      () => repository.table('devoluciones').select('id,motivo,pedido_id').eq('estado', 'pendiente'),
      'No se pudieron leer las devoluciones pendientes.',
    ),
    leerTodas(
      () => repository.table('insumos').select('id,nombre,stock_actual,stock_minimo,activo').eq('activo', true),
      'No se pudieron leer los insumos.',
    ),
    leerTodas(
      () => repository
        .table('cuadres_caja')
        .select('id,estado,fondo_inicial,total_ventas,total_egresos,monto_esperado')
        .eq('fecha', fecha),
      'No se pudo leer el cuadre de caja del día.',
    ),
  ]);

  const ventas = store.round2(
    pagos.reduce((sum, pago) => sum + Number(pago.monto), 0),
  );
  const ventasAyer = ventasDelDia(pagosSemana, fechaEnDias(fecha, -1));
  const totalGastos = store.round2(
    gastos.reduce((sum, gasto) => sum + Number(gasto.monto), 0),
  );
  const totalReembolsos = store.round2(
    reembolsos.reduce((sum, item) => sum + Number(item.monto_reembolsado || 0), 0),
  );
  const egresos = store.round2(totalGastos + totalReembolsos);

  const alertasStock = insumos
    .filter((insumo) => insumo.activo && Number(insumo.stock_actual) <= Number(insumo.stock_minimo))
    .map((insumo) => ({
      insumo_id: insumo.id,
      nombre: insumo.nombre,
      stock_actual: Number(insumo.stock_actual),
      stock_minimo: Number(insumo.stock_minimo),
      faltante: store.round3(Number(insumo.stock_minimo) - Number(insumo.stock_actual)),
    }))
    .sort((a, b) => b.faltante - a.faltante);

  const detalles = pedidosDelDia.length > 0
    ? await detallesDelDia(pedidosDelDia.map((pedido) => pedido.id))
    : [];

  const detallePorPlatillo = new Map();
  for (const detalle of detalles) {
    const actual = detallePorPlatillo.get(detalle.platillo_id) || { cantidad: 0, monto: 0 };
    actual.cantidad += Number(detalle.cantidad);
    actual.monto = store.round2(actual.monto + Number(detalle.subtotal));
    detallePorPlatillo.set(detalle.platillo_id, actual);
  }

  const topBase = Array.from(detallePorPlatillo.entries())
    .map(([platilloId, values]) => ({
      platillo_id: platilloId,
      cantidad: values.cantidad,
      monto: values.monto,
    }))
    .sort((a, b) => b.cantidad - a.cantidad)
    .slice(0, 5);

  const nombres = await nombresDePlatillos(topBase.map((item) => item.platillo_id));
  const topPlatillos = topBase.map((item) => ({
    platillo_id: item.platillo_id,
    platillo: nombres.has(item.platillo_id) ? nombres.get(item.platillo_id) : null,
    cantidad: item.cantidad,
    monto: item.monto,
  }));

  const cuadre = cuadres[0] || null;
  const caja = cuadre
    ? {
        id: cuadre.id,
        estado: cuadre.estado,
        fondo_inicial: Number(cuadre.fondo_inicial),
        total_ventas: Number(cuadre.total_ventas),
        total_egresos: Number(cuadre.total_egresos),
        monto_esperado: Number(cuadre.monto_esperado),
      }
    : null;

  return {
    fecha,
    ventas_ayer: ventasAyer,
    serie_semana: serieSemana(pagosSemana, fecha),
    kpis: {
      ventas,
      egresos,
      ganancia_neta: store.round2(ventas - egresos),
      pedidos: pedidosDelDia.length,
      ticket_promedio: pagos.length > 0 ? store.round2(ventas / pagos.length) : 0,
      cuentas_abiertas: cuentasAbiertas,
      mesas_ocupadas: mesasOcupadas,
      pedidos_en_cocina: pedidosEnCocina,
      mermas_pendientes: mermasPendientes.length,
      devoluciones_pendientes: devolucionesPendientes.length,
      alertas_stock: alertasStock.length,
    },
    caja,
    alertas: {
      stock: alertasStock.slice(0, 10),
      mermas_pendientes: mermasPendientes.map((merma) => ({
        id: merma.id,
        motivo: merma.motivo,
        costo_estimado: Number(merma.costo_estimado),
      })),
      devoluciones_pendientes: devolucionesPendientes.map((item) => ({
        id: item.id,
        motivo: item.motivo,
        pedido_id: item.pedido_id,
      })),
    },
    top_platillos: topPlatillos,
  };
}

async function getDashboard(query = {}) {
  const fecha = query.fecha || store.today();

  if (!db.isSupabase()) {
    return getDashboardMemoria(fecha);
  }

  return getDashboardSupabase(fecha);
}

module.exports = { getDashboard };
