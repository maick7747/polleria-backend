'use strict';

const store = require('../../data/store');
const { hashPassword } = require('../../lib/password');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredString,
  requiredArray,
  requiredNumber,
  optionalString,
  paginate,
  parseId,
} = require('../../middleware/validate');

function usuarioPublico(usuario) {
  return {
    id: usuario.id,
    nombre: usuario.nombre,
    email: usuario.email,
    usuario: usuario.usuario,
    telefono: usuario.telefono,
    activo: usuario.activo,
    roles: usuario.roles,
    permisos: usuario.permisos,
    ultimo_acceso: usuario.ultimo_acceso,
    creado_en: usuario.creado_en,
  };
}

function listUsuarios(query = {}) {
  const q = query.q ? String(query.q).trim().toLowerCase() : '';
  const data = store.state.usuarios
    .filter(
      (usuario) =>
        !q ||
        usuario.nombre.toLowerCase().includes(q) ||
        usuario.email.toLowerCase().includes(q) ||
        usuario.usuario.toLowerCase().includes(q),
    )
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map(usuarioPublico);

  return paginate(data, query);
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

function crearUsuario(body) {
  const payload = requiredObject(body);
  const email = requiredString(payload.email, 'email', { max: 150 }).toLowerCase();
  const usuario = payload.usuario
    ? requiredString(payload.usuario, 'usuario', { max: 60 }).toLowerCase()
    : email.split('@')[0];
  const clave = requiredString(payload.clave || payload.password, 'clave', { max: 200 });
  const roles = validarRoles(payload.roles);

  if (store.state.usuarios.some((item) => item.email.toLowerCase() === email)) {
    throw new AppError(409, 'CONFLICT', 'Ya existe un usuario con ese correo.');
  }
  if (store.state.usuarios.some((item) => item.usuario.toLowerCase() === usuario)) {
    throw new AppError(409, 'CONFLICT', 'Ya existe un usuario con ese nombre de usuario.');
  }

  const record = {
    id: store.nextId('usuarios'),
    auth_uid: null,
    nombre: requiredString(payload.nombre, 'nombre', { max: 120 }),
    email,
    usuario,
    password_hash: hashPassword(clave),
    telefono: optionalString(payload.telefono, 'telefono', { max: 20 }),
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

function actualizarUsuario(id, body) {
  const usuario = store.findOrThrow('usuarios', parseId(id), 'Usuario');
  const payload = requiredObject(body);

  if (payload.nombre !== undefined) {
    usuario.nombre = requiredString(payload.nombre, 'nombre', { max: 120 });
  }
  if (payload.activo !== undefined) {
    if (typeof payload.activo !== 'boolean') {
      throw new AppError(400, 'VALIDATION_ERROR', 'El campo "activo" debe ser booleano.', [
        { field: 'activo', value: payload.activo },
      ]);
    }
    usuario.activo = payload.activo;
  }
  if (payload.telefono !== undefined) {
    usuario.telefono = optionalString(payload.telefono, 'telefono', { max: 20 });
  }
  usuario.actualizado_en = store.nowIso();

  return usuarioPublico(usuario);
}

function actualizarRoles(id, body) {
  const usuario = store.findOrThrow('usuarios', parseId(id), 'Usuario');
  const payload = requiredObject(body);
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

function listRoles() {
  const data = store.state.roles.map((rol) => ({
    ...rol,
    permisos: store.ROLE_PERMISOS[rol.nombre] || [],
  }));
  return { data, meta: { total: data.length } };
}

function listPermisos() {
  return { data: store.state.permisos, meta: { total: store.state.permisos.length } };
}

function getConfiguracion() {
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

function updateConfiguracion(body) {
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

  for (const [key, configKey, min, max] of mapping) {
    if (payload[key] !== undefined) {
      const valor = requiredNumber(payload[key], key, { min, max });
      store.updateConfig(configKey, store.round2(valor));
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
