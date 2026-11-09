'use strict';

// Adaptador genérico de persistencia.
// - DB_MODE=memory   -> opera sobre src/data/store.js (fallback, sin cambios).
// - DB_MODE=supabase -> usa @supabase/supabase-js contra PostgreSQL/Supabase.
//
// No está cableado en los servicios: el arranque actual sigue usando store.js.
// Sirve como base para migrar módulo por módulo sin romper npm run smoke.

const env = require('../config/env');
const store = require('./store');

const TABLES = new Set([
  'roles', 'usuarios', 'usuario_rol', 'permisos', 'rol_permiso', 'configuracion',
  'categorias_platillo', 'platillos', 'fichas_tecnicas', 'insumos', 'fichas_tecnicas_detalle',
  'movimientos_inventario', 'proveedores', 'compras', 'compra_detalles', 'pagos_compras',
  'clientes', 'mesas', 'cuentas', 'pedidos', 'pedido_detalles', 'pagos',
  'cuadres_caja', 'gastos', 'tipos_merma', 'mermas', 'devoluciones', 'activos', 'mantenimientos',
]);

let cachedClient = null;

const FETCH_TIMEOUT_MS = 15000;

// Envuelve fetch con un timeout de red (Supabase free + Render cold start).
// Si el runtime soporta AbortSignal.timeout se usa; si no, AbortController.
function fetchConTimeout(input, init) {
  const options = { ...(init || {}) };
  if (!options.signal) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      options.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      options.signal = controller.signal;
    }
  }
  return fetch(input, options);
}

function mode() {
  return String(process.env.DB_MODE || env.dbMode || 'memory').toLowerCase();
}

function isSupabase() {
  return mode() === 'supabase';
}

function assertTable(table) {
  if (!TABLES.has(table)) {
    throw new Error(`Tabla no permitida por el repositorio: ${table}`);
  }
}

function getClient() {
  if (cachedClient) {
    return cachedClient;
  }

  const url = process.env.SUPABASE_URL || env.supabaseUrl;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || env.supabaseServiceKey;

  if (url && serviceKey) {
    const { createClient } = require('@supabase/supabase-js');
    cachedClient = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetchConTimeout },
    });
    return cachedClient;
  }

  const fallback = require('../lib/supabase');
  if (!fallback) {
    throw new Error(
      'DB_MODE=supabase requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY ' +
      '(o SUPABASE_KEY como último recurso).',
    );
  }

  // Con la clave publishable/anon, RLS puede denegar escrituras. Es solo un aviso.
  console.warn('[repository] Usando SUPABASE_KEY sin service_role; RLS puede bloquear escrituras.');
  cachedClient = fallback;
  return cachedClient;
}

function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 20;
  }
  return Math.min(Math.floor(parsed), 1000);
}

function normalizePage(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

function supabaseError(error) {
  const wrapped = new Error(error.message || 'Error de Supabase');
  wrapped.code = error.code;
  wrapped.details = error.details;
  wrapped.hint = error.hint;
  return wrapped;
}

// Detecta que la funcion RPC no existe en la base (p. ej. migracion 006 sin
// aplicar). Permite caer al camino lento sin romper la operacion.
function esFuncionInexistente(error) {
  if (!error) {
    return false;
  }
  const code = error.code === undefined || error.code === null ? '' : String(error.code);
  if (code === 'PGRST202' || code === '42883') {
    return true;
  }
  const message = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`;
  return /Could not find the function/i.test(message) || /does not exist/i.test(message);
}

// ---------------------------------------------------------------------
// Filtros y utilidades para el modo memoria
// ---------------------------------------------------------------------
function compareValues(left, right) {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  return left < right ? -1 : 1;
}

function matchesFilter(value, filter) {
  if (filter === null) {
    return value === null || value === undefined;
  }
  if (Array.isArray(filter)) {
    return filter.includes(value);
  }
  if (typeof filter === 'object') {
    const op = filter.op || 'eq';
    const expected = filter.value;
    switch (op) {
      case 'eq': return value === expected;
      case 'neq': return value !== expected;
      case 'gt': return value > expected;
      case 'gte': return value >= expected;
      case 'lt': return value < expected;
      case 'lte': return value <= expected;
      case 'in': return Array.isArray(expected) && expected.includes(value);
      case 'between': return Array.isArray(expected) && value >= expected[0] && value <= expected[1];
      case 'is': return value === expected;
      case 'like': return String(value ?? '').includes(String(expected ?? '').replace(/%/g, ''));
      case 'ilike': return String(value ?? '').toLowerCase().includes(String(expected ?? '').replace(/%/g, '').toLowerCase());
      default:
        throw new Error(`Operador de filtro no soportado en memoria: ${op}`);
    }
  }
  return value === filter;
}

function matchesFilters(row, filters = {}) {
  return Object.entries(filters).every(([column, filter]) => {
    if (filter === undefined) {
      return true;
    }
    return matchesFilter(row[column], filter);
  });
}

function sortRows(rows, orderBy, ascending) {
  const direction = ascending === false ? -1 : 1;
  return [...rows].sort((a, b) => direction * compareValues(a[orderBy], b[orderBy]));
}

function memoryRows(table) {
  const rows = store.state[table];
  if (!Array.isArray(rows)) {
    throw new Error(`La colección en memoria no existe: ${table}`);
  }
  return rows;
}

function clone(row) {
  return row ? { ...row } : null;
}

// Cursor ascendente por id: `after` numérico agrega `id > after` respetando
// los filtros ya aplicados. Se usa para polling incremental (solo lo nuevo).
function normalizarCursor(after) {
  if (after === undefined || after === null || after === '') {
    return null;
  }
  const numero = Number(after);
  return Number.isFinite(numero) ? Math.floor(numero) : null;
}

function metaLista(page, limit, total, data, start) {
  const filas = Array.isArray(data) ? data : [];
  const ultima = filas.length > 0 ? filas[filas.length - 1] : null;
  return {
    page,
    limit,
    total,
    pages: total === 0 ? 0 : Math.ceil(total / limit),
    next_cursor: ultima && ultima.id !== undefined ? ultima.id : null,
    has_more: start + filas.length < total,
  };
}

// ---------------------------------------------------------------------
// Filtros para Supabase
// ---------------------------------------------------------------------
function applySupabaseFilters(query, filters = {}) {
  let next = query;
  for (const [column, filter] of Object.entries(filters)) {
    if (filter === undefined) {
      continue;
    }
    if (filter === null) {
      next = next.is(column, null);
      continue;
    }
    if (Array.isArray(filter)) {
      next = next.in(column, filter);
      continue;
    }
    if (typeof filter === 'object') {
      const op = filter.op || 'eq';
      const value = filter.value;
      switch (op) {
        case 'eq': next = next.eq(column, value); break;
        case 'neq': next = next.neq(column, value); break;
        case 'gt': next = next.gt(column, value); break;
        case 'gte': next = next.gte(column, value); break;
        case 'lt': next = next.lt(column, value); break;
        case 'lte': next = next.lte(column, value); break;
        case 'like': next = next.like(column, value); break;
        case 'ilike': next = next.ilike(column, value); break;
        case 'in': next = next.in(column, value); break;
        case 'between': next = next.gte(column, value[0]).lte(column, value[1]); break;
        case 'is': next = next.is(column, value); break;
        default:
          throw new Error(`Operador de filtro no soportado: ${op}`);
      }
      continue;
    }
    next = next.eq(column, filter);
  }
  return next;
}

// ---------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------
async function list(table, options = {}) {
  assertTable(table);

  const {
    select = '*',
    filters = {},
    orderBy = 'id',
    ascending = true,
    page = 1,
    limit = 20,
    after,
  } = options;

  const currentPage = normalizePage(page);
  const pageSize = clampLimit(limit);
  const cursor = normalizarCursor(after);

  if (mode() === 'memory') {
    let filtered = memoryRows(table).filter((row) => matchesFilters(row, filters));
    if (cursor !== null) {
      filtered = filtered.filter((row) => Number(row.id) > cursor);
    }
    const sorted = sortRows(filtered, orderBy, ascending);
    const start = (currentPage - 1) * pageSize;
    const filas = sorted.slice(start, start + pageSize).map(clone);
    return {
      data: filas,
      meta: metaLista(currentPage, pageSize, sorted.length, filas, start),
    };
  }

  let query = getClient().from(table).select(select, { count: 'exact' });
  query = applySupabaseFilters(query, filters);
  if (cursor !== null) {
    query = query.gt('id', cursor);
  }
  query = query.order(orderBy, { ascending });

  const start = (currentPage - 1) * pageSize;
  const { data, error, count } = await query.range(start, start + pageSize - 1);
  if (error) {
    throw supabaseError(error);
  }

  const total = typeof count === 'number' ? count : data.length;
  return {
    data,
    meta: metaLista(currentPage, pageSize, total, data, start),
  };
}

async function getById(table, id, select = '*') {
  assertTable(table);

  if (mode() === 'memory') {
    return clone(store.find(table, id));
  }

  const { data, error } = await getClient()
    .from(table)
    .select(select)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw supabaseError(error);
  }
  return data;
}

async function insert(table, row) {
  assertTable(table);

  if (mode() === 'memory') {
    const record = { id: store.nextId(table), ...row };
    memoryRows(table).push(record);
    return clone(record);
  }

  const { data, error } = await getClient().from(table).insert(row).select().single();
  if (error) {
    throw supabaseError(error);
  }
  return data;
}

async function insertMany(table, rows) {
  assertTable(table);

  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  if (mode() === 'memory') {
    return rows.map((row) => {
      const record = { id: store.nextId(table), ...row };
      memoryRows(table).push(record);
      return clone(record);
    });
  }

  const { data, error } = await getClient().from(table).insert(rows).select();
  if (error) {
    throw supabaseError(error);
  }
  return data || [];
}

async function updateWhere(table, filters, patch) {
  assertTable(table);

  const hayFiltros = filters && Object.keys(filters).length > 0;
  if (!hayFiltros) {
    throw new Error('updateWhere requiere al menos un filtro.');
  }

  if (mode() === 'memory') {
    const rows = memoryRows(table).filter((row) => matchesFilters(row, filters));
    rows.forEach((row) => Object.assign(row, patch));
    return rows.map(clone);
  }

  let query = getClient().from(table).update(patch);
  for (const [clave, valor] of Object.entries(filters)) {
    if (Array.isArray(valor)) {
      query = query.in(clave, valor);
    } else if (valor === null) {
      query = query.is(clave, null);
    } else {
      query = query.eq(clave, valor);
    }
  }

  const { data, error } = await query.select();

  if (error) {
    throw supabaseError(error);
  }
  return data || [];
}

async function update(table, id, patch) {
  assertTable(table);

  if (mode() === 'memory') {
    const rows = memoryRows(table);
    const index = rows.findIndex((item) => Number(item.id) === Number(id));
    if (index === -1) {
      return null;
    }
    Object.assign(rows[index], patch);
    return clone(rows[index]);
  }

  const { data, error } = await getClient()
    .from(table)
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) {
    throw supabaseError(error);
  }
  return data;
}

async function remove(table, id) {
  assertTable(table);

  if (mode() === 'memory') {
    const rows = memoryRows(table);
    const index = rows.findIndex((item) => Number(item.id) === Number(id));
    if (index === -1) {
      return null;
    }
    const [removed] = rows.splice(index, 1);
    return clone(removed);
  }

  const { data, error } = await getClient()
    .from(table)
    .delete()
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) {
    throw supabaseError(error);
  }
  return data;
}

async function rpc(fnName, args = {}) {
  if (!fnName || typeof fnName !== 'string') {
    throw new Error('rpc requiere el nombre de una función PostgreSQL.');
  }

  if (mode() === 'memory') {
    throw new Error('rpc no está disponible en DB_MODE=memory.');
  }

  const { data, error } = await getClient().rpc(fnName, args);
  if (error) {
    throw supabaseError(error);
  }
  return data;
}

function table(name) {
  assertTable(name);
  if (mode() === 'memory') {
    throw new Error('table() solo está disponible en DB_MODE=supabase.');
  }
  return getClient().from(name);
}

async function health() {
  if (mode() === 'memory') {
    return {
      mode: 'memory',
      ok: true,
      tables: Object.keys(store.state).filter((key) => Array.isArray(store.state[key])).length,
    };
  }

  try {
    const { count, error } = await getClient()
      .from('configuracion')
      .select('*', { count: 'exact', head: true });

    return {
      mode: 'supabase',
      ok: !error,
      configuracion: typeof count === 'number' ? count : null,
      error: error ? error.message : null,
    };
  } catch (error) {
    return { mode: 'supabase', ok: false, error: error.message };
  }
}

module.exports = {
  TABLES,
  mode,
  isSupabase,
  list,
  getById,
  insert,
  insertMany,
  update,
  updateWhere,
  remove,
  rpc,
  esFuncionInexistente,
  table,
  health,
};
