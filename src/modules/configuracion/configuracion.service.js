'use strict';

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const { hashPassword } = require('../../lib/password');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredString,
  requiredArray,
  requiredNumber,
  optionalString,
  paginate,
  pageParams,
  parseId,
  parseSort,
} = require('../../middleware/validate');

const CAMPOS_ORDEN = ['id', 'nombre', 'email', 'usuario'];
const USUARIO_RE = /^[a-zA-Z0-9._-]{3,50}$/;

function aNumero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function valorOrden(fila, campo) {
  if (campo === 'id') {
    return aNumero(fila[campo]);
  }
  const valor = fila[campo];
  return valor === null || valor === undefined ? '' : String(valor).toLowerCase();
}

function ordenar(filas, campo, ascending) {
  const direccion = ascending ? 1 : -1;
  return [...filas].sort((izq, der) => {
    const a = valorOrden(izq, campo);
    const b = valorOrden(der, campo);
    if (a < b) return -1 * direccion;
    if (a > b) return 1 * direccion;
    return aNumero(izq.id) - aNumero(der.id);
  });
}

function usuarioPublico(usuario, extras = {}) {
  return {
    id: usuario.id,
    nombre: usuario.nombre,
    email: usuario.email,
    usuario: extras.usuario !== undefined
      ? extras.usuario
      : (usuario.usuario || usuarioDerivado(usuario)),
    telefono: usuario.telefono,
    activo: usuario.activo,
    roles: extras.roles !== undefined ? extras.roles : (usuario.roles || []),
    permisos: extras.permisos !== undefined ? extras.permisos : (usuario.permisos || []),
    ultimo_acceso: usuario.ultimo_acceso === undefined ? null : usuario.ultimo_acceso,
    creado_en: usuario.creado_en,
  };
}

// Respaldo para filas antiguas sin columna `usuario` (la migración 009 la
// rellena con el prefijo del correo).
function usuarioDerivado(fila) {
  return String(fila.email || '').split('@')[0].toLowerCase();
}

// Normaliza y valida el alias de acceso. Si no viene, se deriva del correo.
function normalizarUsuario(valor, email) {
  const base = valor !== undefined && valor !== null && String(valor).trim() !== ''
    ? String(valor).trim().toLowerCase()
    : usuarioDerivado({ email });
  if (!USUARIO_RE.test(base)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'El campo "usuario" debe tener entre 3 y 50 caracteres y solo admite letras, números, punto, guion y guion bajo.',
      [{ field: 'usuario', value: base }],
    );
  }
  return base;
}

async function porIds(tabla, ids, select, orderBy = 'id') {
  const limpios = [...new Set(ids.map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  if (limpios.length === 0) {
    return [];
  }
  const { data } = await repository.list(tabla, {
    select,
    filters: { id: limpios },
    orderBy,
    ascending: true,
    limit: 1000,
  });
  return data || [];
}

async function permisosPorRolSupabase(rolIds) {
  const limpios = [...new Set(rolIds.map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  if (limpios.length === 0) {
    return new Map();
  }
  const { data } = await repository.list('rol_permiso', {
    select: 'rol_id, permiso_id',
    filters: { rol_id: limpios },
    orderBy: 'permiso_id',
    ascending: true,
    limit: 1000,
  });
  const filas = data || [];
  const permisoIds = [...new Set(filas.map((fila) => fila.permiso_id))];
  const permisos = await porIds('permisos', permisoIds, 'id, codigo');
  const codigo = new Map(permisos.map((permiso) => [permiso.id, permiso.codigo]));

  const mapa = new Map();
  for (const fila of filas) {
    const lista = mapa.get(fila.rol_id) || [];
    const codigoPermiso = codigo.get(fila.permiso_id);
    if (codigoPermiso && !lista.includes(codigoPermiso)) {
      lista.push(codigoPermiso);
    }
    mapa.set(fila.rol_id, lista);
  }
  return mapa;
}

// Usuarios, roles y permisos se resuelven por lotes: usuario_rol de la página,
// luego roles y rol_permiso/permisos de esos roles.
async function enriquecerUsuariosSupabase(filas) {
  const usuarioIds = filas.map((fila) => fila.id);
  const vinculos = usuarioIds.length
    ? (await repository.list('usuario_rol', {
      select: 'usuario_id, rol_id',
      filters: { usuario_id: usuarioIds },
      orderBy: 'rol_id',
      ascending: true,
      limit: 1000,
    })).data || []
    : [];

  const rolIds = [...new Set(vinculos.map((fila) => fila.rol_id))];
  const roles = await porIds('roles', rolIds, 'id, nombre');
  const nombreRol = new Map(roles.map((rol) => [rol.id, rol.nombre]));
  const permisosPorRol = await permisosPorRolSupabase(rolIds);

  const porUsuario = new Map();
  for (const vinculo of vinculos) {
    const actual = porUsuario.get(vinculo.usuario_id) || { roles: [], permisos: [] };
    const nombre = nombreRol.get(vinculo.rol_id);
    if (nombre) {
      actual.roles.push(nombre);
    }
    for (const permiso of permisosPorRol.get(vinculo.rol_id) || []) {
      if (!actual.permisos.includes(permiso)) {
        actual.permisos.push(permiso);
      }
    }
    porUsuario.set(vinculo.usuario_id, actual);
  }

  return filas.map((fila) => {
    const refs = porUsuario.get(fila.id) || { roles: [], permisos: [] };
    return usuarioPublico(fila, {
      roles: refs.roles,
      permisos: refs.permisos,
    });
  });
}

function parseActivo(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const texto = String(value).trim().toLowerCase();
  if (texto === 'true') {
    return true;
  }
  if (texto === 'false') {
    return false;
  }
  throw new AppError(400, 'VALIDATION_ERROR', 'El campo "activo" debe ser true o false.', [
    { field: 'activo', value },
  ]);
}

function filtrosUsuarios(query = {}) {
  const q = query.q ? String(query.q).trim() : '';
  const activo = parseActivo(query.activo);
  const { campo, ascending } = parseSort(query.sort, CAMPOS_ORDEN, 'id:asc', 'sort');
  return { q, activo, sort: campo, ascending };
}

function listUsuariosMemoria(filtros, query) {
  const buscado = filtros.q.toLowerCase();
  const filtrados = store.state.usuarios
    .filter((usuario) => filtros.activo === null || Boolean(usuario.activo) === filtros.activo)
    .filter(
      (usuario) =>
        !buscado
        || String(usuario.nombre).toLowerCase().includes(buscado)
        || String(usuario.email).toLowerCase().includes(buscado)
        || String(usuario.usuario).toLowerCase().includes(buscado),
    );

  const ordenados = ordenar(filtrados, filtros.sort, filtros.ascending);
  return paginate(ordenados.map((usuario) => usuarioPublico(usuario)), query);
}

async function listUsuariosSupabase(filtros, query) {
  const { page, limit } = pageParams(query);

  let consulta = repository
    .table('usuarios')
    .select('id, nombre, email, usuario, telefono, activo, ultimo_acceso, creado_en', { count: 'exact' });
  if (filtros.activo !== null) {
    consulta = consulta.eq('activo', filtros.activo);
  }
  if (filtros.q) {
    const seguro = filtros.q.replace(/[%,()]/g, ' ').trim();
    if (seguro) {
      consulta = consulta.or(
        `nombre.ilike.%${seguro}%,email.ilike.%${seguro}%,usuario.ilike.%${seguro}%`,
      );
    }
  }
  consulta = consulta
    .order(filtros.sort, { ascending: filtros.ascending })
    .order('id', { ascending: true });

  const inicio = (page - 1) * limit;
  const { data, error, count } = await consulta.range(inicio, inicio + limit - 1);
  if (error) {
    throw db.persistenceError('No se pudieron listar los usuarios.', error);
  }

  const filas = data || [];
  const total = typeof count === 'number' ? count : filas.length;
  return {
    data: await enriquecerUsuariosSupabase(filas),
    meta: { page, limit, total, pages: total === 0 ? 0 : Math.ceil(total / limit) },
  };
}

async function listUsuarios(query = {}) {
  const filtros = filtrosUsuarios(query);
  if (db.isSupabase()) {
    return listUsuariosSupabase(filtros, query);
  }
  return listUsuariosMemoria(filtros, query);
}

function validarRoles(roles) {
  const list = requiredArray(roles, 'roles', { max: 6 });
  const nombresValidos = store.state.roles.map((rol) => rol.nombre);
  for (const rol of list) {
    if (!nombresValidos.includes(rol)) {
      throw new AppError(400, 'VALIDATION_ERROR', `El rol "${rol}" no existe.`, [
        { field: 'roles', value: rol },
      ]);
    }
  }
  return Array.from(new Set(list));
}

async function validarRolesSupabase(roles) {
  const list = requiredArray(roles, 'roles', { max: 6 });
  const { data } = await repository.list('roles', {
    orderBy: 'id',
    ascending: true,
    limit: 1000,
  });
  const porNombre = new Map((data || []).map((rol) => [rol.nombre, rol.id]));
  const nombres = [];
  const ids = [];
  for (const rol of list) {
    if (!porNombre.has(rol)) {
      throw new AppError(400, 'VALIDATION_ERROR', `El rol "${rol}" no existe.`, [
        { field: 'roles', value: rol },
      ]);
    }
    if (!nombres.includes(rol)) {
      nombres.push(rol);
      ids.push(porNombre.get(rol));
    }
  }
  return { nombres, ids };
}

async function crearUsuario(body) {
  const payload = requiredObject(body);
  const email = requiredString(payload.email, 'email', { max: 150 }).toLowerCase();
  const nombreUsuario = normalizarUsuario(payload.usuario, email);
  const clave = requiredString(payload.clave || payload.password, 'clave', { max: 200 });
  const nombre = requiredString(payload.nombre, 'nombre', { max: 120 });
  const telefono = optionalString(payload.telefono, 'telefono', { max: 20 });

  if (!db.isSupabase()) {
    const roles = validarRoles(payload.roles);

    if (store.state.usuarios.some((item) => item.email.toLowerCase() === email)) {
      throw new AppError(409, 'CONFLICT', 'Ya existe un usuario con ese correo.');
    }
    if (store.state.usuarios.some((item) => item.usuario.toLowerCase() === nombreUsuario)) {
      throw new AppError(409, 'CONFLICT', 'Ya existe un usuario con ese nombre de usuario.');
    }

    const record = {
      id: store.nextId('usuarios'),
      auth_uid: null,
      nombre,
      email,
      usuario: nombreUsuario,
      password_hash: hashPassword(clave),
      telefono,
      activo: true,
      roles,
      permisos: store.permisosDeRoles(roles),
      ultimo_acceso: null,
      creado_en: store.nowIso(),
      actualizado_en: store.nowIso(),
    };
    store.state.usuarios.push(record);

    for (const roleName of roles) {
      const role = store.state.roles.find((item) => item.nombre === roleName);
      if (role) {
        store.state.usuario_rol.push({
          usuario_id: record.id,
          rol_id: role.id,
          creado_en: store.nowIso(),
        });
      }
    }

    return usuarioPublico(record);
  }

  const { nombres, ids } = await validarRolesSupabase(payload.roles);

  const existente = await repository.list('usuarios', {
    select: 'id',
    filters: { email },
    limit: 1,
  });
  if (existente.data && existente.data.length > 0) {
    throw new AppError(409, 'CONFLICT', 'Ya existe un usuario con ese correo.');
  }

  const existenteUsuario = await repository.list('usuarios', {
    select: 'id',
    filters: { usuario: nombreUsuario },
    limit: 1,
  });
  if (existenteUsuario.data && existenteUsuario.data.length > 0) {
    throw new AppError(409, 'CONFLICT', 'Ya existe un usuario con ese nombre de usuario.');
  }

  let record;
  try {
    record = await repository.insert('usuarios', {
      nombre,
      email,
      usuario: nombreUsuario,
      password_hash: hashPassword(clave),
      telefono,
      activo: true,
    });
  } catch (error) {
    if (String(error && error.code) === '23505') {
      const detalle = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`;
      const mensaje = /usuario/i.test(detalle)
        ? 'Ya existe un usuario con ese nombre de usuario.'
        : 'Ya existe un usuario con ese correo.';
      throw new AppError(409, 'CONFLICT', mensaje);
    }
    throw db.persistenceError('No se pudo crear el usuario.', error);
  }

  try {
    await repository.insertMany(
      'usuario_rol',
      ids.map((rolId) => ({ usuario_id: record.id, rol_id: rolId })),
    );
  } catch (error) {
    // Compensación: se borra el usuario recién creado si falla el vínculo.
    try {
      await repository.remove('usuarios', record.id);
    } catch (compensacionError) {
      error.compensacion = compensacionError.message;
    }
    throw db.persistenceError('No se pudieron asignar los roles al usuario.', error);
  }

  const permisos = [];
  const permisosPorRol = await permisosPorRolSupabase(ids);
  for (const rolId of ids) {
    for (const permiso of permisosPorRol.get(rolId) || []) {
      if (!permisos.includes(permiso)) {
        permisos.push(permiso);
      }
    }
  }

  return usuarioPublico(record, {
    usuario: nombreUsuario,
    roles: nombres,
    permisos,
  });
}

async function actualizarUsuario(id, body) {
  const usuario = await db.findOrThrow('usuarios', parseId(id), 'Usuario');
  const payload = requiredObject(body);

  const patch = {};
  if (payload.nombre !== undefined) {
    patch.nombre = requiredString(payload.nombre, 'nombre', { max: 120 });
  }
  if (payload.activo !== undefined) {
    if (typeof payload.activo !== 'boolean') {
      throw new AppError(400, 'VALIDATION_ERROR', 'El campo "activo" debe ser booleano.', [
        { field: 'activo', value: payload.activo },
      ]);
    }
    patch.activo = payload.activo;
  }
  if (payload.telefono !== undefined) {
    patch.telefono = optionalString(payload.telefono, 'telefono', { max: 20 });
  }
  if (payload.usuario !== undefined) {
    patch.usuario = normalizarUsuario(payload.usuario, usuario.email);
  }

  if (patch.usuario !== undefined) {
    if (!db.isSupabase()) {
      const repetido = store.state.usuarios.some(
        (item) => Number(item.id) !== Number(usuario.id)
          && String(item.usuario || '').toLowerCase() === patch.usuario,
      );
      if (repetido) {
        throw new AppError(409, 'CONFLICT', 'Ya existe un usuario con ese nombre de usuario.');
      }
    } else {
      const { data } = await repository.list('usuarios', {
        select: 'id',
        filters: { usuario: patch.usuario },
        limit: 10,
      });
      const repetido = (data || []).some((fila) => Number(fila.id) !== Number(usuario.id));
      if (repetido) {
        throw new AppError(409, 'CONFLICT', 'Ya existe un usuario con ese nombre de usuario.');
      }
    }
  }

  if (!db.isSupabase()) {
    Object.assign(usuario, patch);
    usuario.actualizado_en = store.nowIso();
    return usuarioPublico(usuario);
  }

  if (Object.keys(patch).length === 0) {
    const [dto] = await enriquecerUsuariosSupabase([usuario]);
    return dto;
  }

  let actualizado;
  try {
    actualizado = await repository.update('usuarios', usuario.id, patch);
  } catch (error) {
    throw db.persistenceError('No se pudo actualizar el usuario.', error);
  }
  const [dto] = await enriquecerUsuariosSupabase([actualizado || { ...usuario, ...patch }]);
  return dto;
}

async function actualizarRoles(id, body) {
  const usuario = await db.findOrThrow('usuarios', parseId(id), 'Usuario');
  const payload = requiredObject(body);

  if (!db.isSupabase()) {
    const roles = validarRoles(payload.roles);

    usuario.roles = roles;
    usuario.permisos = store.permisosDeRoles(roles);
    usuario.actualizado_en = store.nowIso();

    store.state.usuario_rol = store.state.usuario_rol.filter((item) => item.usuario_id !== usuario.id);
    for (const roleName of roles) {
      const role = store.state.roles.find((item) => item.nombre === roleName);
      if (role) {
        store.state.usuario_rol.push({
          usuario_id: usuario.id,
          rol_id: role.id,
          creado_en: store.nowIso(),
        });
      }
    }

    return usuarioPublico(usuario);
  }

  const { nombres, ids } = await validarRolesSupabase(payload.roles);

  const { data: previos } = await repository.list('usuario_rol', {
    select: 'rol_id',
    filters: { usuario_id: usuario.id },
    orderBy: 'rol_id',
    ascending: true,
    limit: 100,
  });
  const anteriores = (previos || []).map((fila) => ({
    usuario_id: usuario.id,
    rol_id: fila.rol_id,
  }));

  const { error: errorDelete } = await repository
    .table('usuario_rol')
    .delete()
    .eq('usuario_id', usuario.id);
  if (errorDelete) {
    throw db.persistenceError('No se pudieron reemplazar los roles del usuario.', errorDelete);
  }

  try {
    await repository.insertMany(
      'usuario_rol',
      ids.map((rolId) => ({ usuario_id: usuario.id, rol_id: rolId })),
    );
  } catch (error) {
    // Compensación: se intenta reponer la asignación anterior.
    try {
      if (anteriores.length > 0) {
        await repository.insertMany('usuario_rol', anteriores);
      }
    } catch (compensacionError) {
      error.compensacion = compensacionError.message;
    }
    throw db.persistenceError('No se asignaron los nuevos roles; se intentó restaurar los previos.', error);
  }

  const permisos = [];
  const permisosPorRol = await permisosPorRolSupabase(ids);
  for (const rolId of ids) {
    for (const permiso of permisosPorRol.get(rolId) || []) {
      if (!permisos.includes(permiso)) {
        permisos.push(permiso);
      }
    }
  }

  return usuarioPublico(usuario, {
    roles: nombres,
    permisos,
  });
}

async function listRoles() {
  if (!db.isSupabase()) {
    const data = store.state.roles.map((rol) => ({
      ...rol,
      permisos: store.ROLE_PERMISOS[rol.nombre] || [],
    }));
    return { data, meta: { total: data.length } };
  }

  const { data } = await repository.list('roles', {
    orderBy: 'id',
    ascending: true,
    limit: 1000,
  });
  const filas = data || [];
  const mapa = await permisosPorRolSupabase(filas.map((rol) => rol.id));
  const data2 = filas.map((rol) => ({
    ...rol,
    permisos: mapa.get(rol.id) || [],
  }));
  return { data: data2, meta: { total: data2.length } };
}

async function listPermisos() {
  if (!db.isSupabase()) {
    return { data: store.state.permisos, meta: { total: store.state.permisos.length } };
  }
  const { data } = await repository.list('permisos', {
    orderBy: 'id',
    ascending: true,
    limit: 1000,
  });
  const filas = data || [];
  return { data: filas, meta: { total: filas.length } };
}

function valorConfig(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : valor;
}

async function getConfiguracion() {
  if (!db.isSupabase()) {
    return {
      igv: store.getConfig('igv_pct'),
      igv_min_soles: store.getConfig('igv_min_soles'),
      kds_sla_min: store.getConfig('kds_sla_min'),
      comision_rappi: store.getConfig('comision_rappi_pct'),
      comision_llamafood: store.getConfig('comision_llamafood_pct'),
      sla_delivery_min: store.getConfig('sla_delivery_min'),
      umbral_merma_pollo_pct: store.getConfig('umbral_merma_pollo_pct'),
      raw: { ...store.state.config },
    };
  }

  const { data } = await repository.list('configuracion', {
    orderBy: 'id',
    ascending: true,
    limit: 1000,
  });
  const filas = data || [];
  const valores = new Map(filas.map((fila) => [fila.clave, valorConfig(fila.valor)]));
  const leer = (...claves) => {
    for (const clave of claves) {
      if (valores.has(clave)) {
        return valores.get(clave);
      }
    }
    return undefined;
  };

  return {
    igv: leer('igv_pct'),
    igv_min_soles: leer('igv_min_soles'),
    kds_sla_min: leer('kds_sla_min', 'sla_kds_min'),
    comision_rappi: leer('comision_rappi_pct'),
    comision_llamafood: leer('comision_llamafood_pct'),
    sla_delivery_min: leer('sla_delivery_min'),
    umbral_merma_pollo_pct: leer('umbral_merma_pollo_pct'),
    raw: Object.fromEntries(filas.map((fila) => [fila.clave, valorConfig(fila.valor)])),
  };
}

async function updateConfiguracion(body) {
  const payload = requiredObject(body);
  const mapping = [
    ['igv', 'igv_pct', 0, 100],
    ['igv_pct', 'igv_pct', 0, 100],
    ['igv_min_soles', 'igv_min_soles', 0, 100000],
    ['kds_sla_min', 'kds_sla_min', 1, 240],
    ['comision_rappi', 'comision_rappi_pct', 0, 100],
    ['comision_rappi_pct', 'comision_rappi_pct', 0, 100],
    ['comision_llamafood', 'comision_llamafood_pct', 0, 100],
    ['comision_llamafood_pct', 'comision_llamafood_pct', 0, 100],
    ['sla_delivery_min', 'sla_delivery_min', 1, 240],
    ['umbral_merma_pollo_pct', 'umbral_merma_pollo_pct', 0, 100],
  ];

  if (!db.isSupabase()) {
    for (const [key, configKey, min, max] of mapping) {
      if (payload[key] !== undefined) {
        const valor = requiredNumber(payload[key], key, { min, max });
        store.updateConfig(configKey, store.round2(valor));
      }
    }
    return getConfiguracion();
  }

  const cambios = new Map();
  for (const [key, configKey, min, max] of mapping) {
    if (payload[key] !== undefined) {
      const valor = requiredNumber(payload[key], key, { min, max });
      cambios.set(configKey, db.round2(valor));
    }
  }

  for (const [clave, valor] of cambios) {
    try {
      const actualizados = await repository.updateWhere(
        'configuracion',
        { clave },
        { valor: String(valor) },
      );
      if (!actualizados || actualizados.length === 0) {
        await repository.insert('configuracion', {
          clave,
          valor: String(valor),
          descripcion: null,
        });
      }
    } catch (error) {
      throw db.persistenceError(`No se pudo actualizar la configuración "${clave}".`, error);
    }
  }

  return getConfiguracion();
}

module.exports = {
  listUsuarios,
  crearUsuario,
  actualizarUsuario,
  actualizarRoles,
  listRoles,
  listPermisos,
  getConfiguracion,
  updateConfiguracion,
};
