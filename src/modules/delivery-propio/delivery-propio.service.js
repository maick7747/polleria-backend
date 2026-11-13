'use strict';

// Delivery propio con doble modo de persistencia.
// - DB_MODE=memory   -> store.js (comportamiento histórico).
// - DB_MODE=supabase -> repository/pedidos-db (tablas reales).
//
// `pedidos.estado_entrega` (migración 009) guarda la transición completa:
// 'pendiente' al crear, 'en_camino' al despachar y 'entregado' al cobrar o
// marcar la entrega. `fecha_entrega` sigue siendo la marca de tiempo real.

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredString,
  requiredInt,
  requiredEnum,
  requiredArray,
  optionalString,
  optionalNumber,
  optionalDate,
  paginate,
  pageParams,
  parseId,
  parseSort,
} = require('../../middleware/validate');
const pedidosLib = require('../../lib/pedidos');
const pedidosDb = require('../../lib/pedidos-db');

const CANALES_PROPIO = ['whatsapp', 'telefono', 'delivery_propio'];
// El enum enum_canal_pedido solo admite 'whatsapp' y 'delivery_propio' para el
// canal propio; 'telefono' existe únicamente en el modo memoria.
const CANALES_PROPIO_DB = ['whatsapp', 'delivery_propio'];
const METODOS_ENTREGA = ['efectivo', 'yape', 'plin', 'tarjeta'];
const ESTADOS_PEDIDO = ['borrador', 'en_cocina', 'servido', 'cobrado', 'cancelado'];
const ESTADOS_ENTREGA = ['en_camino', 'entregado'];
const CAMPOS_ORDEN = ['id', 'fecha_pedido', 'total', 'estado'];

function aNumero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function minutosDesde(fecha) {
  const milisegundos = Date.parse(fecha);
  if (!Number.isFinite(milisegundos)) {
    return 0;
  }
  return Math.max(0, Math.round((Date.now() - milisegundos) / 60000));
}

// `estado_entrega` es la fuente; las filas anteriores a la migración 009 se
// deducen de `fecha_entrega` o del estado cobrado.
function estadoEntregaDesdeFila(fila) {
  if (fila.estado_entrega !== undefined && fila.estado_entrega !== null) {
    return fila.estado_entrega;
  }
  if (fila.fecha_entrega) {
    return 'entregado';
  }
  if (fila.estado === 'cobrado') {
    return 'entregado';
  }
  return null;
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
  const estado = query.estado ? String(query.estado) : null;
  if (estado && !ESTADOS_PEDIDO.includes(estado) && !ESTADOS_ENTREGA.includes(estado)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El filtro estado no es válido.', [
      { field: 'estado', value: query.estado },
    ]);
  }
  const repartidorId = query.repartidor_id ? parseId(query.repartidor_id, 'repartidor_id') : null;
  const desde = optionalDate(query.desde, 'desde') || null;
  const hasta = optionalDate(query.hasta, 'hasta') || null;
  const { campo, ascending } = parseSort(query.sort, CAMPOS_ORDEN, 'fecha_pedido:desc', 'sort');
  return { estado, repartidorId, desde, hasta, sort: campo, ascending };
}

function metaFiltros(filtros) {
  return {
    estado: filtros.estado,
    repartidor_id: filtros.repartidorId,
    desde: filtros.desde,
    hasta: filtros.hasta,
    sort: `${filtros.sort}:${filtros.ascending ? 'asc' : 'desc'}`,
  };
}

async function rolesDeUsuario(usuarioId) {
  const { data: vinculos } = await repository.list('usuario_rol', {
    filters: { usuario_id: usuarioId },
    limit: 100,
  });
  const rolIds = [...new Set(vinculos.map((item) => item.rol_id))];
  if (rolIds.length === 0) {
    return [];
  }
  const { data: roles } = await repository.list('roles', {
    filters: { id: rolIds },
    limit: 100,
  });
  return roles.map((rol) => rol.nombre);
}

async function crearCliente(cliente) {
  const payload = requiredObject(cliente, 'cliente');
  const nombre = requiredString(payload.nombre, 'cliente.nombre', { max: 120 });
  const telefono = optionalString(payload.telefono, 'cliente.telefono', { max: 20 });

  if (!db.isSupabase()) {
    const existente = store.state.clientes.find(
      (item) => item.nombre.toLowerCase() === nombre.toLowerCase() && item.telefono === payload.telefono,
    );
    if (existente) {
      return existente;
    }

    const record = {
      id: store.nextId('clientes'),
      nombre,
      tipo_documento: null,
      numero_documento: null,
      telefono,
      direccion: optionalString(payload.direccion, 'cliente.direccion', { max: 200 }),
      referencia: optionalString(payload.referencia, 'cliente.referencia', { max: 150 }),
      creado_en: store.nowIso(),
      actualizado_en: store.nowIso(),
    };
    store.state.clientes.push(record);
    return record;
  }

  // En Supabase se reutiliza el cliente solo si coincide nombre y teléfono,
  // igual que en memoria (sin teléfono nunca se reutiliza porque en el store
  // el valor almacenado sería null y la comparación estricta fallaría).
  if (telefono) {
    const { data } = await repository.list('clientes', {
      filters: { telefono },
      limit: 100,
    });
    const existente = data.find((item) => String(item.nombre).toLowerCase() === nombre.toLowerCase());
    if (existente) {
      return existente;
    }
  }

  try {
    return await repository.insert('clientes', {
      nombre,
      tipo_documento: null,
      numero_documento: null,
      telefono,
      direccion: optionalString(payload.direccion, 'cliente.direccion', { max: 200 }),
      referencia: optionalString(payload.referencia, 'cliente.referencia', { max: 150 }),
    });
  } catch (error) {
    throw db.persistenceError('No se pudo registrar el cliente.', error);
  }
}

// Cabecera de pedido para Supabase, compartida con delivery externo.
// Si `items` viene con líneas, las valida y las inserta después de la
// cabecera; si el insert de líneas falla se compensa eliminando la cabecera
// (un pedido sin líneas no debe quedar registrado).
async function crearPedidoBaseSupabase(options) {
  const {
    canal,
    tipo_consumo = 'delivery',
    items,
    cliente_id = null,
    usuario_id,
    observaciones = null,
    direccion_entrega,
    referencia_entrega = null,
    costo_delivery = 0,
    comisionPct = 0,
  } = options;

  let detalles = [];
  let subtotal = 0;
  if (items !== undefined && items !== null) {
    if (!Array.isArray(items)) {
      requiredArray(items, 'items', { max: 100 });
    }
    if (items.length > 0) {
      const construido = await pedidosDb.buildDetalles(items);
      detalles = construido.detalles;
      subtotal = construido.subtotal;
    }
  }

  const extra = Number(costo_delivery) || 0;
  const totals = await db.calcTotals(subtotal, extra);
  const numero = await db.nextPedidoNumero();

  const fila = {
    numero,
    fecha_pedido: db.nowIso(),
    canal,
    tipo_consumo,
    cliente_id: cliente_id || null,
    usuario_cajero_id: usuario_id,
    estado: 'borrador',
    estado_pago: 'pendiente',
    metodo_pago: null,
    subtotal: totals.subtotal,
    igv: totals.igv,
    total: totals.total,
    comision_plataforma: db.round2(totals.total * (Number(comisionPct) || 0)),
    costo_delivery: db.round2(extra),
    direccion_entrega,
    referencia_entrega,
    observaciones: observaciones
      ? requiredString(observaciones, 'observaciones', { max: 300 })
      : null,
    comprobante_tipo: 'ticket',
    comprobante_numero: null,
    estado_entrega: 'pendiente',
  };

  let pedido;
  for (let intento = 0; intento < 2; intento += 1) {
    try {
      pedido = await repository.insert('pedidos', fila);
      break;
    } catch (error) {
      const texto = `${error && error.message ? error.message : ''} ${
        error && error.details ? error.details : ''
      }`;
      // Correlativo MAX+1: si otra terminal usó el mismo `numero`, se
      // regenera y se reintenta una sola vez.
      if (intento === 0 && db.esConflictoUnico(error) && /numero/i.test(texto)) {
        fila.numero = await db.nextPedidoNumero();
        continue;
      }
      throw db.persistenceError('No se pudo registrar el pedido.', error);
    }
  }

  if (detalles.length === 0) {
    return { pedido, detalles: [] };
  }

  let insertadas;
  try {
    insertadas = await repository.insertMany('pedido_detalles', detalles.map((detail) => ({
      pedido_id: pedido.id,
      platillo_id: detail.platillo_id,
      cantidad: detail.cantidad,
      precio_unitario: detail.precio_unitario,
      notas: detail.notas,
      estado_preparacion: 'pendiente',
    })));
  } catch (error) {
    // Compensación best-effort: se elimina la cabecera recién creada.
    try {
      await repository.remove('pedidos', pedido.id);
    } catch (limpieza) {
      // la cabecera queda huérfana; el error original se informa igual
    }
    throw db.persistenceError(
      `El pedido ${pedido.numero} no se pudo completar: fallaron sus líneas y se intentó eliminar la cabecera.`,
      error,
    );
  }

  const detallesFinales = detalles.map((detail, index) => {
    const insertada = insertadas[index];
    return {
      ...(insertada || {}),
      platillo_id: detail.platillo_id,
      cantidad: detail.cantidad,
      precio_unitario: aNumero(insertada ? insertada.precio_unitario : detail.precio_unitario),
      subtotal: aNumero(insertada ? insertada.subtotal : detail.subtotal),
      notas: detail.notas,
      platillo_nombre: detail.platillo_nombre,
    };
  });

  return { pedido, detalles: detallesFinales };
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
      estado_entrega: estadoEntregaDesdeFila(fila),
      minutos_desde_pedido: minutosDesde(fila.fecha_pedido),
      detalles: lineas,
    };
  });
}

function listPedidosMemoria(filtros, query) {
  const filas = store.state.pedidos
    .filter((pedido) => pedido.tipo_consumo === 'delivery' && CANALES_PROPIO.includes(pedido.canal))
    .filter((pedido) => !filtros.estado
      || pedido.estado === filtros.estado
      || pedido.estado_entrega === filtros.estado)
    .filter((pedido) => !filtros.repartidorId || pedido.repartidor_id === filtros.repartidorId)
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
    data: resultado.data.map((pedido) => ({
      ...pedidosLib.pedidoConDetalles(pedido),
      estado_entrega: estadoEntregaDesdeFila(pedido),
      minutos_desde_pedido: minutosDesde(pedido.fecha_pedido),
    })),
    meta: { ...resultado.meta, filtros: metaFiltros(filtros) },
  };
}

async function listPedidosSupabase(filtros, query) {
  const { page, limit } = pageParams(query);

  let consulta = repository
    .table('pedidos')
    .select('*', { count: 'exact' })
    .eq('tipo_consumo', 'delivery')
    .in('canal', CANALES_PROPIO_DB);

  if (filtros.estado) {
    if (ESTADOS_ENTREGA.includes(filtros.estado)) {
      consulta = consulta.eq('estado_entrega', filtros.estado);
    } else {
      consulta = consulta.eq('estado', filtros.estado);
    }
  }
  if (filtros.repartidorId) {
    consulta = consulta.eq('repartidor_id', filtros.repartidorId);
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
    throw db.persistenceError('No se pudieron listar los pedidos de delivery propio.', error);
  }

  const filas = data || [];
  const total = typeof count === 'number' ? count : filas.length;
  return {
    data: await enriquecerPedidos(filas),
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

// Pedido sin líneas en memoria: misma forma que lib/pedidos.createPedidoRecord
// pero admite un body sin `items` (el contrato permite crear el pedido y
// agregar líneas después).
async function crearPedidoMemoriaSinLineas(options) {
  const {
    canal,
    cliente_id,
    usuario_id,
    observaciones,
    direccion_entrega,
    referencia_entrega,
    costo_delivery,
  } = options;

  const totals = await db.calcTotals(0, Number(costo_delivery) || 0);
  const ahora = store.nowIso();
  const pedido = {
    id: store.nextId('pedidos'),
    numero: store.generarNumeroPedido(),
    fecha_pedido: ahora,
    canal,
    tipo_consumo: 'delivery',
    mesa_id: null,
    cuenta_id: null,
    cliente_id: cliente_id || null,
    repartidor_id: null,
    usuario_cajero_id: usuario_id,
    estado: 'borrador',
    estado_pago: 'pendiente',
    metodo_pago: null,
    subtotal: totals.subtotal,
    igv: totals.igv,
    total: totals.total,
    comision_plataforma: 0,
    costo_delivery: store.round2(Number(costo_delivery) || 0),
    direccion_entrega,
    referencia_entrega: referencia_entrega || null,
    observaciones: observaciones
      ? requiredString(observaciones, 'observaciones', { max: 300 })
      : null,
    idempotency_key: null,
    comprobante_tipo: 'ticket',
    comprobante_numero: null,
    fecha_inicio_prep: null,
    fecha_listo: null,
    fecha_entrega: null,
    estado_entrega: 'pendiente',
    stock_descontado: false,
    creado_en: ahora,
  };
  store.state.pedidos.push(pedido);
  return pedido;
}

async function crearPedido(body, usuario) {
  const payload = requiredObject(body);
  const canal = requiredEnum(payload.canal || 'whatsapp', 'canal', CANALES_PROPIO);
  await db.requireCajaAbierta();

  const cliente = payload.cliente ? await crearCliente(payload.cliente) : null;
  const direccion = payload.cliente && payload.cliente.direccion
    ? requiredString(payload.cliente.direccion, 'cliente.direccion', { max: 200 })
    : optionalString(payload.direccion_entrega, 'direccion_entrega', { max: 200 });

  if (!direccion) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El delivery requiere dirección de entrega.', [
      { field: 'cliente.direccion' },
    ]);
  }

  const costo = optionalNumber(payload.costo_delivery, 'costo_delivery', { min: 0 }) || 0;
  const referencia = payload.cliente ? payload.cliente.referencia : null;

  if (db.isSupabase()) {
    const { pedido, detalles } = await crearPedidoBaseSupabase({
      canal: canal === 'telefono' ? 'whatsapp' : canal,
      tipo_consumo: 'delivery',
      items: payload.items,
      cliente_id: cliente ? cliente.id : null,
      usuario_id: usuario.id,
      observaciones: payload.observaciones,
      direccion_entrega: direccion,
      referencia_entrega: referencia,
      costo_delivery: costo,
    });

    if (payload.enviar_cocina !== false) {
      const resultado = await pedidosDb.enviarPedidoACocina(pedido, usuario.id);
      return pedidosDb.pedidoConDetalles(resultado.pedido, { detalles: resultado.detalles });
    }

    return pedidosDb.pedidoConDetalles(pedido, { detalles });
  }

  const conLineas = Array.isArray(payload.items) && payload.items.length > 0;
  if (payload.items !== undefined && payload.items !== null && !Array.isArray(payload.items)) {
    requiredArray(payload.items, 'items', { max: 100 });
  }
  const pedido = conLineas
    ? pedidosLib.createPedidoRecord({
      canal,
      tipo_consumo: 'delivery',
      items: payload.items,
      cliente_id: cliente ? cliente.id : null,
      usuario_id: usuario.id,
      observaciones: payload.observaciones,
      direccion_entrega: direccion,
      referencia_entrega: referencia,
      costo_delivery: costo,
    })
    : await crearPedidoMemoriaSinLineas({
      canal,
      cliente_id: cliente ? cliente.id : null,
      usuario_id: usuario.id,
      observaciones: payload.observaciones,
      direccion_entrega: direccion,
      referencia_entrega: referencia,
      costo_delivery: costo,
    });

  if (payload.enviar_cocina !== false) {
    pedidosLib.enviarPedidoACocina(pedido, usuario.id);
  }

  return pedidosLib.pedidoConDetalles(pedido);
}

async function asignarRepartidor(id, body) {
  const pedido = await db.findOrThrow('pedidos', parseId(id), 'Pedido');
  const payload = requiredObject(body);
  const repartidorId = requiredInt(payload.repartidor_id, 'repartidor_id', { min: 1 });
  const repartidor = await db.findOrThrow('usuarios', repartidorId, 'Repartidor');

  const roles = db.isSupabase()
    ? await rolesDeUsuario(repartidor.id)
    : (repartidor.roles || []);

  if (!roles.includes('Repartidor') && !roles.includes('Dueño/Admin')) {
    throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'El usuario indicado no tiene rol de Repartidor.');
  }

  if (db.isSupabase()) {
    const actualizado = await repository.update('pedidos', pedido.id, {
      repartidor_id: repartidor.id,
    });
    return pedidosDb.pedidoConDetalles(actualizado || { ...pedido, repartidor_id: repartidor.id });
  }

  pedido.repartidor_id = repartidor.id;
  return pedidosLib.pedidoConDetalles(pedido);
}

async function actualizarEstado(id, body) {
  const pedido = await db.findOrThrow('pedidos', parseId(id), 'Pedido');
  const payload = requiredObject(body);
  const estado = requiredEnum(payload.estado, 'estado', ESTADOS_ENTREGA);

  if (pedido.estado === 'cancelado') {
    throw new AppError(409, 'CONFLICT', 'El pedido está cancelado.');
  }

  if (estado === 'en_camino' && !pedido.repartidor_id) {
    throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'Asigne un repartidor antes de iniciar la entrega.');
  }

  if (db.isSupabase()) {
    const patch = { estado_entrega: estado };
    if (estado === 'entregado') {
      patch.fecha_entrega = pedido.fecha_entrega || db.nowIso();
    }

    let actualizado;
    try {
      actualizado = await repository.update('pedidos', pedido.id, patch);
    } catch (error) {
      throw db.persistenceError('No se pudo actualizar el estado de entrega.', error);
    }
    const dto = await pedidosDb.pedidoConDetalles(actualizado || { ...pedido, ...patch });
    return { ...dto, estado_entrega: estado };
  }

  if (estado === 'en_camino') {
    pedido.estado_entrega = 'en_camino';
  } else {
    pedido.estado_entrega = 'entregado';
    pedido.fecha_entrega = store.nowIso();
  }

  return pedidosLib.pedidoConDetalles(pedido);
}

async function registrarEntrega(id, body, usuario) {
  const pedido = await db.findOrThrow('pedidos', parseId(id), 'Pedido');
  const payload = requiredObject(body);
  const metodo = requiredEnum(payload.metodo, 'metodo', METODOS_ENTREGA);
  await db.requireCajaAbierta();

  if (pedido.estado === 'cancelado') {
    throw new AppError(409, 'CONFLICT', 'El pedido está cancelado.');
  }
  if (pedido.estado_pago === 'pagado') {
    throw new AppError(409, 'CONFLICT', 'El pedido ya fue cobrado.');
  }

  const monto = payload.monto === undefined
    ? pedido.total
    : optionalNumber(payload.monto, 'monto', { min: 0 });
  if (monto + 0.009 < aNumero(pedido.total)) {
    throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'El monto recibido es menor al total del pedido.', [
      { total: aNumero(pedido.total), monto },
    ]);
  }

  const ahora = db.nowIso();

  if (!db.isSupabase()) {
    pedido.estado = 'cobrado';
    pedido.estado_pago = 'pagado';
    pedido.metodo_pago = metodo;
    pedido.estado_entrega = 'entregado';
    pedido.fecha_entrega = pedido.fecha_entrega || ahora;

    const pago = store.addPago({
      pedido_id: pedido.id,
      metodo,
      monto: pedido.total,
      es_contraentrega: true,
      usuario_id: usuario.id,
      fecha: ahora,
    });

    return {
      pedido: pedidosLib.pedidoConDetalles(pedido),
      pago,
      vuelto: store.round2(Math.max(0, monto - pedido.total)),
    };
  }

  // El pago se inserta primero; si el pedido no se puede cobrar se elimina el
  // pago recién creado (compensación) para no dejar cobros huérfanos.
  let pago;
  try {
    pago = await repository.insert('pagos', {
      pedido_id: pedido.id,
      metodo,
      monto: aNumero(pedido.total),
      es_contraentrega: true,
      usuario_id: usuario.id,
      fecha: ahora,
    });
  } catch (error) {
    throw db.persistenceError('No se pudo registrar el pago contraentrega.', error);
  }

  let actualizado;
  try {
    // UPDATE condicional: solo una terminal puede pasar el pedido a cobrado.
    // Si otra ya lo cobró, se elimina el pago recién insertado.
    const filas = await repository.updateWhere(
      'pedidos',
      {
        id: pedido.id,
        estado_pago: 'pendiente',
        estado: ['borrador', 'en_cocina', 'servido'],
      },
      {
        estado: 'cobrado',
        estado_pago: 'pagado',
        metodo_pago: metodo,
        fecha_entrega: pedido.fecha_entrega || ahora,
        estado_entrega: 'entregado',
      },
    );
    actualizado = filas && filas.length > 0 ? filas[0] : null;
  } catch (error) {
    try {
      await repository.remove('pagos', pago.id);
    } catch (limpieza) {
      // el pago queda huérfano; el error original se informa igual
    }
    throw db.persistenceError(
      'El pago se registró pero no se pudo cerrar el pedido; se intentó eliminar el pago.',
      error,
    );
  }

  if (!actualizado) {
    try {
      await repository.remove('pagos', pago.id);
    } catch (limpieza) {
      // el pago queda huérfano; el 409 se informa igual
    }
    throw new AppError(
      409,
      'CONFLICT',
      'El pedido ya fue cobrado o cancelado por otra terminal.',
    );
  }

  const dto = await pedidosDb.pedidoConDetalles(actualizado);
  return {
    pedido: { ...dto, estado_entrega: 'entregado' },
    pago: { ...pago, monto: aNumero(pago.monto) },
    vuelto: db.round2(Math.max(0, monto - aNumero(pedido.total))),
  };
}

module.exports = {
  crearCliente,
  CANALES_PROPIO,
  METODOS_ENTREGA,
  listPedidos,
  crearPedido,
  asignarRepartidor,
  actualizarEstado,
  registrarEntrega,
  crearPedidoBaseSupabase,
};
