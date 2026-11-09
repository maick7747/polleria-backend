'use strict';

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const { AppError } = require('../../middleware/error');
const { optionalDate } = require('../../middleware/validate');

const TIPOS = ['ventas', 'costos', 'merma', 'devoluciones', 'inventario', 'activos', 'personal'];

// PostgREST devuelve como máximo 1000 filas por consulta. Los reportes que
// necesitan agregar todo el rango recorren la tabla por lotes de este tamaño.
const LIMITE_FILAS = 1000;

const CANALES = ['local', 'whatsapp', 'delivery_propio', 'rappi', 'llamafood'];

function aNumero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

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

function siguienteDia(fecha) {
  const [anio, mes, dia] = fecha.split('-').map(Number);
  const siguiente = new Date(Date.UTC(anio, mes - 1, dia));
  siguiente.setUTCDate(siguiente.getUTCDate() + 1);
  return siguiente.toISOString().slice(0, 10);
}

// Las columnas TIMESTAMPTZ se filtran en hora de Lima (-05:00) para que el
// rango coincida con el día operativo y no con el día UTC de Postgres.
function rangoTimestamps({ desde, hasta }) {
  return {
    inicio: desde ? `${desde}T00:00:00-05:00` : null,
    fin: hasta ? `${siguienteDia(hasta)}T00:00:00-05:00` : null,
  };
}

function metaRango(desde, hasta, extra = {}) {
  return {
    rango: { desde: desde || null, hasta: hasta || null },
    limite_filas: LIMITE_FILAS,
    ...extra,
  };
}

// Recorre una consulta de PostgREST por lotes de 1000 hasta agotar el rango.
// `crearConsulta` debe devolver un builder nuevo en cada llamada.
async function todasLasFilas(crearConsulta, etiqueta) {
  const filas = [];
  for (let inicio = 0; ; inicio += LIMITE_FILAS) {
    const { data, error } = await crearConsulta().range(inicio, inicio + LIMITE_FILAS - 1);
    if (error) {
      throw db.persistenceError(`No se pudo leer ${etiqueta}.`, error);
    }
    const lote = data || [];
    filas.push(...lote);
    if (lote.length < LIMITE_FILAS) {
      break;
    }
  }
  return filas;
}

// Enriquecimiento por lote: una consulta por cada 500 ids en lugar de N+1.
async function porIds(tabla, ids, select = 'id, nombre') {
  const limpios = [...new Set((ids || []).map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  const mapa = new Map();
  const tamano = 500;

  for (let inicio = 0; inicio < limpios.length; inicio += tamano) {
    const lote = limpios.slice(inicio, inicio + tamano);
    try {
      const { data } = await repository.list(tabla, {
        select,
        filters: { id: lote },
        limit: tamano,
      });
      for (const fila of data || []) {
        mapa.set(fila.id, fila);
      }
    } catch (error) {
      throw db.persistenceError(`No se pudo leer el catálogo ${tabla}.`, error);
    }
  }

  return mapa;
}

function agruparPagos(pagos, campo) {
  const mapa = new Map();
  for (const pago of pagos) {
    const clave = pago[campo];
    const actual = mapa.get(clave) || { [campo]: clave, cantidad: 0, monto: 0 };
    actual.cantidad += 1;
    actual.monto = store.round2(actual.monto + pago.monto);
    mapa.set(clave, actual);
  }
  return Array.from(mapa.values()).sort((a, b) => b.monto - a.monto);
}

function agruparPorDia(pagos) {
  const mapa = new Map();
  for (const pago of pagos) {
    const dia = String(pago.fecha).slice(0, 10);
    const actual = mapa.get(dia) || { fecha: dia, cantidad: 0, monto: 0 };
    actual.cantidad += 1;
    actual.monto = store.round2(actual.monto + pago.monto);
    mapa.set(dia, actual);
  }
  return Array.from(mapa.values()).sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// Agrupa líneas de pedido por platillo y devuelve el top 10 por cantidad.
function agruparPlatillos(detalles, resolverPlatillo) {
  const mapa = new Map();
  for (const detalle of detalles) {
    const clave = detalle.platillo_id;
    const platillo = resolverPlatillo(clave);
    const actual = mapa.get(clave) || {
      platillo_id: clave,
      platillo: platillo ? platillo.nombre : null,
      cantidad: 0,
      monto: 0,
    };
    actual.cantidad += aNumero(detalle.cantidad);
    actual.monto = store.round2(actual.monto + aNumero(detalle.subtotal));
    mapa.set(clave, actual);
  }
  return Array.from(mapa.values())
    .sort((a, b) => b.cantidad - a.cantidad || b.monto - a.monto)
    .slice(0, 10);
}

function agruparMontos(items, claveFn, etiquetaFn, campoMonto) {
  const mapa = new Map();
  for (const item of items) {
    const clave = claveFn(item);
    const actual = mapa.get(clave) || {
      clave,
      nombre: etiquetaFn(item),
      registros: 0,
      total: 0,
    };
    actual.registros += 1;
    actual.total += aNumero(item[campoMonto]);
    mapa.set(clave, actual);
  }
  return Array.from(mapa.values())
    .map((item) => ({ ...item, total: db.round2(item.total) }))
    .sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------
// Ventas
// ---------------------------------------------------------------------
function pagosVentasMemoria({ desde, hasta, canalFiltro }) {
  const pagos = [];
  for (const pago of store.state.pagos) {
    if (!enRango(pago.fecha, desde, hasta)) {
      continue;
    }
    let canal = 'local';
    let sujeto = null;
    let sujetoClave = `cuenta:${pago.cuenta_id}`;
    if (pago.pedido_id) {
      const pedido = store.find('pedidos', pago.pedido_id);
      canal = pedido ? pedido.canal : 'local';
      sujeto = pedido ? pedido.numero : null;
      sujetoClave = `pedido:${pago.pedido_id}`;
    } else if (pago.cuenta_id) {
      sujeto = `Cuenta #${pago.cuenta_id}`;
    }
    if (canalFiltro && canal !== canalFiltro) {
      continue;
    }
    pagos.push({
      fecha: pago.fecha,
      canal,
      metodo: pago.metodo,
      monto: aNumero(pago.monto),
      sujeto,
      sujeto_clave: sujetoClave,
    });
  }
  return pagos;
}

async function pagosVentasSupabase({ desde, hasta, canalFiltro }) {
  const { inicio, fin } = rangoTimestamps({ desde, hasta });
  const filas = await todasLasFilas(() => {
    let consulta = repository
      .table('pagos')
      .select('id, pedido_id, cuenta_id, metodo, monto, fecha');
    if (inicio) {
      consulta = consulta.gte('fecha', inicio);
    }
    if (fin) {
      consulta = consulta.lt('fecha', fin);
    }
    return consulta.order('fecha', { ascending: false }).order('id', { ascending: false });
  }, 'los pagos del rango');

  const pedidos = await porIds(
    'pedidos',
    filas.map((fila) => fila.pedido_id),
    'id, numero, canal',
  );

  return filas
    .map((pago) => {
      let canal = 'local';
      let sujeto = null;
      let sujetoClave = `cuenta:${pago.cuenta_id}`;
      if (pago.pedido_id) {
        const pedido = pedidos.get(pago.pedido_id);
        canal = pedido ? pedido.canal : 'local';
        sujeto = pedido ? pedido.numero : null;
        sujetoClave = `pedido:${pago.pedido_id}`;
      } else if (pago.cuenta_id) {
        sujeto = `Cuenta #${pago.cuenta_id}`;
      }
      return {
        fecha: pago.fecha,
        canal,
        metodo: pago.metodo,
        monto: aNumero(pago.monto),
        sujeto,
        sujeto_clave: sujetoClave,
      };
    })
    .filter((pago) => !canalFiltro || pago.canal === canalFiltro);
}

function topPlatillosMemoria({ desde, hasta, canalFiltro }) {
  const pedidos = store.state.pedidos.filter(
    (pedido) =>
      pedido.estado !== 'cancelado' &&
      enRango(pedido.fecha_pedido, desde, hasta) &&
      (!canalFiltro || pedido.canal === canalFiltro),
  );
  const ids = new Set(pedidos.map((pedido) => pedido.id));
  const detalles = store.state.pedido_detalles.filter((detalle) => ids.has(detalle.pedido_id));
  return agruparPlatillos(detalles, (id) => store.find('platillos', id));
}

async function detallesPorPedido(ids) {
  const detalles = [];
  const tamano = 500;
  for (let inicio = 0; inicio < ids.length; inicio += tamano) {
    const lote = ids.slice(inicio, inicio + tamano);
    const { data, error } = await repository
      .table('pedido_detalles')
      .select('pedido_id, platillo_id, cantidad, subtotal')
      .in('pedido_id', lote)
      .order('id', { ascending: true });
    if (error) {
      throw db.persistenceError('No se pudo leer el detalle de los pedidos.', error);
    }
    detalles.push(...(data || []));
  }
  return detalles;
}

async function topPlatillosSupabase({ desde, hasta, canalFiltro }) {
  if (canalFiltro && !CANALES.includes(canalFiltro)) {
    return [];
  }

  const { inicio, fin } = rangoTimestamps({ desde, hasta });
  const pedidos = await todasLasFilas(() => {
    let consulta = repository.table('pedidos').select('id, estado, canal');
    if (inicio) {
      consulta = consulta.gte('fecha_pedido', inicio);
    }
    if (fin) {
      consulta = consulta.lt('fecha_pedido', fin);
    }
    if (canalFiltro) {
      consulta = consulta.eq('canal', canalFiltro);
    }
    return consulta.order('id', { ascending: true });
  }, 'los pedidos del rango');

  const activos = pedidos.filter((pedido) => pedido.estado !== 'cancelado');
  const detalles = await detallesPorPedido(activos.map((pedido) => pedido.id));
  const platillos = await porIds(
    'platillos',
    detalles.map((detalle) => detalle.platillo_id),
    'id, nombre',
  );

  return agruparPlatillos(detalles, (id) => platillos.get(id));
}

async function reporteVentas(query) {
  const { desde, hasta } = rango(query);
  const canalFiltro = query.canal ? String(query.canal) : null;

  const [pagos, topPlatillos] = await Promise.all([
    db.isSupabase()
      ? pagosVentasSupabase({ desde, hasta, canalFiltro })
      : Promise.resolve(pagosVentasMemoria({ desde, hasta, canalFiltro })),
    db.isSupabase()
      ? topPlatillosSupabase({ desde, hasta, canalFiltro })
      : Promise.resolve(topPlatillosMemoria({ desde, hasta, canalFiltro })),
  ]);

  const total = store.round2(pagos.reduce((suma, pago) => suma + pago.monto, 0));
  const tickets = new Set(pagos.map((pago) => pago.sujeto_clave)).size;

  return {
    tipo: 'ventas',
    desde: desde || null,
    hasta: hasta || null,
    total,
    cantidad_pagos: pagos.length,
    cantidad_tickets: tickets,
    ticket_promedio: tickets === 0 ? 0 : store.round2(total / tickets),
    por_canal: agruparPagos(pagos, 'canal'),
    por_metodo: agruparPagos(pagos, 'metodo'),
    por_dia: agruparPorDia(pagos),
    top_platillos: topPlatillos,
    detalle: [...pagos]
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
      .map(({ sujeto_clave: _sujetoClave, ...resto }) => resto),
    meta: metaRango(desde, hasta, {
      canal: canalFiltro,
      limitacion:
        'Los pagos ligados a una cuenta (cuenta_id) no guardan canal propio; se reportan como "local".',
    }),
  };
}

// ---------------------------------------------------------------------
// Costos
// ---------------------------------------------------------------------
function costosMemoria({ desde, hasta }) {
  const compras = store.state.compras.filter(
    (compra) => compra.estado !== 'cancelada' && enRango(compra.fecha, desde, hasta),
  );
  const gastos = store.state.gastos.filter((gasto) => enRango(gasto.fecha, desde, hasta));
  const mermas = store.state.mermas.filter(
    (merma) => merma.estado === 'aprobada' && enRango(merma.fecha, desde, hasta),
  );

  return {
    compras,
    gastos,
    mermas,
    porProveedor: agruparMontos(
      compras,
      (compra) => compra.proveedor_id,
      (compra) => {
        const proveedor = store.find('proveedores', compra.proveedor_id);
        return proveedor ? proveedor.razon_social : null;
      },
      'total',
    ),
    porCategoria: agruparMontos(gastos, (gasto) => gasto.categoria, (gasto) => gasto.categoria, 'monto'),
    porTipoMerma: agruparMontos(
      mermas,
      (merma) => merma.tipo_merma_id,
      (merma) => {
        const tipo = store.find('tipos_merma', merma.tipo_merma_id);
        return tipo ? tipo.nombre : null;
      },
      'costo_estimado',
    ),
  };
}

async function costosSupabase({ desde, hasta }) {
  const [compras, gastos, mermas] = await Promise.all([
    todasLasFilas(() => {
      let consulta = repository.table('compras').select('id, total, proveedor_id, fecha, estado');
      if (desde) {
        consulta = consulta.gte('fecha', desde);
      }
      if (hasta) {
        consulta = consulta.lte('fecha', hasta);
      }
      return consulta.neq('estado', 'cancelada').order('id', { ascending: true });
    }, 'las compras del rango'),
    todasLasFilas(() => {
      let consulta = repository.table('gastos').select('id, categoria, monto, fecha');
      if (desde) {
        consulta = consulta.gte('fecha', desde);
      }
      if (hasta) {
        consulta = consulta.lte('fecha', hasta);
      }
      return consulta.order('id', { ascending: true });
    }, 'los gastos del rango'),
    todasLasFilas(() => {
      let consulta = repository.table('mermas').select('id, tipo_merma_id, costo_estimado, fecha');
      if (desde) {
        consulta = consulta.gte('fecha', desde);
      }
      if (hasta) {
        consulta = consulta.lte('fecha', hasta);
      }
      return consulta.eq('estado', 'aprobada').order('id', { ascending: true });
    }, 'las mermas del rango'),
  ]);

  const [proveedores, tiposMerma] = await Promise.all([
    porIds('proveedores', compras.map((compra) => compra.proveedor_id), 'id, razon_social'),
    porIds('tipos_merma', mermas.map((merma) => merma.tipo_merma_id), 'id, nombre'),
  ]);

  return {
    compras,
    gastos,
    mermas,
    porProveedor: agruparMontos(
      compras,
      (compra) => compra.proveedor_id,
      (compra) => {
        const proveedor = proveedores.get(compra.proveedor_id);
        return proveedor ? proveedor.razon_social : null;
      },
      'total',
    ),
    porCategoria: agruparMontos(gastos, (gasto) => gasto.categoria, (gasto) => gasto.categoria, 'monto'),
    porTipoMerma: agruparMontos(
      mermas,
      (merma) => merma.tipo_merma_id,
      (merma) => {
        const tipo = tiposMerma.get(merma.tipo_merma_id);
        return tipo ? tipo.nombre : null;
      },
      'costo_estimado',
    ),
  };
}

async function reporteCostos(query) {
  const { desde, hasta } = rango(query);
  const datos = db.isSupabase()
    ? await costosSupabase({ desde, hasta })
    : costosMemoria({ desde, hasta });

  const totalCompras = store.round2(
    datos.compras.reduce((suma, compra) => suma + aNumero(compra.total), 0),
  );
  const totalGastos = store.round2(
    datos.gastos.reduce((suma, gasto) => suma + aNumero(gasto.monto), 0),
  );
  const totalMermas = store.round2(
    datos.mermas.reduce((suma, merma) => suma + aNumero(merma.costo_estimado), 0),
  );

  return {
    tipo: 'costos',
    desde: desde || null,
    hasta: hasta || null,
    compras: {
      registros: datos.compras.length,
      total: totalCompras,
      por_proveedor: datos.porProveedor.map((item) => ({
        proveedor_id: item.clave,
        proveedor: item.nombre,
        registros: item.registros,
        total: item.total,
      })),
    },
    gastos: {
      registros: datos.gastos.length,
      total: totalGastos,
      por_categoria: datos.porCategoria.map((item) => ({
        categoria: item.clave,
        registros: item.registros,
        total: item.total,
      })),
    },
    mermas: {
      registros: datos.mermas.length,
      total: totalMermas,
      por_tipo: datos.porTipoMerma.map((item) => ({
        tipo: item.nombre,
        registros: item.registros,
        total: item.total,
      })),
    },
    total_costos: store.round2(totalCompras + totalGastos + totalMermas),
    meta: metaRango(desde, hasta),
  };
}

// ---------------------------------------------------------------------
// Merma
// ---------------------------------------------------------------------
function reporteMermaMemoria({ desde, hasta, tipoFiltro }) {
  return store.state.mermas
    .filter((merma) => merma.estado === 'aprobada' && enRango(merma.fecha, desde, hasta))
    .map((merma) => {
      const tipo = store.find('tipos_merma', merma.tipo_merma_id);
      return { ...merma, tipo: tipo ? tipo.nombre : null };
    })
    .filter((merma) => !tipoFiltro || String(merma.tipo || '').toLowerCase().includes(tipoFiltro));
}

async function mermasSupabase({ desde, hasta, tipoFiltro }) {
  const filas = await todasLasFilas(() => {
    let consulta = repository.table('mermas').select('*');
    if (desde) {
      consulta = consulta.gte('fecha', desde);
    }
    if (hasta) {
      consulta = consulta.lte('fecha', hasta);
    }
    return consulta.eq('estado', 'aprobada').order('id', { ascending: true });
  }, 'las mermas del rango');

  const tipos = await porIds(
    'tipos_merma',
    filas.map((fila) => fila.tipo_merma_id),
    'id, nombre',
  );

  return filas
    .map((fila) => {
      const tipo = tipos.get(fila.tipo_merma_id);
      return { ...fila, tipo: tipo ? tipo.nombre : null };
    })
    .filter((merma) => !tipoFiltro || String(merma.tipo || '').toLowerCase().includes(tipoFiltro));
}

async function reporteMerma(query) {
  const { desde, hasta } = rango(query);
  const tipoFiltro = query.tipo ? String(query.tipo).toLowerCase() : '';
  const mermas = db.isSupabase()
    ? await mermasSupabase({ desde, hasta, tipoFiltro })
    : reporteMermaMemoria({ desde, hasta, tipoFiltro });

  const porTipo = new Map();
  const porClasificacion = new Map();
  for (const merma of mermas) {
    const tipo = merma.tipo || 'sin_tipo';
    const actualTipo = porTipo.get(tipo) || { tipo, registros: 0, costo: 0 };
    actualTipo.registros += 1;
    actualTipo.costo = store.round2(actualTipo.costo + aNumero(merma.costo_estimado));
    porTipo.set(tipo, actualTipo);

    const clasificacion = merma.clasificacion;
    const actualClasificacion = porClasificacion.get(clasificacion) || {
      clasificacion,
      registros: 0,
      costo: 0,
    };
    actualClasificacion.registros += 1;
    actualClasificacion.costo = store.round2(
      actualClasificacion.costo + aNumero(merma.costo_estimado),
    );
    porClasificacion.set(clasificacion, actualClasificacion);
  }

  return {
    tipo: 'merma',
    desde: desde || null,
    hasta: hasta || null,
    total_costo: store.round2(
      mermas.reduce((suma, merma) => suma + aNumero(merma.costo_estimado), 0),
    ),
    registros: mermas.length,
    por_tipo: Array.from(porTipo.values()),
    por_clasificacion: Array.from(porClasificacion.values()),
    meta: metaRango(desde, hasta),
  };
}

// ---------------------------------------------------------------------
// Devoluciones
// ---------------------------------------------------------------------
function devolucionesMemoria({ desde, hasta }) {
  return store.state.devoluciones.filter((item) => enRango(item.fecha_reporte, desde, hasta));
}

async function devolucionesSupabase({ desde, hasta }) {
  const { inicio, fin } = rangoTimestamps({ desde, hasta });
  return todasLasFilas(() => {
    let consulta = repository.table('devoluciones').select('*');
    if (inicio) {
      consulta = consulta.gte('fecha_reporte', inicio);
    }
    if (fin) {
      consulta = consulta.lt('fecha_reporte', fin);
    }
    return consulta.order('fecha_reporte', { ascending: false }).order('id', { ascending: false });
  }, 'las devoluciones del rango');
}

async function reporteDevoluciones(query) {
  const { desde, hasta } = rango(query);
  const items = db.isSupabase()
    ? await devolucionesSupabase({ desde, hasta })
    : devolucionesMemoria({ desde, hasta });

  const porEstado = new Map();
  const porResolucion = new Map();
  for (const item of items) {
    const estado = porEstado.get(item.estado) || { estado: item.estado, registros: 0 };
    estado.registros += 1;
    porEstado.set(item.estado, estado);

    const clave = item.resolucion || 'sin_resolucion';
    const resolucion = porResolucion.get(clave) || {
      resolucion: clave,
      registros: 0,
      reembolsado: 0,
    };
    resolucion.registros += 1;
    resolucion.reembolsado = store.round2(
      resolucion.reembolsado + aNumero(item.monto_reembolsado),
    );
    porResolucion.set(clave, resolucion);
  }

  return {
    tipo: 'devoluciones',
    desde: desde || null,
    hasta: hasta || null,
    registros: items.length,
    monto_reembolsado: store.round2(
      items.reduce((suma, item) => suma + aNumero(item.monto_reembolsado), 0),
    ),
    por_estado: Array.from(porEstado.values()),
    por_resolucion: Array.from(porResolucion.values()),
    detalle: items.map((item) => ({
      id: item.id,
      pedido_id: item.pedido_id,
      motivo: item.motivo,
      estado: item.estado,
      resolucion: item.resolucion,
      monto_reembolsado: aNumero(item.monto_reembolsado),
      fecha: item.fecha_reporte,
    })),
    meta: metaRango(desde, hasta),
  };
}

// ---------------------------------------------------------------------
// Inventario (foto del stock actual: no aplica rango de fechas)
// ---------------------------------------------------------------------
function inventarioDesdeInsumos(insumos) {
  const activos = insumos.filter((insumo) => insumo.activo !== false);
  const porCategoria = new Map();

  for (const insumo of activos) {
    const actual = porCategoria.get(insumo.categoria) || {
      categoria: insumo.categoria,
      insumos: 0,
      valor: 0,
    };
    actual.insumos += 1;
    actual.valor = store.round2(
      actual.valor + aNumero(insumo.stock_actual) * aNumero(insumo.costo_promedio),
    );
    porCategoria.set(insumo.categoria, actual);
  }

  return {
    tipo: 'inventario',
    total_insumos: activos.length,
    valor_total: store.round2(
      activos.reduce(
        (suma, insumo) =>
          suma + aNumero(insumo.stock_actual) * aNumero(insumo.costo_promedio),
        0,
      ),
    ),
    bajo_minimo: activos.filter(
      (insumo) => aNumero(insumo.stock_actual) <= aNumero(insumo.stock_minimo),
    ).length,
    por_categoria: Array.from(porCategoria.values()),
    insumos: activos.map((insumo) => {
      const stockActual = aNumero(insumo.stock_actual);
      const stockMinimo = aNumero(insumo.stock_minimo);
      return {
        id: insumo.id,
        codigo: insumo.codigo,
        nombre: insumo.nombre,
        categoria: insumo.categoria,
        unidad_medida: insumo.unidad_medida,
        stock_actual: stockActual,
        stock_minimo: stockMinimo,
        costo_promedio: aNumero(insumo.costo_promedio),
        valor: store.round2(stockActual * aNumero(insumo.costo_promedio)),
        estado:
          stockActual <= stockMinimo && stockMinimo > 0
            ? stockActual <= stockMinimo * 0.5
              ? 'critico'
              : 'bajo'
            : 'ok',
      };
    }),
    meta: {
      limitacion:
        'El reporte de inventario es una foto del stock actual; el rango desde/hasta no aplica.',
    },
  };
}

async function reporteInventario() {
  if (!db.isSupabase()) {
    return inventarioDesdeInsumos(store.state.insumos);
  }

  const insumos = await todasLasFilas(
    () =>
      repository
        .table('insumos')
        .select('id, codigo, nombre, categoria, unidad_medida, stock_actual, stock_minimo, costo_promedio, activo')
        .eq('activo', true)
        .order('id', { ascending: true }),
    'los insumos',
  );

  return inventarioDesdeInsumos(insumos);
}

// ---------------------------------------------------------------------
// Activos (foto del estado actual: no aplica rango de fechas)
// ---------------------------------------------------------------------
function mesesEntre(fecha, referencia = new Date()) {
  const start = new Date(`${fecha}T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    return 0;
  }
  return Math.max(
    0,
    (referencia.getFullYear() - start.getFullYear()) * 12 + referencia.getMonth() - start.getMonth(),
  );
}

function activosDesdeFilas(activos, mantenimientos) {
  const porCategoria = new Map();
  for (const activo of activos) {
    const actual = porCategoria.get(activo.categoria) || {
      categoria: activo.categoria,
      activos: 0,
      valor: 0,
    };
    actual.activos += 1;
    actual.valor = store.round2(
      actual.valor + aNumero(activo.costo_adquisicion) * aNumero(activo.cantidad),
    );
    porCategoria.set(activo.categoria, actual);
  }

  return {
    tipo: 'activos',
    total_activos: activos.length,
    valor_adquisicion: store.round2(
      activos.reduce(
        (suma, activo) => suma + aNumero(activo.costo_adquisicion) * aNumero(activo.cantidad),
        0,
      ),
    ),
    en_reparacion: activos.filter((activo) => activo.estado === 'en_reparacion').length,
    dados_de_baja: activos.filter((activo) => activo.estado === 'dado_de_baja').length,
    costo_mantenimientos: store.round2(
      mantenimientos.reduce((suma, item) => suma + aNumero(item.costo_reparacion), 0),
    ),
    por_categoria: Array.from(porCategoria.values()),
    activos: activos.map((activo) => ({
      id: activo.id,
      nombre: activo.nombre,
      categoria: activo.categoria,
      estado: activo.estado,
      cantidad: aNumero(activo.cantidad),
      vida_util_meses: activo.vida_util_meses,
      antiguedad_meses: mesesEntre(activo.fecha_adquisicion),
      vida_util_vencida:
        activo.vida_util_meses !== null
        && mesesEntre(activo.fecha_adquisicion) > activo.vida_util_meses,
      mantenimientos: mantenimientos.filter((item) => item.activo_id === activo.id).length,
    })),
    meta: {
      limitacion:
        'El reporte de activos es una foto del estado actual; el rango desde/hasta no aplica.',
    },
  };
}

async function reporteActivos() {
  if (!db.isSupabase()) {
    return activosDesdeFilas(store.state.activos, store.state.mantenimientos);
  }

  const [activos, mantenimientos] = await Promise.all([
    todasLasFilas(
      () =>
        repository
          .table('activos')
          .select('id, nombre, categoria, cantidad, costo_adquisicion, vida_util_meses, fecha_adquisicion, estado')
          .order('id', { ascending: true }),
      'los activos',
    ),
    todasLasFilas(
      () => repository.table('mantenimientos').select('id, activo_id, costo_reparacion'),
      'los mantenimientos',
    ),
  ]);

  return activosDesdeFilas(activos, mantenimientos);
}

// ---------------------------------------------------------------------
// Personal (foto de usuarios activos: no aplica rango de fechas)
// ---------------------------------------------------------------------
function personalDesdeFilas(usuarios) {
  const porRol = new Map();
  for (const usuario of usuarios) {
    for (const rol of usuario.roles || []) {
      const actual = porRol.get(rol) || { rol, usuarios: 0 };
      actual.usuarios += 1;
      porRol.set(rol, actual);
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
      roles: usuario.roles || [],
      permisos: Array.isArray(usuario.permisos) ? usuario.permisos.length : aNumero(usuario.permisos),
      activo: usuario.activo,
      ultimo_acceso: usuario.ultimo_acceso,
    })),
    meta: {
      limitacion:
        'El reporte de personal es una foto de los usuarios activos; el rango desde/hasta no aplica.',
    },
  };
}

async function personalSupabase() {
  const [usuarios, usuarioRol, roles, rolPermiso, permisos] = await Promise.all([
    todasLasFilas(
      () =>
        repository
          .table('usuarios')
          .select('id, nombre, email, activo, ultimo_acceso')
          .eq('activo', true)
          .order('id', { ascending: true }),
      'los usuarios',
    ),
    todasLasFilas(
      () => repository.table('usuario_rol').select('usuario_id, rol_id'),
      'la asignación de roles',
    ),
    todasLasFilas(() => repository.table('roles').select('id, nombre'), 'los roles'),
    todasLasFilas(
      () => repository.table('rol_permiso').select('rol_id, permiso_id'),
      'los permisos por rol',
    ),
    todasLasFilas(() => repository.table('permisos').select('id, codigo'), 'los permisos'),
  ]);

  const nombreRol = new Map(roles.map((rol) => [rol.id, rol.nombre]));
  const codigoPermiso = new Map(permisos.map((permiso) => [permiso.id, permiso.codigo]));

  const rolesPorUsuario = new Map();
  for (const asignacion of usuarioRol) {
    if (!rolesPorUsuario.has(asignacion.usuario_id)) {
      rolesPorUsuario.set(asignacion.usuario_id, []);
    }
    rolesPorUsuario.get(asignacion.usuario_id).push(asignacion.rol_id);
  }

  const permisosPorRol = new Map();
  for (const asignacion of rolPermiso) {
    if (!permisosPorRol.has(asignacion.rol_id)) {
      permisosPorRol.set(asignacion.rol_id, new Set());
    }
    const codigo = codigoPermiso.get(asignacion.permiso_id);
    if (codigo) {
      permisosPorRol.get(asignacion.rol_id).add(codigo);
    }
  }

  const filas = usuarios.map((usuario) => {
    const idsRoles = rolesPorUsuario.get(usuario.id) || [];
    const nombresRoles = idsRoles
      .map((id) => nombreRol.get(id))
      .filter(Boolean)
      .sort();
    const permisosUsuario = new Set();
    for (const idRol of idsRoles) {
      for (const codigo of permisosPorRol.get(idRol) || []) {
        permisosUsuario.add(codigo);
      }
    }
    return {
      id: usuario.id,
      nombre: usuario.nombre,
      email: usuario.email,
      roles: nombresRoles,
      permisos: [...permisosUsuario],
      activo: usuario.activo,
      ultimo_acceso: usuario.ultimo_acceso,
    };
  });

  return filas;
}

async function reportePersonal() {
  const usuarios = db.isSupabase()
    ? await personalSupabase()
    : store.state.usuarios.filter((usuario) => usuario.activo);
  return personalDesdeFilas(usuarios);
}

async function obtenerReporte(tipo, query = {}) {
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
      throw new AppError(
        404,
        'NOT_FOUND',
        `El reporte "${tipo}" no existe. Tipos válidos: ${TIPOS.join(', ')}.`,
      );
  }
}

module.exports = { TIPOS, obtenerReporte };
