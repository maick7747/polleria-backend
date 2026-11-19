'use strict';

// Delivery externo (Rappi / LlamaFood) con doble modo de persistencia.
// - DB_MODE=memory   -> store.js (comportamiento histórico).
// - DB_MODE=supabase -> repository/pedidos-db.
//
// Las liquidaciones viven en la tabla `liquidaciones` (migración 009): el alta
// guarda el cálculo y el listado lee filas persistidas. Las columnas
// `motivo_cancelacion`/`fecha_cancelacion` de `pedidos` también existen.
//
// Desde la migración 021 la liquidación puede ser **por pedidos**: se eligen
// los pedidos pendientes de una plataforma, se suman bruto/comisión/neto, se
// compara con el depósito real (`monto_depositado` → `diferencia`) y cada
// pedido queda ligado con `pedidos.liquidacion_id` + `liquidado_en`. El alta
// por monto manual (`monto_bruto`) se conserva para compatibilidad.

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredNumber,
  requiredEnum,
  optionalString,
  optionalDate,
  paginate,
  pageParams,
  parseId,
  parseSort,
} = require('../../middleware/validate');
const pedidosLib = require('../../lib/pedidos');
const pedidosDb = require('../../lib/pedidos-db');
const deliveryPropio = require('../delivery-propio/delivery-propio.service');

const PLATAFORMAS = ['rappi', 'llamafood'];
const ESTADOS = ['borrador', 'en_cocina', 'servido', 'cobrado', 'cancelado'];
const CAMPOS_ORDEN = ['id', 'fecha_pedido', 'total', 'estado'];
const CAMPOS_ORDEN_LIQUIDACION = ['id', 'creado_en', 'monto_neto'];

function aNumero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function claveComision(plataforma) {
  return plataforma === 'rappi' ? 'comision_rappi_pct' : 'comision_llamafood_pct';
}

async function tasaComision(plataforma) {
  return (Number(await db.getConfig(claveComision(plataforma))) || 0) / 100;
}

function valorOrden(fila, campo) {
  if (campo === 'id' || campo === 'total') {
    return aNumero(fila[campo]);
  }
  const valor = fila[campo];
  return valor === null || valor === undefined ? '' : String(valor);
}

function ordenarPedidos(filas, campo, ascending) {
  const direccion = ascending ? 1 : -1;
  return [...filas].sort((izq, der) => {
    const a = valorOrden(izq, campo);
    const b = valorOrden(der, campo);
    if (a < b) return -1 * direccion;
    if (a > b) return 1 * direccion;
    return aNumero(der.id) - aNumero(izq.id);
  });
}

function filtrosPedidos(query = {}) {
  const plataforma = query.plataforma
    ? requiredEnum(query.plataforma, 'plataforma', PLATAFORMAS)
    : null;
  const estado = query.estado
    ? requiredEnum(query.estado, 'estado', ESTADOS)
    : null;
  const desde = optionalDate(query.desde, 'desde') || null;
  const hasta = optionalDate(query.hasta, 'hasta') || null;
  const { campo, ascending } = parseSort(query.sort, CAMPOS_ORDEN, 'fecha_pedido:desc', 'sort');
  return { plataforma, estado, desde, hasta, sort: campo, ascending };
}

function metaFiltros(filtros) {
  return {
    plataforma: filtros.plataforma,
    estado: filtros.estado,
    desde: filtros.desde,
    hasta: filtros.hasta,
    sort: `${filtros.sort}:${filtros.ascending ? 'asc' : 'desc'}`,
  };
}

function conComision(pedidoDto, tasa) {
  const bruto = aNumero(pedidoDto.total);
  const comision = db.round2(bruto * tasa);
  return {
    ...pedidoDto,
    comision_pct: db.round2(tasa * 100),
    monto_bruto: bruto,
    comision,
    monto_neto: db.round2(bruto - comision),
  };
}

// Comisión realmente cobrada por la plataforma: manda la persistida en
// `pedidos.comision_plataforma`; si es 0 (filas anteriores o alta sin tasa) se
// recalcula con la tasa vigente.
function comisionDePedido(pedido, tasa) {
  const guardada = aNumero(pedido.comision_plataforma);
  return guardada > 0 ? db.round2(guardada) : db.round2(aNumero(pedido.total) * tasa);
}

// Variante de conComision para liquidaciones: usa la comisión del pedido (no la
// tasa del momento) para que el neto del pedido y el de la liquidación cuadren.
function conComisionReal(pedidoDto, tasa) {
  const bruto = aNumero(pedidoDto.total);
  const comision = comisionDePedido(pedidoDto, tasa);
  return {
    ...pedidoDto,
    comision_pct: db.round2(tasa * 100),
    monto_bruto: bruto,
    comision,
    monto_neto: db.round2(bruto - comision),
  };
}

function tasasMemoria() {
  return {
    rappi: (Number(store.getConfig(claveComision('rappi'))) || 0) / 100,
    llamafood: (Number(store.getConfig(claveComision('llamafood'))) || 0) / 100,
  };
}

async function tasasPorPlataforma(plataforma) {
  const tasas = {};
  for (const canal of (plataforma ? [plataforma] : PLATAFORMAS)) {
    tasas[canal] = await tasaComision(canal);
  }
  return tasas;
}

function diaDe(fecha) {
  return fecha === null || fecha === undefined ? null : String(fecha).slice(0, 10);
}

// PostgREST devuelve 42703/PGRST204 cuando falta una columna (migración sin
// aplicar). Sirve para degradar con un mensaje claro en lugar de un 500.
function esColumnaInexistente(error) {
  if (!error) {
    return false;
  }
  const codigo = error.code === undefined || error.code === null ? '' : String(error.code);
  if (codigo === '42703' || codigo === 'PGRST204') {
    return true;
  }
  const texto = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`;
  return /column .* does not exist/i.test(texto) || /Could not find the '[^']+' column/i.test(texto);
}

function listPedidosMemoria(filtros, query) {
  const tasas = tasasMemoria();

  const filas = store.state.pedidos
    .filter((pedido) => PLATAFORMAS.includes(pedido.canal))
    .filter((pedido) => !filtros.plataforma || pedido.canal === filtros.plataforma)
    .filter((pedido) => !filtros.estado || pedido.estado === filtros.estado)
    .filter((pedido) => {
      if (!filtros.desde && !filtros.hasta) {
        return true;
      }
      const dia = String(pedido.fecha_pedido).slice(0, 10);
      return (!filtros.desde || dia >= filtros.desde) && (!filtros.hasta || dia <= filtros.hasta);
    });

  const ordenadas = ordenarPedidos(filas, filtros.sort, filtros.ascending);
  const resultado = paginate(ordenadas, query);

  return {
    data: resultado.data.map((pedido) =>
      conComision(pedidosLib.pedidoConDetalles(pedido), tasas[pedido.canal] || 0)),
    meta: { ...resultado.meta, filtros: metaFiltros(filtros) },
  };
}

async function enriquecerPedidos(filas) {
  if (filas.length === 0) {
    return [];
  }

  const pedidoIds = filas.map((fila) => fila.id);
  const clienteIds = [...new Set(filas.map((fila) => fila.cliente_id).filter(Boolean))];
  const repartidorIds = [...new Set(filas.map((fila) => fila.repartidor_id).filter(Boolean))];

  const [clientes, repartidores, detalles] = await Promise.all([
    clienteIds.length
      ? repository.list('clientes', { filters: { id: clienteIds }, limit: 1000 })
      : { data: [] },
    repartidorIds.length
      ? repository.list('usuarios', { filters: { id: repartidorIds }, limit: 1000 })
      : { data: [] },
    repository.list('pedido_detalles', {
      filters: { pedido_id: pedidoIds },
      orderBy: 'id',
      ascending: true,
      limit: 1000,
    }),
  ]);

  const platilloIds = [...new Set((detalles.data || []).map((item) => item.platillo_id))];
  const platillos = platilloIds.length
    ? await repository.list('platillos', { filters: { id: platilloIds }, limit: 1000 })
    : { data: [] };

  const clientesPorId = new Map((clientes.data || []).map((item) => [item.id, item]));
  const repartidoresPorId = new Map((repartidores.data || []).map((item) => [item.id, item]));
  const platillosPorId = new Map((platillos.data || []).map((item) => [item.id, item]));

  const detallesPorPedido = new Map();
  for (const detalle of detalles.data || []) {
    const lista = detallesPorPedido.get(detalle.pedido_id) || [];
    lista.push(detalle);
    detallesPorPedido.set(detalle.pedido_id, lista);
  }

  return filas.map((fila) => {
    const cliente = clientesPorId.get(fila.cliente_id);
    const repartidor = repartidoresPorId.get(fila.repartidor_id);
    const lineas = (detallesPorPedido.get(fila.id) || []).map((detalle) => {
      const platillo = platillosPorId.get(detalle.platillo_id);
      return {
        ...detalle,
        cantidad: Number(detalle.cantidad),
        precio_unitario: aNumero(detalle.precio_unitario),
        subtotal: aNumero(detalle.subtotal),
        platillo_nombre: platillo ? platillo.nombre : null,
      };
    });
    return {
      ...fila,
      subtotal: aNumero(fila.subtotal),
      igv: aNumero(fila.igv),
      total: aNumero(fila.total),
      comision_plataforma: aNumero(fila.comision_plataforma),
      costo_delivery: aNumero(fila.costo_delivery),
      mesa_numero: null,
      cliente_nombre: cliente ? cliente.nombre : null,
      repartidor_nombre: repartidor ? repartidor.nombre : null,
      detalles: lineas,
    };
  });
}

async function listPedidosSupabase(filtros, query) {
  const { page, limit } = pageParams(query);

  let consulta = repository
    .table('pedidos')
    .select('*', { count: 'exact' })
    .in('canal', filtros.plataforma ? [filtros.plataforma] : PLATAFORMAS);

  if (filtros.estado) {
    consulta = consulta.eq('estado', filtros.estado);
  }
  if (filtros.desde) {
    consulta = consulta.gte('fecha_pedido', `${filtros.desde}T00:00:00`);
  }
  if (filtros.hasta) {
    consulta = consulta.lte('fecha_pedido', `${filtros.hasta}T23:59:59.999`);
  }

  consulta = consulta
    .order(filtros.sort, { ascending: filtros.ascending })
    .order('id', { ascending: false });

  const inicio = (page - 1) * limit;
  const { data, error, count } = await consulta.range(inicio, inicio + limit - 1);
  if (error) {
    throw db.persistenceError('No se pudieron listar los pedidos de delivery externo.', error);
  }

  const filas = data || [];
  const enriquecidos = await enriquecerPedidos(filas);

  // Las tasas se leen una sola vez por plataforma (getConfig tiene cache TTL).
  const tasas = await tasasPorPlataforma(filtros.plataforma);

  const total = typeof count === 'number' ? count : filas.length;
  return {
    data: enriquecidos.map((pedido) =>
      conComision(pedido, tasas[pedido.canal] || 0)),
    meta: {
      page,
      limit,
      total,
      pages: total === 0 ? 0 : Math.ceil(total / limit),
      filtros: metaFiltros(filtros),
    },
  };
}

async function listPedidos(query = {}) {
  const filtros = filtrosPedidos(query);
  if (db.isSupabase()) {
    return listPedidosSupabase(filtros, query);
  }
  return listPedidosMemoria(filtros, query);
}

async function crearPedido(body, usuario) {
  const payload = requiredObject(body);
  const plataforma = requiredEnum(payload.plataforma || payload.canal, 'plataforma', PLATAFORMAS);
  await db.requireCajaAbierta();

  const cliente = payload.cliente ? await deliveryPropio.crearCliente(payload.cliente) : null;
  const direccion = payload.direccion_entrega
    || (payload.cliente && payload.cliente.direccion)
    || null;

  if (!direccion) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El delivery externo requiere dirección de entrega.', [
      { field: 'direccion_entrega' },
    ]);
  }

  const tasa = await tasaComision(plataforma);

  if (db.isSupabase()) {
    const { pedido, detalles } = await deliveryPropio.crearPedidoBaseSupabase({
      canal: plataforma,
      tipo_consumo: 'delivery',
      items: payload.items,
      cliente_id: cliente ? cliente.id : null,
      usuario_id: usuario.id,
      observaciones: payload.observaciones,
      direccion_entrega: direccion,
      referencia_entrega: payload.referencia_entrega || null,
      comisionPct: tasa,
    });

    const dto = await pedidosDb.pedidoConDetalles(pedido, { detalles });
    return conComision(dto, tasa);
  }

  const pedido = pedidosLib.createPedidoRecord({
    canal: plataforma,
    tipo_consumo: 'delivery',
    items: payload.items,
    cliente_id: cliente ? cliente.id : null,
    usuario_id: usuario.id,
    observaciones: payload.observaciones,
    direccion_entrega: direccion,
    referencia_entrega: payload.referencia_entrega || null,
  });

  const comision = store.round2(pedido.total * tasa);
  pedido.comision_plataforma = comision;
  pedido.monto_neto = store.round2(pedido.total - comision);

  return {
    ...pedidosLib.pedidoConDetalles(pedido),
    comision_pct: store.round2(tasa * 100),
    monto_bruto: pedido.total,
    comision,
    monto_neto: pedido.monto_neto,
  };
}

async function aceptarPedido(id, usuario) {
  const pedido = await db.findOrThrow('pedidos', parseId(id), 'Pedido');
  if (pedido.estado !== 'borrador') {
    throw new AppError(409, 'CONFLICT', 'Solo un pedido en borrador puede aceptarse.');
  }

  // La respuesta incluye comisión/neto para que la bandeja no muestre 0 %
  // entre el accept y la recarga del listado.
  const tasa = await tasaComision(pedido.canal);

  if (db.isSupabase()) {
    const resultado = await pedidosDb.enviarPedidoACocina(pedido, usuario.id);
    const dto = await pedidosDb.pedidoConDetalles(resultado.pedido, {
      detalles: resultado.detalles,
    });
    return {
      ...conComision(dto, tasa),
      movimientos_inventario: resultado.movimientos.length,
    };
  }

  const resultado = pedidosLib.enviarPedidoACocina(pedido, usuario.id);
  return {
    ...conComision(pedidosLib.pedidoConDetalles(resultado.pedido), tasa),
    movimientos_inventario: resultado.movimientos.length,
  };
}

async function cancelarPedido(id, body, usuario) {
  const pedido = await db.findOrThrow('pedidos', parseId(id), 'Pedido');
  const payload = requiredObject(body || {});
  const motivo = optionalString(payload.motivo, 'motivo', { max: 300 });

  if (pedido.estado === 'cancelado') {
    throw new AppError(409, 'CONFLICT', 'El pedido ya está cancelado.');
  }

  const motivoReversa = motivo || 'Cancelación de delivery externo';

  if (!db.isSupabase()) {
    const movimientos = pedidosLib.revertirStockPedido(pedido, usuario.id, motivoReversa);
    pedido.estado = 'cancelado';
    pedido.fecha_cancelacion = store.nowIso();
    pedido.motivo_cancelacion = motivo;

    return {
      ...pedidosLib.pedidoConDetalles(pedido),
      movimientos_inventario: movimientos.length,
      stock_revertido: movimientos.length > 0,
    };
  }

  // Reversa automática: solo repone stock si el pedido había descontado
  // (pedidos-db comprueba los movimientos de salida existentes). Se sigue el
  // orden histórico (reversa y luego marcar cancelado), sin transacción: si el
  // UPDATE falla, el stock ya quedó repuesto y el error lo informa.
  const movimientos = await pedidosDb.revertirStockPedido(pedido, usuario.id, motivoReversa);
  const fechaCancelacion = db.nowIso();

  let actualizado;
  try {
    actualizado = await repository.update('pedidos', pedido.id, {
      estado: 'cancelado',
      motivo_cancelacion: motivo,
      fecha_cancelacion: fechaCancelacion,
    });
  } catch (error) {
    throw db.persistenceError(
      'Se repuso el stock pero no se pudo marcar el pedido como cancelado.',
      error,
    );
  }

  const dto = await pedidosDb.pedidoConDetalles(actualizado || { ...pedido, estado: 'cancelado' });
  return {
    ...dto,
    motivo_cancelacion: motivo,
    fecha_cancelacion: fechaCancelacion,
    movimientos_inventario: movimientos.length,
    stock_revertido: movimientos.length > 0,
  };
}

function valorOrdenLiquidacion(fila, campo) {
  if (campo === 'id' || campo === 'monto_neto') {
    return aNumero(fila[campo]);
  }
  const valor = fila[campo];
  return valor === null || valor === undefined ? '' : String(valor);
}

function ordenarLiquidaciones(filas, campo, ascending) {
  const direccion = ascending ? 1 : -1;
  return [...filas].sort((izq, der) => {
    const a = valorOrdenLiquidacion(izq, campo);
    const b = valorOrdenLiquidacion(der, campo);
    if (a < b) return -1 * direccion;
    if (a > b) return 1 * direccion;
    return aNumero(der.id) - aNumero(izq.id);
  });
}

function liquidacionDTO(fila) {
  const depositado = fila.monto_depositado === undefined || fila.monto_depositado === null
    ? null
    : db.round2(aNumero(fila.monto_depositado));
  const neto = db.round2(aNumero(fila.monto_neto));
  const diferencia = fila.diferencia === undefined || fila.diferencia === null
    ? (depositado === null ? null : db.round2(depositado - neto))
    : db.round2(aNumero(fila.diferencia));
  const pedidos = Number(fila.pedidos);

  return {
    ...fila,
    pedidos: Number.isFinite(pedidos) ? pedidos : 0,
    monto_bruto: db.round2(aNumero(fila.monto_bruto)),
    comision: db.round2(aNumero(fila.comision)),
    monto_neto: neto,
    monto_depositado: depositado,
    referencia: fila.referencia === undefined ? null : fila.referencia,
    diferencia,
    estado: fila.estado || 'registrada',
  };
}

// ---------------------------------------------------------------------
// Liquidación por pedidos: pendientes y detalle
// ---------------------------------------------------------------------
function filtrosPendientes(query = {}) {
  const plataforma = query.plataforma
    ? requiredEnum(query.plataforma, 'plataforma', PLATAFORMAS)
    : null;
  const desde = optionalDate(query.desde, 'desde') || null;
  const hasta = optionalDate(query.hasta, 'hasta') || null;
  return { plataforma, desde, hasta };
}

function metaPendientes(data, filtros) {
  return {
    total: data.length,
    bruto: db.round2(data.reduce((suma, pedido) => suma + aNumero(pedido.monto_bruto), 0)),
    comision: db.round2(data.reduce((suma, pedido) => suma + aNumero(pedido.comision), 0)),
    neto: db.round2(data.reduce((suma, pedido) => suma + aNumero(pedido.monto_neto), 0)),
    filtros: {
      plataforma: filtros.plataforma,
      desde: filtros.desde,
      hasta: filtros.hasta,
    },
  };
}

function enRango(fecha, filtros) {
  if (!filtros.desde && !filtros.hasta) {
    return true;
  }
  const dia = diaDe(fecha);
  return (!filtros.desde || dia >= filtros.desde) && (!filtros.hasta || dia <= filtros.hasta);
}

// Pendientes = pedidos de Rappi/LlamaFood no cancelados y sin liquidación.
// Se ordenan del más antiguo al más nuevo para conciliar en orden cronológico.
function listPendientesLiquidarMemoria(filtros) {
  const tasas = tasasMemoria();
  const filas = (store.state.pedidos || [])
    .filter((pedido) => PLATAFORMAS.includes(pedido.canal))
    .filter((pedido) => pedido.estado !== 'cancelado')
    .filter((pedido) => pedido.liquidacion_id === undefined || pedido.liquidacion_id === null)
    .filter((pedido) => !filtros.plataforma || pedido.canal === filtros.plataforma)
    .filter((pedido) => enRango(pedido.fecha_pedido, filtros))
    .sort((izq, der) => {
      const fecha = String(izq.fecha_pedido).localeCompare(String(der.fecha_pedido));
      return fecha !== 0 ? fecha : aNumero(izq.id) - aNumero(der.id);
    });

  const data = filas.map((pedido) =>
    conComisionReal(pedidosLib.pedidoConDetalles(pedido), tasas[pedido.canal] || 0));

  return { data, meta: metaPendientes(data, filtros) };
}

async function listPendientesLiquidarSupabase(filtros) {
  let consulta = repository
    .table('pedidos')
    .select('*', { count: 'exact' })
    .in('canal', filtros.plataforma ? [filtros.plataforma] : PLATAFORMAS)
    .neq('estado', 'cancelado')
    .is('liquidacion_id', null);

  if (filtros.desde) {
    consulta = consulta.gte('fecha_pedido', `${filtros.desde}T00:00:00-05:00`);
  }
  if (filtros.hasta) {
    consulta = consulta.lte('fecha_pedido', `${filtros.hasta}T23:59:59.999-05:00`);
  }

  const { data, error } = await consulta
    .order('fecha_pedido', { ascending: true })
    .order('id', { ascending: true })
    .limit(1000);

  if (error) {
    if (esColumnaInexistente(error)) {
      throw new AppError(
        503,
        'MIGRACION_PENDIENTE',
        'La liquidación por pedidos requiere la migración 021_liquidaciones_pedidos.sql.',
        [{ migracion: '021_liquidaciones_pedidos' }],
      );
    }
    throw db.persistenceError('No se pudieron listar los pedidos pendientes de liquidar.', error);
  }

  const enriquecidos = await enriquecerPedidos(data || []);
  const tasas = await tasasPorPlataforma(filtros.plataforma);
  const filas = enriquecidos.map((pedido) =>
    conComisionReal(pedido, tasas[pedido.canal] || 0));

  return { data: filas, meta: metaPendientes(filas, filtros) };
}

async function listPendientesLiquidar(query = {}) {
  const filtros = filtrosPendientes(query);
  if (db.isSupabase()) {
    return listPendientesLiquidarSupabase(filtros);
  }
  return listPendientesLiquidarMemoria(filtros);
}

// Pedidos ligados a una liquidación (detalle para conciliar/auditar).
async function getLiquidacionPedidos(id) {
  const liquidacionId = parseId(id, 'id');
  const liquidacion = await db.findOrThrow('liquidaciones', liquidacionId, 'Liquidación');
  const tasa = await tasaComision(liquidacion.plataforma);

  let filas;
  if (db.isSupabase()) {
    let data;
    try {
      ({ data } = await repository.list('pedidos', {
        filters: { liquidacion_id: liquidacionId },
        orderBy: 'fecha_pedido',
        ascending: true,
        limit: 1000,
      }));
    } catch (error) {
      if (esColumnaInexistente(error)) {
        throw new AppError(
          503,
          'MIGRACION_PENDIENTE',
          'El detalle por pedidos requiere la migración 021_liquidaciones_pedidos.sql.',
          [{ migracion: '021_liquidaciones_pedidos' }],
        );
      }
      throw db.persistenceError('No se pudieron listar los pedidos de la liquidación.', error);
    }
    filas = await enriquecerPedidos(data || []);
  } else {
    filas = (store.state.pedidos || [])
      .filter((pedido) => pedido.liquidacion_id === liquidacionId)
      .sort((izq, der) => {
        const fecha = String(izq.fecha_pedido).localeCompare(String(der.fecha_pedido));
        return fecha !== 0 ? fecha : aNumero(izq.id) - aNumero(der.id);
      })
      .map((pedido) => pedidosLib.pedidoConDetalles(pedido));
  }

  const data = filas.map((pedido) => conComisionReal(pedido, tasa));
  return {
    liquidacion: liquidacionDTO(liquidacion),
    data,
    meta: {
      total: data.length,
      bruto: db.round2(data.reduce((suma, pedido) => suma + aNumero(pedido.monto_bruto), 0)),
      comision: db.round2(data.reduce((suma, pedido) => suma + aNumero(pedido.comision), 0)),
      neto: db.round2(data.reduce((suma, pedido) => suma + aNumero(pedido.monto_neto), 0)),
    },
  };
}

function listLiquidacionesMemoria(filtros, query) {
  const filas = (store.state.liquidaciones || [])
    .filter((item) => !filtros.plataforma || item.plataforma === filtros.plataforma)
    // Solape del periodo liquidado con el rango pedido.
    .filter((item) => !filtros.desde || !item.hasta || item.hasta >= filtros.desde)
    .filter((item) => !filtros.hasta || !item.desde || item.desde <= filtros.hasta);

  const ordenadas = ordenarLiquidaciones(filas, filtros.sort, filtros.ascending);
  const resultado = paginate(ordenadas, query);
  return {
    data: resultado.data.map(liquidacionDTO),
    meta: {
      ...resultado.meta,
      origen: 'persistido',
      filtros: {
        plataforma: filtros.plataforma,
        desde: filtros.desde,
        hasta: filtros.hasta,
        sort: `${filtros.sort}:${filtros.ascending ? 'asc' : 'desc'}`,
      },
    },
  };
}

async function listLiquidacionesSupabase(filtros, query) {
  const { page, limit } = pageParams(query);

  let consulta = repository.table('liquidaciones').select('*', { count: 'exact' });
  if (filtros.plataforma) {
    consulta = consulta.eq('plataforma', filtros.plataforma);
  }
  if (filtros.desde) {
    consulta = consulta.or(`hasta.gte.${filtros.desde},hasta.is.null`);
  }
  if (filtros.hasta) {
    consulta = consulta.or(`desde.lte.${filtros.hasta},desde.is.null`);
  }
  consulta = consulta
    .order(filtros.sort, { ascending: filtros.ascending })
    .order('id', { ascending: false });

  const inicio = (page - 1) * limit;
  const { data, error, count } = await consulta.range(inicio, inicio + limit - 1);
  if (error) {
    throw db.persistenceError('No se pudieron listar las liquidaciones.', error);
  }

  const filas = data || [];
  const total = typeof count === 'number' ? count : filas.length;
  return {
    data: filas.map(liquidacionDTO),
    meta: {
      page,
      limit,
      total,
      pages: total === 0 ? 0 : Math.ceil(total / limit),
      origen: 'persistido',
      filtros: {
        plataforma: filtros.plataforma,
        desde: filtros.desde,
        hasta: filtros.hasta,
        sort: `${filtros.sort}:${filtros.ascending ? 'asc' : 'desc'}`,
      },
    },
  };
}

async function listLiquidaciones(query = {}) {
  const plataforma = query.plataforma
    ? requiredEnum(query.plataforma, 'plataforma', PLATAFORMAS)
    : null;
  const desde = optionalDate(query.desde, 'desde') || null;
  const hasta = optionalDate(query.hasta, 'hasta') || null;
  const { campo, ascending } = parseSort(
    query.sort,
    CAMPOS_ORDEN_LIQUIDACION,
    'creado_en:desc',
    'sort',
  );
  const filtros = { plataforma, desde, hasta, sort: campo, ascending };

  if (db.isSupabase()) {
    return listLiquidacionesSupabase(filtros, query);
  }
  return listLiquidacionesMemoria(filtros, query);
}

// Ids de pedidos a liquidar: arreglo no vacío, enteros >= 1 y sin repetidos.
function idsDeLiquidacion(value) {
  if (!Array.isArray(value)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El campo "pedido_ids" debe ser un arreglo de ids.', [
      { field: 'pedido_ids', value: value === undefined ? null : value },
    ]);
  }
  if (value.length > 500) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El campo "pedido_ids" admite como máximo 500 pedidos.', [
      { field: 'pedido_ids', value: value.length },
    ]);
  }
  const ids = value.map((id, indice) => parseId(id, `pedido_ids[${indice}]`));
  if (new Set(ids).size !== ids.length) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El campo "pedido_ids" no debe repetir pedidos.', [
      { field: 'pedido_ids' },
    ]);
  }
  return ids;
}

function fechaMinima(pedidos) {
  const dias = pedidos.map((pedido) => diaDe(pedido.fecha_pedido)).filter(Boolean).sort();
  return dias.length > 0 ? dias[0] : null;
}

function fechaMaxima(pedidos) {
  const dias = pedidos.map((pedido) => diaDe(pedido.fecha_pedido)).filter(Boolean).sort();
  return dias.length > 0 ? dias[dias.length - 1] : null;
}

async function pedidosPorIds(ids) {
  if (db.isSupabase()) {
    const { data } = await repository.list('pedidos', {
      filters: { id: ids },
      orderBy: 'fecha_pedido',
      ascending: true,
      limit: 1000,
    });
    return data;
  }
  return ids.map((id) => store.find('pedidos', id)).filter(Boolean);
}

// Alta por pedidos: la suma de los pedidos seleccionados reemplaza al monto
// manual y el depósito de la plataforma define si queda conciliada (diferencia).
async function crearLiquidacionPorPedidos(payload, ids, usuario) {
  const pedidos = await pedidosPorIds(ids);
  const porId = new Map(pedidos.map((pedido) => [Number(pedido.id), pedido]));

  const faltantes = ids.filter((id) => !porId.has(Number(id)));
  if (faltantes.length > 0) {
    throw new AppError(404, 'NOT_FOUND', 'Uno o más pedidos no existen.', [
      { pedido_ids: faltantes },
    ]);
  }

  const seleccionados = ids.map((id) => porId.get(Number(id)));

  const ajenos = seleccionados
    .filter((pedido) => !PLATAFORMAS.includes(pedido.canal))
    .map((pedido) => Number(pedido.id));
  if (ajenos.length > 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Solo se liquidan pedidos de Rappi o LlamaFood.', [
      { pedido_ids: ajenos },
    ]);
  }

  const plataformas = [...new Set(seleccionados.map((pedido) => pedido.canal))];
  if (plataformas.length > 1) {
    throw new AppError(
      409,
      'CONFLICT',
      'Los pedidos de una liquidación deben ser de la misma plataforma.',
      plataformas.map((plataforma) => ({ plataforma })),
    );
  }
  const plataformaPedidos = plataformas[0];

  if (payload.plataforma !== undefined && payload.plataforma !== null) {
    const enviada = requiredEnum(payload.plataforma, 'plataforma', PLATAFORMAS);
    if (enviada !== plataformaPedidos) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `La plataforma enviada (${enviada}) no coincide con la de los pedidos (${plataformaPedidos}).`,
        [{ field: 'plataforma', value: enviada }],
      );
    }
  }

  const cancelados = seleccionados
    .filter((pedido) => pedido.estado === 'cancelado')
    .map((pedido) => Number(pedido.id));
  if (cancelados.length > 0) {
    throw new AppError(409, 'CONFLICT', 'No se pueden liquidar pedidos cancelados.', [
      { pedido_ids: cancelados },
    ]);
  }

  const yaLiquidados = seleccionados
    .filter((pedido) => pedido.liquidacion_id !== undefined && pedido.liquidacion_id !== null)
    .map((pedido) => ({
      pedido_id: Number(pedido.id),
      liquidacion_id: Number(pedido.liquidacion_id),
    }));
  if (yaLiquidados.length > 0) {
    throw new AppError(409, 'CONFLICT', 'Uno o más pedidos ya pertenecen a otra liquidación.', yaLiquidados);
  }

  const tasa = await tasaComision(plataformaPedidos);
  const bruto = db.round2(seleccionados.reduce((suma, pedido) => suma + aNumero(pedido.total), 0));
  const comision = db.round2(
    seleccionados.reduce((suma, pedido) => suma + comisionDePedido(pedido, tasa), 0),
  );
  const neto = db.round2(bruto - comision);

  const sinDeposito = payload.monto_depositado === undefined || payload.monto_depositado === null;
  const depositado = sinDeposito
    ? neto
    : requiredNumber(payload.monto_depositado, 'monto_depositado', { min: 0 });
  const diferencia = db.round2(depositado - neto);

  const fila = {
    plataforma: plataformaPedidos,
    desde: optionalDate(payload.desde, 'desde') || fechaMinima(seleccionados),
    hasta: optionalDate(payload.hasta, 'hasta') || fechaMaxima(seleccionados),
    monto_bruto: bruto,
    comision,
    monto_neto: neto,
    estado: sinDeposito ? 'registrada' : 'conciliada',
    observacion: optionalString(payload.observacion, 'observacion', { max: 300 }),
    usuario_id: usuario.id,
    pedidos: seleccionados.length,
    monto_depositado: db.round2(depositado),
    referencia: optionalString(payload.referencia, 'referencia', { max: 60 }),
    diferencia,
  };

  if (!db.isSupabase()) {
    const liquidacion = {
      id: store.nextId('liquidaciones'),
      ...fila,
      creado_en: store.nowIso(),
    };
    store.state.liquidaciones.push(liquidacion);
    const ahora = store.nowIso();
    for (const pedido of seleccionados) {
      pedido.liquidacion_id = liquidacion.id;
      pedido.liquidado_en = ahora;
    }
    return { ...liquidacionDTO(liquidacion), persistido: true, origen: 'persistido' };
  }

  let creada;
  try {
    creada = await repository.insert('liquidaciones', fila);
  } catch (error) {
    if (esColumnaInexistente(error)) {
      throw new AppError(
        503,
        'MIGRACION_PENDIENTE',
        'La liquidación por pedidos requiere la migración 021_liquidaciones_pedidos.sql.',
        [{ migracion: '021_liquidaciones_pedidos' }],
      );
    }
    throw db.persistenceError('No se pudo registrar la liquidación.', error);
  }

  const liquidadoEn = db.nowIso();
  try {
    await repository.updateWhere(
      'pedidos',
      { id: ids },
      { liquidacion_id: creada.id, liquidado_en: liquidadoEn },
    );
  } catch (error) {
    // Compensación best-effort: una liquidación sin pedidos no debe quedar
    // registrada. Si la limpieza falla, el error original se informa igual.
    try {
      await repository.remove('liquidaciones', creada.id);
    } catch (limpieza) {
      // la liquidación queda huérfana; el error original se informa igual
    }
    throw db.persistenceError('No se pudieron ligar los pedidos a la liquidación.', error);
  }

  return { ...liquidacionDTO(creada), persistido: true, origen: 'persistido' };
}

// Inserta la liquidación manual. Si la migración 021 aún no está aplicada, se
// reintenta sin las columnas nuevas para no romper el contrato legado; el DTO
// devuelto rellena pedidos/monto_depositado/referencia/diferencia con defaults.
async function insertarLiquidacionSupabase(fila) {
  try {
    return await repository.insert('liquidaciones', fila);
  } catch (error) {
    if (!esColumnaInexistente(error)) {
      throw db.persistenceError('No se pudo registrar la liquidación.', error);
    }
    const { pedidos, monto_depositado, referencia, diferencia, ...legado } = fila;
    console.warn(
      '[delivery-externo] Migración 021 pendiente: la liquidación manual se guarda sin ' +
        'pedidos, monto depositado, referencia ni diferencia.',
    );
    try {
      return await repository.insert('liquidaciones', legado);
    } catch (errorLegado) {
      throw db.persistenceError('No se pudo registrar la liquidación.', errorLegado);
    }
  }
}

// Alta por monto manual (contrato histórico): no toca pedidos.
async function crearLiquidacionManual(payload, usuario) {
  const plataforma = requiredEnum(payload.plataforma, 'plataforma', PLATAFORMAS);
  const desde = optionalDate(payload.desde, 'desde')
    || optionalDate(payload.fecha, 'fecha')
    || null;
  const hasta = optionalDate(payload.hasta, 'hasta') || desde;
  const montoBruto = requiredNumber(payload.monto_bruto, 'monto_bruto', { min: 0.01 });
  const tasa = await tasaComision(plataforma);
  const comision = payload.comision === undefined
    ? db.round2(montoBruto * tasa)
    : requiredNumber(payload.comision, 'comision', { min: 0 });
  const montoNeto = db.round2(montoBruto - comision);
  const sinDeposito = payload.monto_depositado === undefined || payload.monto_depositado === null;
  const depositado = sinDeposito
    ? null
    : requiredNumber(payload.monto_depositado, 'monto_depositado', { min: 0 });
  const observacion = optionalString(
    payload.observacion !== undefined ? payload.observacion : payload.referencia,
    'observacion',
    { max: 300 },
  );

  const fila = {
    plataforma,
    desde,
    hasta,
    monto_bruto: db.round2(montoBruto),
    comision: db.round2(comision),
    monto_neto: montoNeto,
    estado: sinDeposito ? 'registrada' : 'conciliada',
    observacion,
    usuario_id: usuario.id,
    pedidos: 0,
    monto_depositado: depositado === null ? null : db.round2(depositado),
    referencia: optionalString(payload.referencia, 'referencia', { max: 60 }),
    diferencia: depositado === null ? null : db.round2(depositado - montoNeto),
  };

  if (!db.isSupabase()) {
    const liquidacion = {
      id: store.nextId('liquidaciones'),
      ...fila,
      creado_en: store.nowIso(),
    };
    store.state.liquidaciones.push(liquidacion);
    return { ...liquidacionDTO(liquidacion), persistido: true, origen: 'persistido' };
  }

  const creada = await insertarLiquidacionSupabase(fila);
  return { ...liquidacionDTO(creada), persistido: true, origen: 'persistido' };
}

async function crearLiquidacion(body, usuario) {
  const payload = requiredObject(body);
  const ids = payload.pedido_ids === undefined || payload.pedido_ids === null
    ? []
    : idsDeLiquidacion(payload.pedido_ids);

  if (ids.length > 0) {
    return crearLiquidacionPorPedidos(payload, ids, usuario);
  }
  return crearLiquidacionManual(payload, usuario);
}

// Marca la entrega del pedido externo (la confirma el mozo desde el sistema).
async function marcarEntregadoExterno(id, usuario) {
  const pedido = await db.findOrThrow('pedidos', parseId(id), 'Pedido');

  if (!PLATAFORMAS.includes(pedido.canal)) {
    throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'El pedido no es de delivery externo.');
  }
  if (pedido.estado === 'cancelado') {
    throw new AppError(409, 'CONFLICT', 'El pedido está cancelado.');
  }

  const tasa = await tasaComision(pedido.canal);
  const ahora = db.isSupabase() ? db.nowIso() : store.nowIso();

  if (db.isSupabase()) {
    let actualizado;
    try {
      actualizado = await repository.update('pedidos', pedido.id, {
        estado_entrega: 'entregado',
        fecha_entrega: pedido.fecha_entrega || ahora,
      });
    } catch (error) {
      throw db.persistenceError('No se pudo marcar la entrega del pedido externo.', error);
    }
    const dto = await pedidosDb.pedidoConDetalles(
      actualizado || { ...pedido, estado_entrega: 'entregado' },
    );
    return conComisionReal(dto, tasa);
  }

  pedido.estado_entrega = 'entregado';
  pedido.fecha_entrega = pedido.fecha_entrega || ahora;
  return conComisionReal(pedidosLib.pedidoConDetalles(pedido), tasa);
}

module.exports = {
  PLATAFORMAS,
  tasaComision,
  listPedidos,
  crearPedido,
  aceptarPedido,
  cancelarPedido,
  marcarEntregadoExterno,
  listPendientesLiquidar,
  getLiquidacionPedidos,
  listLiquidaciones,
  crearLiquidacion,
};
