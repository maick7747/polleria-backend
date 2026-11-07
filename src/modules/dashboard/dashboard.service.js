'use strict';

const store = require('../../data/store');

function sumBy(items, predicate, selector) {
  return store.round2(
    items.filter(predicate).reduce((total, item) => total + Number(selector(item)), 0),
  );
}

function getDashboard(query = {}) {
  const fecha = query.fecha || store.today();
  const pagos = store.state.pagos.filter((pago) => pago.fecha.slice(0, 10) === fecha);
  const gastos = store.state.gastos.filter((gasto) => gasto.fecha === fecha);
  const reembolsos = store.state.reembolsos.filter((item) => item.fecha.slice(0, 10) === fecha);
  const pedidos = store.state.pedidos.filter((pedido) => pedido.fecha_pedido.slice(0, 10) === fecha);

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

module.exports = { getDashboard };
