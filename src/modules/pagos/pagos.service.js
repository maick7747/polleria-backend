'use strict';

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const { optionalDate } = require('../../middleware/validate');

// PostgREST devuelve como máximo 1000 filas: se pagina hasta agotar.
const LIMITE_FILAS = 1000;
const CAMPOS = 'id,pedido_id,cuenta_id,metodo,monto,es_contraentrega,fecha,usuario_id';

// Rango del día operativo en hora de Lima (-05:00), igual que cuadre-caja.
function rangoDia(fecha) {
  const start = new Date(`${fecha}T00:00:00-05:00`);
  const end = new Date(start.getTime() + 86400000);
  return { start: start.toISOString(), end: end.toISOString() };
}

// Fecha operativa (Lima) de un timestamp de `pagos.fecha`.
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

function pagoDTO(pago) {
  return {
    id: pago.id,
    pedido_id: pago.pedido_id === undefined ? null : pago.pedido_id,
    cuenta_id: pago.cuenta_id === undefined ? null : pago.cuenta_id,
    metodo: pago.metodo,
    monto: store.round2(Number(pago.monto) || 0),
    es_contraentrega: Boolean(pago.es_contraentrega),
    fecha: pago.fecha,
    usuario_id: pago.usuario_id === undefined ? null : pago.usuario_id,
  };
}

function agruparPorMetodo(pagos) {
  const mapa = new Map();
  for (const pago of pagos) {
    const actual = mapa.get(pago.metodo) || { metodo: pago.metodo, monto: 0, cantidad: 0 };
    actual.monto = store.round2(actual.monto + Number(pago.monto));
    actual.cantidad += 1;
    mapa.set(pago.metodo, actual);
  }
  return Array.from(mapa.values()).sort(
    (izquierda, derecha) => derecha.monto - izquierda.monto
      || String(izquierda.metodo).localeCompare(String(derecha.metodo)),
  );
}

async function leerPagosSupabase(fecha) {
  const { start, end } = rangoDia(fecha);
  const filas = [];

  for (let inicio = 0; ; inicio += LIMITE_FILAS) {
    const { data, error } = await repository
      .table('pagos')
      .select(CAMPOS)
      .gte('fecha', start)
      .lt('fecha', end)
      .order('fecha', { ascending: false })
      .order('id', { ascending: false })
      .range(inicio, inicio + LIMITE_FILAS - 1);
    if (error) {
      throw db.persistenceError('No se pudieron leer los pagos del día.', error);
    }
    const lote = data || [];
    filas.push(...lote);
    if (lote.length < LIMITE_FILAS) {
      break;
    }
  }

  return filas;
}

async function totalReembolsosDelDia(fecha) {
  const { start, end } = rangoDia(fecha);
  if (!db.isSupabase()) {
    return store.round2(
      store.state.reembolsos
        .filter((item) => fechaLima(item.fecha) === fecha)
        .reduce((suma, item) => suma + Number(item.monto || 0), 0),
    );
  }

  const filas = [];
  for (let inicio = 0; ; inicio += LIMITE_FILAS) {
    const { data, error } = await repository
      .table('devoluciones')
      .select('monto_reembolsado')
      .eq('estado', 'aceptada')
      .gte('fecha_resolucion', start)
      .lt('fecha_resolucion', end)
      .order('id', { ascending: true })
      .range(inicio, inicio + LIMITE_FILAS - 1);
    if (error) {
      throw db.persistenceError('No se pudieron leer los reembolsos del día.', error);
    }
    const lote = data || [];
    filas.push(...lote);
    if (lote.length < LIMITE_FILAS) {
      break;
    }
  }
  return store.round2(
    filas.reduce((suma, fila) => suma + Number(fila.monto_reembolsado || 0), 0),
  );
}

async function listPagos(query = {}) {
  const fecha = optionalDate(query.fecha, 'fecha') || store.today();

  const pagos = db.isSupabase()
    ? await leerPagosSupabase(fecha)
    : store.state.pagos
      .filter((pago) => fechaLima(pago.fecha) === fecha)
      .sort(
        (izquierda, derecha) => String(derecha.fecha).localeCompare(String(izquierda.fecha))
          || Number(derecha.id) - Number(izquierda.id),
      );

  const data = pagos.map(pagoDTO);
  const totalBruto = store.round2(data.reduce((suma, pago) => suma + pago.monto, 0));
  // Los reembolsos entran a `pagos` como filas positivas (para que afecten la
  // caja) pero son contra-venta: el total del día se reporta neto. Mismo
  // criterio que dashboard.service.js y cuadre-caja.service.js.
  const reembolsos = await totalReembolsosDelDia(fecha);

  return {
    fecha,
    data,
    total_bruto: totalBruto,
    reembolsos,
    total: store.round2(totalBruto - reembolsos),
    cantidad: data.length,
    por_metodo: agruparPorMetodo(data),
  };
}

module.exports = { listPagos };
