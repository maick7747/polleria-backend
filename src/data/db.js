'use strict';

// Utilidades compartidas para el doble modo de persistencia.
// - DB_MODE=memory   -> delega en store.js (síncrono).
// - DB_MODE=supabase -> delega en repository.js (async, tablas reales).
//
// Regla: los servicios preguntan isSupabase() y eligen la rama. Este módulo
// solo contiene piezas comunes (config, caja, correlativos y movimientos).

const repository = require('./repository');
const store = require('./store');
const { AppError } = require('../middleware/error');

function dbMode() {
  return repository.mode();
}

function isSupabase() {
  return dbMode() === 'supabase';
}

function persistenceError(message, cause) {
  return new AppError(500, 'PERSISTENCIA_ERROR', message, [
    { detalle: cause && cause.message ? cause.message : String(cause || 'sin detalle') },
  ]);
}

// Violación de unicidad de PostgreSQL/PostgREST (p. ej. correlativo duplicado).
function esConflictoUnico(error) {
  return Boolean(error) && String(error.code === undefined ? '' : error.code) === '23505';
}

async function findOrThrow(table, id, label) {
  if (!isSupabase()) {
    return store.findOrThrow(table, id, label);
  }
  const row = await repository.getById(table, Number(id));
  if (!row) {
    throw new AppError(404, 'NOT_FOUND', `${label} con id ${id} no existe.`);
  }
  return row;
}

async function findOne(table, filters, orderBy = 'id', ascending = true) {
  const { data } = await repository.list(table, {
    filters,
    orderBy,
    ascending,
    limit: 1,
  });
  return data[0] || null;
}

// El seed de Supabase usa `sla_kds_min`; el store en memoria `kds_sla_min`.
const CONFIG_ALIASES = {
  kds_sla_min: 'sla_kds_min',
  sla_kds_min: 'kds_sla_min',
};

// Cache en memoria de la configuracion leida de Supabase. calcTotals pide
// igv_pct + igv_min_soles en cada pedido y el KDS pide kds_sla_min; sin cache
// son 2-3 SELECT extra por request. Solo se invalida por TTL (60 s), que es
// suficiente porque la configuracion cambia rara vez.
const CONFIG_CACHE_TTL_MS = 60000;
const configCache = new Map();

function leerConfigCache(clave) {
  const entry = configCache.get(clave);
  if (!entry) {
    return { hit: false };
  }
  if (entry.expira <= Date.now()) {
    configCache.delete(clave);
    return { hit: false };
  }
  return { hit: true, valor: entry.valor };
}

function guardarConfigCache(clave, valor) {
  configCache.set(clave, { valor, expira: Date.now() + CONFIG_CACHE_TTL_MS });
}

async function getConfig(clave) {
  if (!isSupabase()) {
    return store.getConfig(clave);
  }

  const cached = leerConfigCache(clave);
  if (cached.hit) {
    return cached.valor;
  }

  const keys = [clave, CONFIG_ALIASES[clave]].filter(Boolean);
  for (const key of keys) {
    const row = await findOne('configuracion', { clave: key });
    if (row) {
      const numeric = Number(row.valor);
      const valor = Number.isFinite(numeric) ? numeric : row.valor;
      guardarConfigCache(clave, valor);
      return valor;
    }
  }

  guardarConfigCache(clave, undefined);
  return undefined;
}

async function calcTotals(subtotal, extra = 0) {
  const base = store.round2(subtotal);
  const rate = Number(await getConfig('igv_pct')) || 0;
  const minimum = Number(await getConfig('igv_min_soles')) || 0;
  const igv = base >= minimum && base > 0 ? store.round2((base * rate) / 100) : 0;
  return { subtotal: base, igv, total: store.round2(base + igv + extra) };
}

async function cajaAbierta(fecha = store.today()) {
  if (!isSupabase()) {
    return store.cajaAbierta(fecha);
  }
  // Solo la caja abierta de la fecha exacta (calendario America/Lima).
  // Ya no se tolera una caja de otra fecha: si el día cambió hay que abrir
  // la caja del día y apertura() bloquea mientras exista una caja anterior
  // abierta (Opción A: una caja por día con corrección).
  return findOne('cuadres_caja', { fecha, estado: 'abierta' });
}

async function requireCajaAbierta(fecha = store.today()) {
  const caja = await cajaAbierta(fecha);
  if (!caja) {
    throw new AppError(
      409,
      'CAJA_CERRADA',
      'La caja del día está cerrada. Abra el cuadre de caja para operar.',
    );
  }
  return caja;
}

async function nextPedidoNumero() {
  if (!isSupabase()) {
    return store.generarNumeroPedido();
  }
  const year = new Date().getFullYear();
  const prefix = `PED-${year}-`;
  const { data, error } = await repository
    .table('pedidos')
    .select('numero')
    .like('numero', `${prefix}%`)
    .order('numero', { ascending: false })
    .limit(1);
  if (error) {
    throw persistenceError('No se pudo calcular el correlativo del pedido.', error);
  }
  const last = data && data[0] ? Number(String(data[0].numero).slice(prefix.length)) : 0;
  const next = Number.isFinite(last) ? last + 1 : 1;
  return `${prefix}${String(next).padStart(6, '0')}`;
}

async function nextComprobanteNumero() {
  if (!isSupabase()) {
    return store.generarComprobanteNumero();
  }
  // NOTA (auditoría P1-5): `cuentas.comprobante_numero` no tiene UNIQUE, así
  // que una colisión entre dos cobros simultáneos no se puede detectar por
  // 23505. La ventana se reduce con el RPC transaccional `fn_cobrar_cuenta`
  // (017); para cerrarla del todo hace falta un índice único parcial o una
  // secuencia PostgreSQL (backlog P2).
  const prefix = 'B001-';
  const { data, error } = await repository
    .table('cuentas')
    .select('comprobante_numero')
    .like('comprobante_numero', `${prefix}%`)
    .order('comprobante_numero', { ascending: false })
    .limit(1);
  if (error) {
    throw persistenceError('No se pudo calcular el correlativo del comprobante.', error);
  }
  const last = data && data[0] ? Number(String(data[0].comprobante_numero).slice(prefix.length)) : 0;
  const next = Number.isFinite(last) ? last + 1 : 1;
  return `${prefix}${String(next).padStart(8, '0')}`;
}

async function applyMovement({
  insumo_id,
  tipo,
  cantidad,
  referencia_tipo = null,
  referencia_id = null,
  usuario_id,
  observacion = null,
  stock_resultante = null,
}) {
  if (!isSupabase()) {
    return store.applyMovement({
      insumo_id,
      tipo,
      cantidad,
      referencia_tipo,
      referencia_id,
      usuario_id,
      observacion,
      stock_resultante,
    });
  }

  const insumo = await findOrThrow('insumos', insumo_id, 'Insumo');
  const quantity = store.round3(cantidad);

  if (!(quantity > 0)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'La cantidad del movimiento debe ser mayor a cero.');
  }

  let nuevoStock;
  if (stock_resultante !== null && stock_resultante !== undefined) {
    nuevoStock = store.round3(stock_resultante);
  } else if (tipo === 'entrada' || tipo === 'devolucion') {
    nuevoStock = store.round3(Number(insumo.stock_actual) + quantity);
  } else {
    nuevoStock = store.round3(Number(insumo.stock_actual) - quantity);
  }

  if (nuevoStock < -0.0005) {
    throw new AppError(409, 'STOCK_INSUFICIENTE', `No hay stock suficiente de ${insumo.nombre}.`, [
      {
        insumo_id: insumo.id,
        disponible: Number(insumo.stock_actual),
        requerido: quantity,
      },
    ]);
  }

  const stockFinal = Math.max(0, nuevoStock);

  // Sin transacción: primero se actualiza el stock y luego se registra la
  // bitácora. Si el segundo paso falla, el error se informa como
  // PERSISTENCIA_ERROR y el stock queda modificado (ver docs/PERSISTENCIA.md).
  await repository.update('insumos', insumo.id, {
    stock_actual: stockFinal,
  });

  return repository.insert('movimientos_inventario', {
    insumo_id: insumo.id,
    tipo,
    cantidad: quantity,
    stock_resultante: stockFinal,
    referencia_tipo,
    referencia_id,
    usuario_id,
    observacion,
  });
}

// Aplica varios movimientos de inventario en una sola operacion.
// - Supabase: RPC fn_aplicar_movimientos_stock (atomico, valida stock con
//   FOR UPDATE). Si la funcion aun no existe, cae al bucle applyMovement
//   (mismo comportamiento anterior, sin transaccion).
// - Memoria: bucle store.applyMovement.
async function applyMovements(movs) {
  const lista = Array.isArray(movs) ? movs.filter(Boolean) : [];

  const normalizados = lista.map((mov) => {
    const quantity = store.round3(mov.cantidad);
    if (!(quantity > 0)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'La cantidad del movimiento debe ser mayor a cero.');
    }
    return {
      insumo_id: mov.insumo_id,
      tipo: mov.tipo,
      cantidad: quantity,
      referencia_tipo: mov.referencia_tipo ?? null,
      referencia_id: mov.referencia_id ?? null,
      usuario_id: mov.usuario_id,
      observacion: mov.observacion ?? null,
      stock_resultante: mov.stock_resultante ?? null,
    };
  });

  if (normalizados.length === 0) {
    return [];
  }

  // Orden estable por insumo_id: el RPC bloquea filas con FOR UPDATE en el
  // orden recibido; un orden global evita deadlocks entre pedidos concurrentes.
  normalizados.sort((a, b) => Number(a.insumo_id) - Number(b.insumo_id));

  if (!isSupabase()) {
    return normalizados.map((mov) => store.applyMovement(mov));
  }

  try {
    const data = await repository.rpc('fn_aplicar_movimientos_stock', {
      p_movimientos: normalizados,
    });
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (repository.esFuncionInexistente(error)) {
      const movimientos = [];
      for (const mov of normalizados) {
        movimientos.push(await applyMovement(mov));
      }
      return movimientos;
    }

    const mensaje = String(error && error.message ? error.message : '');
    const stockInsuficiente = mensaje.match(/STOCK_INSUFICIENTE:\s*(.+)$/i);
    if (stockInsuficiente) {
      const nombre = stockInsuficiente[1].trim();
      throw new AppError(409, 'STOCK_INSUFICIENTE', `No hay stock suficiente de ${nombre}.`, [
        { insumo: nombre },
      ]);
    }

    const insumoFaltante = mensaje.match(/INSUMO_NO_ENCONTRADO:\s*(.+)$/i);
    if (insumoFaltante) {
      throw new AppError(404, 'NOT_FOUND', `Insumo con id ${insumoFaltante[1].trim()} no existe.`);
    }

    throw persistenceError('No se pudieron aplicar los movimientos de inventario.', error);
  }
}

module.exports = {
  dbMode,
  isSupabase,
  persistenceError,
  esConflictoUnico,
  findOrThrow,
  findOne,
  getConfig,
  calcTotals,
  cajaAbierta,
  requireCajaAbierta,
  nextPedidoNumero,
  nextComprobanteNumero,
  applyMovement,
  applyMovements,
  round2: store.round2,
  round3: store.round3,
  nowIso: store.nowIso,
  today: store.today,
};
