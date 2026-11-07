'use strict';

const { AppError } = require('./error');

function hasPermiso(usuario, permiso) {
  return Boolean(usuario && Array.isArray(usuario.permisos) && usuario.permisos.includes(permiso));
}

function hasAnyRole(usuario, roles) {
  if (!usuario || !Array.isArray(usuario.roles) || roles.length === 0) {
    return false;
  }
  return roles.some((role) => usuario.roles.includes(role));
}

function requirePermiso(...permisos) {
  return function permissionMiddleware(req, res, next) {
    const granted = permisos.some((permiso) => hasPermiso(req.usuario, permiso));
    if (!granted) {
      return next(new AppError(403, 'FORBIDDEN', 'No tiene permiso para realizar esta acción.'));
    }
    return next();
  };
}

function requireRoles(...roles) {
  return function roleMiddleware(req, res, next) {
    if (roles.length === 0 || hasAnyRole(req.usuario, roles)) {
      return next();
    }
    return next(new AppError(403, 'FORBIDDEN', 'Su rol no permite realizar esta acción.'));
  };
}

module.exports = { requirePermiso, requireRoles, hasPermiso, hasAnyRole };
