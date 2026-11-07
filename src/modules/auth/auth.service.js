'use strict';

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const env = require('../../config/env');
const { signToken } = require('../../lib/token');
const { verifyPassword } = require('../../lib/password');
const { AppError } = require('../../middleware/error');
const { requiredObject, requiredString } = require('../../middleware/validate');

function publicUser(user, extra = {}) {
  return {
    id: user.id,
    nombre: user.nombre,
    email: user.email,
    usuario: user.usuario || String(user.email || '').split('@')[0],
    telefono: user.telefono,
    roles: extra.roles || user.roles || [],
    permisos: extra.permisos || user.permisos || [],
    activo: user.activo,
  };
}

async function rolesYPermisosSupabase(usuarioId) {
  const { data: vinculos } = await repository.list('usuario_rol', {
    filters: { usuario_id: usuarioId },
    orderBy: 'usuario_id',
    limit: 100,
  });
  const rolIds = [...new Set(vinculos.map((item) => item.rol_id))];
  if (rolIds.length === 0) {
    return { roles: [], permisos: [] };
  }

  const [{ data: roles }, { data: rolPermisos }] = await Promise.all([
    repository.list('roles', { filters: { id: rolIds }, limit: 100 }),
    repository.list('rol_permiso', {
      filters: { rol_id: rolIds },
      orderBy: 'rol_id',
      limit: 100,
    }),
  ]);

  const permisoIds = [...new Set(rolPermisos.map((item) => item.permiso_id))];
  const permisos = permisoIds.length
    ? (await repository.list('permisos', { filters: { id: permisoIds }, limit: 100 })).data
    : [];

  return {
    roles: roles.map((rol) => rol.nombre),
    permisos: permisos.map((permiso) => permiso.codigo),
  };
}

async function loginSupabase(identifier, clave) {
  const normalized = identifier.toLowerCase();
  const candidates = [normalized];
  if (!normalized.includes('@')) {
    candidates.push(`${normalized}@fratellis.pe`);
  }

  let user = null;
  for (const email of candidates) {
    user = await db.findOne('usuarios', { email });
    if (user) {
      break;
    }
  }

  if (!user || !user.activo || !verifyPassword(clave, user.password_hash)) {
    throw new AppError(401, 'CREDENCIALES_INVALIDAS', 'Usuario o contraseña incorrectos.');
  }

  const { roles, permisos } = await rolesYPermisosSupabase(user.id);
  await repository.update('usuarios', user.id, { ultimo_acceso: db.nowIso() });

  const token = signToken({
    sub: user.id,
    usuario: user.email,
    nombre: user.nombre,
    roles,
    permisos,
  });

  return {
    token,
    token_type: 'Bearer',
    expires_in: env.tokenTtlSec,
    usuario: publicUser(user, { roles, permisos }),
    roles,
    permisos,
  };
}

async function login(body) {
  const payload = requiredObject(body);
  const identifier = body.email || body.usuario;
  const password = body.password !== undefined ? body.password : body.clave;

  const email = requiredString(identifier, body.email ? 'email' : 'usuario', { max: 150 });
  const clave = requiredString(password, 'password', { max: 200 });

  if (db.isSupabase()) {
    return loginSupabase(email, clave);
  }

  const normalized = email.toLowerCase();

  const user = store.state.usuarios.find(
    (item) => item.email.toLowerCase() === normalized || item.usuario.toLowerCase() === normalized,
  );

  if (!user || !user.activo || !verifyPassword(clave, user.password_hash)) {
    throw new AppError(401, 'CREDENCIALES_INVALIDAS', 'Usuario o contraseña incorrectos.');
  }

  user.ultimo_acceso = store.nowIso();
  const token = signToken({
    sub: user.id,
    usuario: user.email,
    nombre: user.nombre,
    roles: user.roles,
    permisos: user.permisos,
  });

  return {
    token,
    token_type: 'Bearer',
    expires_in: env.tokenTtlSec,
    usuario: publicUser(user),
    roles: user.roles,
    permisos: user.permisos,
  };
}

async function me(userId) {
  if (db.isSupabase()) {
    const user = await db.findOrThrow('usuarios', userId, 'Usuario');
    const { roles, permisos } = await rolesYPermisosSupabase(user.id);
    return publicUser(user, { roles, permisos });
  }
  const user = store.findOrThrow('usuarios', userId, 'Usuario');
  return publicUser(user);
}

module.exports = { login, me, publicUser };
