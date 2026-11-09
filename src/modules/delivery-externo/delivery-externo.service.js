'use strict';

// Delivery externo (Rappi / LlamaFood) con doble modo de persistencia.
// - DB_MODE=memory   -> store.js (comportamiento histórico).
// - DB_MODE=supabase -> repository/pedidos-db.
//
// Limitación declarada: el esquema Supabase NO tiene tabla de liquidaciones.
// Por eso `GET/POST /liquidaciones` trabajan en modo derivado (cálculo sobre
// pedidos de delivery externo) y lo informan en `meta.limitacion`.
// Las columnas `motivo_cancelacion`/`fecha_cancelacion` tampoco existen: se
// intentan persistir y, si faltan, solo se guarda el estado `cancelado`
// (mismo criterio que compras.cancelar).

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
const LIMITACION_LIQUIDACIONES =
  'El esquema no tiene tabla de liquidaciones: los montos se derivan de los pedidos '
  + 'de delivery externo con estado distinto de cancelado. No representan la '
  + 'liquidación oficial de Rappi/LlamaFood ni descuentos o ajustes de la plataforma.';

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

function listPedidosMemoria(filtros, query) {
  const tasas = {
    rappi: (Number(store.getConfig(claveComision('rappi'))) || 0) / 100,
    llamafood: (Number(store.getConfig(claveComision('llamafood'))) || 0) / 100,
  };

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
  const tasas = {};
  for (const plataforma of (filtros.plataforma ? [filtros.plataforma] : PLATAFORMAS)) {
    tasas[plataforma] = await tasaComision(plataforma);
  }

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

  if (db.isSupabase()) {
    const resultado = await pedidosDb.enviarPedidoACocina(pedido, usuario.id);
    const dto = await pedidosDb.pedidoConDetalles(resultado.pedido, {
      detalles: resultado.detalles,
    });
    return {
      ...dto,
      movimientos_inventario: resultado.movimientos.length,
    };
  }

  const resultado = pedidosLib.enviarPedidoACocina(pedido, usuario.id);
  return {
    ...pedidosLib.pedidoConDetalles(resultado.pedido),
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
    if (!deliveryPropio.esColumnaInexistente(error)) {
      throw db.persistenceError(
        'Se repuso el stock pero no se pudo marcar el pedido como cancelado.',
        error,
      );
    }
    actualizado = await repository.update('pedidos', pedido.id, { estado: 'cancelado' });
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

function listLiquidacionesMemoria(query) {
  const plataforma = query.plataforma
    ? requiredEnum(query.plataforma, 'plataforma', PLATAFORMAS)
    : null;
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');

  const data = store.state.liquidaciones
    .filter((item) => !plataforma || item.plataforma === plataforma)
    .filter((item) => !desde || item.fecha >= desde)
    .filter((item) => !hasta || item.fecha <= hasta)
    .sort((a, b) => b.id - a.id);

  return paginate(data, query);
}

async function listLiquidacionesSupabase(filtros, query) {
  const { page, limit } = pageParams(query);

  // PostgREST devuelve como máximo 1000 filas por página: se recorre en
  // bloques de 1000 (tope de 10 000 pedidos) para no truncar el cálculo.
  const TAMANO_BLOQUE = 1000;
  const MAX_BLOQUES = 10;
  const pedidos = [];

  for (let bloque = 0; bloque < MAX_BLOQUES; bloque += 1) {
    let consulta = repository
      .table('pedidos')
      .select('id, canal, fecha_pedido, total, comision_plataforma, estado')
      .in('canal', filtros.plataforma ? [filtros.plataforma] : PLATAFORMAS)
      .neq('estado', 'cancelado');

    if (filtros.desde) {
      consulta = consulta.gte('fecha_pedido', `${filtros.desde}T00:00:00`);
    }
    if (filtros.hasta) {
      consulta = consulta.lte('fecha_pedido', `${filtros.hasta}T23:59:59.999`);
    }

    const inicio = bloque * TAMANO_BLOQUE;
    const { data, error } = await consulta
      .order('id', { ascending: true })
      .range(inicio, inicio + TAMANO_BLOQUE - 1);
    if (error) {
      throw db.persistenceError('No se pudieron derivar las liquidaciones.', error);
    }

    const filasBloque = data || [];
    pedidos.push(...filasBloque);
    if (filasBloque.length < TAMANO_BLOQUE) {
      break;
    }
  }

  const data = pedidos;

  const tasas = {};
  for (const plataforma of (filtros.plataforma ? [filtros.plataforma] : PLATAFORMAS)) {
    tasas[plataforma] = await tasaComision(plataforma);
  }

  const acumulado = new Map();
  for (const fila of data || []) {
    const fecha = String(fila.fecha_pedido).slice(0, 10);
    const clave = `${fila.canal}|${fecha}`;
    const bruto = aNumero(fila.total);
    const guardada = aNumero(fila.comision_plataforma);
    const comision = guardada > 0
      ? guardada
      : db.round2(bruto * (tasas[fila.canal] || 0));

    const actual = acumulado.get(clave) || {
      plataforma: fila.canal,
      fecha,
      monto_bruto: 0,
      comision: 0,
      monto_neto: 0,
      pedidos: 0,
    };
    actual.monto_bruto += bruto;
    actual.comision += comision;
    actual.monto_neto += bruto - comision;
    actual.pedidos += 1;
    acumulado.set(clave, actual);
  }

  const filas = [...acumulado.values()]
    .map((item) => ({
      id: null,
      plataforma: item.plataforma,
      fecha: item.fecha,
      monto_bruto: db.round2(item.monto_bruto),
      comision: db.round2(item.comision),
      monto_neto: db.round2(item.monto_neto),
      referencia: 'derivado',
      pedidos: item.pedidos,
      origen: 'derivado',
    }))
    .sort((a, b) => (a.fecha === b.fecha
      ? a.plataforma.localeCompare(b.plataforma)
      : (a.fecha < b.fecha ? 1 : -1)));

  const total = filas.length;
  const inicio = (page - 1) * limit;
  return {
    data: filas.slice(inicio, inicio + limit),
    meta: {
      page,
      limit,
      total,
      pages: total === 0 ? 0 : Math.ceil(total / limit),
      origen: 'derivado',
      limitacion: LIMITACION_LIQUIDACIONES,
      filtros: {
        plataforma: filtros.plataforma,
        desde: filtros.desde,
        hasta: filtros.hasta,
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

  if (db.isSupabase()) {
    return listLiquidacionesSupabase({ plataforma, desde, hasta }, query);
  }
  return listLiquidacionesMemoria(query);
}

async function crearLiquidacion(body, usuario) {
  const payload = requiredObject(body);
  const plataforma = requiredEnum(payload.plataforma, 'plataforma', PLATAFORMAS);
  const fecha = optionalDate(payload.fecha, 'fecha') || db.today();
  const montoBruto = requiredNumber(payload.monto_bruto, 'monto_bruto', { min: 0.01 });
  const tasa = await tasaComision(plataforma);
  const comision = payload.comision === undefined
    ? db.round2(montoBruto * tasa)
    : requiredNumber(payload.comision, 'comision', { min: 0 });
  const montoNeto = payload.monto_neto === undefined
    ? db.round2(montoBruto - comision)
    : requiredNumber(payload.monto_neto, 'monto_neto', { min: 0 });

  if (!db.isSupabase()) {
    const liquidacion = {
      id: store.nextId('liquidaciones'),
      plataforma,
      fecha,
      monto_bruto: store.round2(montoBruto),
      comision: store.round2(comision),
      monto_neto: store.round2(montoNeto),
      referencia: optionalString(payload.referencia, 'referencia', { max: 60 }),
      usuario_id: usuario.id,
      creado_en: store.nowIso(),
    };
    store.state.liquidaciones.push(liquidacion);
    return liquidacion;
  }

  // Sin tabla no se puede persistir: se devuelve el cálculo derivado y se
  // declara explícitamente que no quedó registrado.
  return {
    id: null,
    plataforma,
    fecha,
    monto_bruto: db.round2(montoBruto),
    comision: db.round2(comision),
    monto_neto: db.round2(montoNeto),
    referencia: optionalString(payload.referencia, 'referencia', { max: 60 }),
    usuario_id: usuario.id,
    creado_en: db.nowIso(),
    origen: 'derivado',
    persistido: false,
    limitacion: LIMITACION_LIQUIDACIONES,
  };
}

module.exports = {
  PLATAFORMAS,
  LIMITACION_LIQUIDACIONES,
  tasaComision,
  listPedidos,
  crearPedido,
  aceptarPedido,
  cancelarPedido,
  listLiquidaciones,
  crearLiquidacion,
};
