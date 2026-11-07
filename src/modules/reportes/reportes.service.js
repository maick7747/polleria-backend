'use strict';

const store = require('../../data/store');
const { AppError } = require('../../middleware/error');
const { optionalDate } = require('../../middleware/validate');

const TIPOS = ['ventas', 'costos', 'merma', 'devoluciones', 'inventario', 'activos', 'personal'];

function rango(query) {
  return {
    desde: optionalDate(query.desde, 'desde'),
    hasta: optionalDate(query.hasta, 'hasta'),
  };
}

function enRango(fecha, desde, hasta) {
  const dia = String(fecha).slice(0, 10);
  return (!desde || dia >= desde) && (!hasta || dia <= hasta);
}

function reporteVentas(query) {
  const { desde, hasta } = rango(query);
  const canalFiltro = query.canal || null;
  const pagos = [];

  for (const pago of store.state.pagos) {
    if (!enRango(pago.fecha, desde, hasta)) {
      continue;
    }
    let canal = 'local';
    let sujeto = null;
    if (pago.pedido_id) {
      const pedido = store.find('pedidos', pago.pedido_id);
      canal = pedido ? pedido.canal : 'local';
      sujeto = pedido ? pedido.numero : null;
    } else if (pago.cuenta_id) {
      const cuenta = store.find('cuentas', pago.cuenta_id);
      sujeto = cuenta ? `Cuenta #${cuenta.id}` : null;
    }
    if (canalFiltro && canal !== canalFiltro) {
      continue;
    }
    pagos.push({ fecha: pago.fecha, canal, metodo: pago.metodo, monto: pago.monto, sujeto });
  }

  const agrupar = (campo) => {
    const map = new Map();
    for (const pago of pagos) {
      const key = pago[campo];
      const current = map.get(key) || { [campo]: key, cantidad: 0, monto: 0 };
      current.cantidad += 1;
      current.monto = store.round2(current.monto + pago.monto);
      map.set(key, current);
    }
    return Array.from(map.values()).sort((a, b) => b.monto - a.monto);
  };

  return {
    tipo: 'ventas',
    desde: desde || null,
    hasta: hasta || null,
    total: store.round2(pagos.reduce((sum, pago) => sum + pago.monto, 0)),
    cantidad_pagos: pagos.length,
    por_canal: agrupar('canal'),
    por_metodo: agrupar('metodo'),
    detalle: pagos.sort((a, b) => b.fecha.localeCompare(a.fecha)),
  };
}

function reporteCostos(query) {
  const { desde, hasta } = rango(query);

  const compras = store.state.compras.filter(
    (compra) => compra.estado !== 'cancelada' && enRango(compra.fecha, desde, hasta),
  );
  const gastos = store.state.gastos.filter((gasto) => enRango(gasto.fecha, desde, hasta));
  const mermas = store.state.mermas.filter(
    (merma) => merma.estado === 'aprobada' && enRango(merma.fecha, desde, hasta),
  );

  const totalCompras = store.round2(compras.reduce((sum, compra) => sum + compra.total, 0));
  const totalGastos = store.round2(gastos.reduce((sum, gasto) => sum + gasto.monto, 0));
  const totalMermas = store.round2(mermas.reduce((sum, merma) => sum + merma.costo_estimado, 0));

  return {
    tipo: 'costos',
    desde: desde || null,
    hasta: hasta || null,
    compras: { registros: compras.length, total: totalCompras },
    gastos: { registros: gastos.length, total: totalGastos },
    mermas: { registros: mermas.length, total: totalMermas },
    total_costos: store.round2(totalCompras + totalGastos + totalMermas),
  };
}

function reporteMerma(query) {
  const { desde, hasta } = rango(query);
  const tipoFiltro = query.tipo ? String(query.tipo).toLowerCase() : '';

  const mermas = store.state.mermas
    .filter((merma) => merma.estado === 'aprobada')
    .filter((merma) => enRango(merma.fecha, desde, hasta))
    .filter((merma) => {
      if (!tipoFiltro) {
        return true;
      }
      const tipo = store.find('tipos_merma', merma.tipo_merma_id);
      return tipo && tipo.nombre.toLowerCase().includes(tipoFiltro);
    })
    .map((merma) => {
      const tipo = store.find('tipos_merma', merma.tipo_merma_id);
      return { ...merma, tipo: tipo ? tipo.nombre : null };
    });

  const porTipo = new Map();
  const porClasificacion = new Map();
  for (const merma of mermas) {
    const tipo = merma.tipo || 'sin_tipo';
    const t = porTipo.get(tipo) || { tipo, registros: 0, costo: 0 };
    t.registros += 1;
    t.costo = store.round2(t.costo + merma.costo_estimado);
    porTipo.set(tipo, t);

    const clasificacion = merma.clasificacion;
    const c = porClasificacion.get(clasificacion) || { clasificacion, registros: 0, costo: 0 };
    c.registros += 1;
    c.costo = store.round2(c.costo + merma.costo_estimado);
    porClasificacion.set(clasificacion, c);
  }

  return {
    tipo: 'merma',
    desde: desde || null,
    hasta: hasta || null,
    total_costo: store.round2(mermas.reduce((sum, merma) => sum + merma.costo_estimado, 0)),
    registros: mermas.length,
    por_tipo: Array.from(porTipo.values()),
    por_clasificacion: Array.from(porClasificacion.values()),
  };
}

function reporteDevoluciones(query) {
  const { desde, hasta } = rango(query);
  const items = store.state.devoluciones.filter((item) =>
    enRango(item.fecha_reporte, desde, hasta),
  );

  const porEstado = new Map();
  const porResolucion = new Map();
  for (const item of items) {
    const estado = porEstado.get(item.estado) || { estado: item.estado, registros: 0 };
    estado.registros += 1;
    porEstado.set(item.estado, estado);

    const key = item.resolucion || 'sin_resolucion';
    const resolucion = porResolucion.get(key) || { resolucion: key, registros: 0, reembolsado: 0 };
    resolucion.registros += 1;
    resolucion.reembolsado = store.round2(resolucion.reembolsado + item.monto_reembolsado);
    porResolucion.set(key, resolucion);
  }

  return {
    tipo: 'devoluciones',
    desde: desde || null,
    hasta: hasta || null,
    registros: items.length,
    monto_reembolsado: store.round2(items.reduce((sum, item) => sum + item.monto_reembolsado, 0)),
    por_estado: Array.from(porEstado.values()),
    por_resolucion: Array.from(porResolucion.values()),
    detalle: items.map((item) => ({
      id: item.id,
      pedido_id: item.pedido_id,
      motivo: item.motivo,
      estado: item.estado,
      resolucion: item.resolucion,
      monto_reembolsado: item.monto_reembolsado,
      fecha: item.fecha_reporte,
    })),
  };
}

function reporteInventario() {
  const insumos = store.state.insumos.filter((insumo) => insumo.activo);
  const porCategoria = new Map();

  for (const insumo of insumos) {
    const current = porCategoria.get(insumo.categoria) || {
      categoria: insumo.categoria,
      insumos: 0,
      valor: 0,
    };
    current.insumos += 1;
    current.valor = store.round2(current.valor + insumo.stock_actual * insumo.costo_promedio);
    porCategoria.set(insumo.categoria, current);
  }

  return {
    tipo: 'inventario',
    total_insumos: insumos.length,
    valor_total: store.round2(
      insumos.reduce((sum, insumo) => sum + insumo.stock_actual * insumo.costo_promedio, 0),
    ),
    bajo_minimo: insumos.filter((insumo) => insumo.stock_actual <= insumo.stock_minimo).length,
    por_categoria: Array.from(porCategoria.values()),
    insumos: insumos.map((insumo) => ({
      id: insumo.id,
      codigo: insumo.codigo,
      nombre: insumo.nombre,
      categoria: insumo.categoria,
      unidad_medida: insumo.unidad_medida,
      stock_actual: insumo.stock_actual,
      stock_minimo: insumo.stock_minimo,
      costo_promedio: insumo.costo_promedio,
      valor: store.round2(insumo.stock_actual * insumo.costo_promedio),
      estado: insumo.stock_actual <= insumo.stock_minimo && insumo.stock_minimo > 0
        ? insumo.stock_actual <= insumo.stock_minimo * 0.5 ? 'critico' : 'bajo'
        : 'ok',
    })),
  };
}

function mesesEntre(fecha, referencia = new Date()) {
  const start = new Date(`${fecha}T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    return 0;
  }
  return Math.max(0, (referencia.getFullYear() - start.getFullYear()) * 12 + referencia.getMonth() - start.getMonth());
}

function reporteActivos() {
  const activos = store.state.activos;
  const mantenimientos = store.state.mantenimientos;

  const porCategoria = new Map();
  for (const activo of activos) {
    const current = porCategoria.get(activo.categoria) || {
      categoria: activo.categoria,
      activos: 0,
      valor: 0,
    };
    current.activos += 1;
    current.valor = store.round2(current.valor + activo.costo_adquisicion * activo.cantidad);
    porCategoria.set(activo.categoria, current);
  }

  return {
    tipo: 'activos',
    total_activos: activos.length,
    valor_adquisicion: store.round2(
      activos.reduce((sum, activo) => sum + activo.costo_adquisicion * activo.cantidad, 0),
    ),
    en_reparacion: activos.filter((activo) => activo.estado === 'en_reparacion').length,
    dados_de_baja: activos.filter((activo) => activo.estado === 'dado_de_baja').length,
    costo_mantenimientos: store.round2(
      mantenimientos.reduce((sum, item) => sum + item.costo_reparacion, 0),
    ),
    por_categoria: Array.from(porCategoria.values()),
    activos: activos.map((activo) => ({
      id: activo.id,
      nombre: activo.nombre,
      categoria: activo.categoria,
      estado: activo.estado,
      cantidad: activo.cantidad,
      vida_util_meses: activo.vida_util_meses,
      antiguedad_meses: mesesEntre(activo.fecha_adquisicion),
      vida_util_vencida: activo.vida_util_meses !== null
        && mesesEntre(activo.fecha_adquisicion) > activo.vida_util_meses,
      mantenimientos: mantenimientos.filter((item) => item.activo_id === activo.id).length,
    })),
  };
}

function reportePersonal() {
  const usuarios = store.state.usuarios.filter((usuario) => usuario.activo);
  const porRol = new Map();

  for (const usuario of usuarios) {
    for (const rol of usuario.roles) {
      const current = porRol.get(rol) || { rol, usuarios: 0 };
      current.usuarios += 1;
      porRol.set(rol, current);
    }
  }

  return {
    tipo: 'personal',
    total_usuarios: usuarios.length,
    por_rol: Array.from(porRol.values()),
    usuarios: usuarios.map((usuario) => ({
      id: usuario.id,
      nombre: usuario.nombre,
      email: usuario.email,
      roles: usuario.roles,
      permisos: usuario.permisos.length,
      activo: usuario.activo,
      ultimo_acceso: usuario.ultimo_acceso,
    })),
  };
}

function obtenerReporte(tipo, query = {}) {
  const normalized = String(tipo || '').toLowerCase();
  switch (normalized) {
    case 'ventas':
      return reporteVentas(query);
    case 'costos':
      return reporteCostos(query);
    case 'merma':
      return reporteMerma(query);
    case 'devoluciones':
      return reporteDevoluciones(query);
    case 'inventario':
      return reporteInventario(query);
    case 'activos':
      return reporteActivos(query);
    case 'personal':
      return reportePersonal(query);
    default:
      throw new AppError(404, 'NOT_FOUND', `El reporte "${tipo}" no existe. Tipos válidos: ${TIPOS.join(', ')}.`);
  }
}

module.exports = { TIPOS, obtenerReporte };
