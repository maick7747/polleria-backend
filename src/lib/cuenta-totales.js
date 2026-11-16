'use strict';

// Totales de una cuenta de mesa.
//
// Regla de negocio (2026-11-14): el IGV se calcula UNA sola vez sobre la suma
// de los platos de la cuenta, no por ronda. Se mantiene la configuración
// vigente (`igv_pct` 18 % y `igv_min_soles` 70): si el subtotal de la cuenta
// no alcanza el mínimo, el IGV es 0.
//
// Antes cada ronda aplicaba su propio IGV y `cuentas.total` era la suma de
// totales por ronda. Eso hacía que dos rondas de S/ 50 no pagaran IGV aunque
// la cuenta sumara S/ 100. Este módulo centraliza el cálculo para que la
// pantalla, el cobro y la boleta usen exactamente el mismo número.

const store = require('../data/store');
const db = require('../data/db');
const repository = require('../data/repository');
const { AppError } = require('../middleware/error');

// Una ronda cancelada no cuenta ni bloquea el cobro.
const ESTADO_CANCELADO = 'cancelado';

function numero(valor) {
  const parsed = Number(valor);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function pedidosDeCuenta(cuentaId) {
  const id = Number(cuentaId);

  if (!db.isSupabase()) {
    return store.state.pedidos
      .filter((pedido) => pedido.cuenta_id === id && pedido.estado !== ESTADO_CANCELADO)
      .sort((a, b) => Number(a.id) - Number(b.id));
  }

  const { data } = await repository.list('pedidos', {
    filters: {
      cuenta_id: id,
      estado: { op: 'neq', value: ESTADO_CANCELADO },
    },
    orderBy: 'id',
    ascending: true,
    limit: 500,
  });
  return data;
}

function subtotalDePedidos(pedidos) {
  return store.round2(
    (Array.isArray(pedidos) ? pedidos : []).reduce(
      (total, pedido) => total + numero(pedido.subtotal),
      0,
    ),
  );
}

// Calcula { subtotal, igv, total } con la configuración vigente. `db.calcTotals`
// funciona en ambos modos: en memoria delega en `store.calcTotals`.
async function totalesDePedidos(pedidos, extra = 0) {
  const subtotal = subtotalDePedidos(pedidos);
  const totals = await db.calcTotals(subtotal, extra);
  return {
    subtotal: store.round2(totals.subtotal),
    igv: store.round2(totals.igv),
    total: store.round2(totals.total),
  };
}

async function totalesCuenta(cuentaId, pedidosPrevios = null) {
  const pedidos = Array.isArray(pedidosPrevios)
    ? pedidosPrevios
    : await pedidosDeCuenta(cuentaId);
  return totalesDePedidos(pedidos);
}

// Deja `cuentas.total` alineado con la regla de IGV sobre el total. Se llama
// después de agregar/editar/cancelar una ronda. El cobro vuelve a calcularlo
// dentro de su propia transacción, así que un desfase aquí nunca altera el
// monto final cobrado.
async function recalcularTotalCuenta(cuentaId, pedidosPrevios = null) {
  const totales = await totalesCuenta(cuentaId, pedidosPrevios);

  if (!db.isSupabase()) {
    const cuenta = store.find('cuentas', cuentaId);
    if (cuenta && cuenta.estado === 'abierta') {
      cuenta.total = totales.total;
    }
    return totales;
  }

  const cuenta = await repository.getById('cuentas', Number(cuentaId));
  if (cuenta && cuenta.estado === 'abierta') {
    // UPDATE condicional: si otra terminal cobra entre la lectura y esta
    // escritura, no se pisa el total de una cuenta ya cerrada.
    await repository.updateWhere(
      'cuentas',
      { id: cuenta.id, estado: 'abierta' },
      { total: totales.total },
    );
  }
  return totales;
}

async function nombresDePlatillos(platilloIds) {
  const ids = [...new Set(platilloIds.filter((id) => Number.isInteger(Number(id))))].map(Number);
  if (ids.length === 0) {
    return new Map();
  }

  if (!db.isSupabase()) {
    return new Map(
      ids.map((id) => {
        const platillo = store.find('platillos', id);
        return [id, platillo ? platillo.nombre : null];
      }),
    );
  }

  const { data } = await repository.list('platillos', {
    filters: { id: ids },
    limit: ids.length,
  });
  return new Map(data.map((platillo) => [platillo.id, platillo.nombre]));
}

// Líneas de la cuenta que todavía no se entregaron al cliente. Es la fuente
// del candado de cobro y del aviso al mozo.
async function lineasPorEntregar(cuentaId, pedidosPrevios = null) {
  const pedidos = Array.isArray(pedidosPrevios)
    ? pedidosPrevios
    : await pedidosDeCuenta(cuentaId);
  if (pedidos.length === 0) {
    return [];
  }

  const ids = pedidos.map((pedido) => Number(pedido.id));
  let detalles;

  if (!db.isSupabase()) {
    detalles = store.state.pedido_detalles.filter(
      (detalle) => ids.includes(Number(detalle.pedido_id)) && !detalle.entregado_en,
    );
  } else {
    const { data } = await repository.list('pedido_detalles', {
      filters: { pedido_id: ids, entregado_en: null },
      orderBy: 'id',
      ascending: true,
      limit: 1000,
    });
    detalles = data;
  }

  const nombres = await nombresDePlatillos(detalles.map((detalle) => detalle.platillo_id));
  const pedidoPorId = new Map(pedidos.map((pedido) => [Number(pedido.id), pedido]));

  return detalles.map((detalle) => {
    const pedido = pedidoPorId.get(Number(detalle.pedido_id));
    return {
      pedido_id: Number(detalle.pedido_id),
      pedido_numero: pedido ? pedido.numero : null,
      detalle_id: Number(detalle.id),
      platillo: nombres.get(Number(detalle.platillo_id)) || `Platillo ${detalle.platillo_id}`,
      cantidad: numero(detalle.cantidad),
      estado_preparacion: detalle.estado_preparacion || 'pendiente',
      notas: detalle.notas || null,
    };
  });
}

// Bloquea el cobro mientras quede un plato sin entregar. Devuelve el detalle
// para que la UI pueda mostrar exactamente qué falta.
async function validarTodoEntregado(cuentaId, pedidosPrevios = null) {
  const pendientes = await lineasPorEntregar(cuentaId, pedidosPrevios);
  if (pendientes.length > 0) {
    const platos = pendientes
      .slice(0, 6)
      .map((linea) => `${linea.cantidad}x ${linea.platillo}`)
      .join(', ');
    const restantes = pendientes.length > 6 ? ` y ${pendientes.length - 6} más` : '';
    throw new AppError(
      409,
      'PLATOS_NO_ENTREGADOS',
      `No se puede cobrar: faltan ${pendientes.length} plato(s) por entregar (${platos}${restantes}).`,
      pendientes,
    );
  }
  return [];
}

module.exports = {
  pedidosDeCuenta,
  subtotalDePedidos,
  totalesDePedidos,
  totalesCuenta,
  recalcularTotalCuenta,
  lineasPorEntregar,
  validarTodoEntregado,
};
