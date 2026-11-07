'use strict';

const { verifyToken } = require('../lib/token');
const { AppError } = require('./error');

module.exports = function authMiddleware(req, res, next) {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Token de autenticación requerido.'));
  }

  try {
    const payload = verifyToken(header.slice(7).trim());
    req.usuario = {
      id: Number(payload.sub),
      email: payload.usuario || null,
      nombre: payload.nombre || null,
      roles: Array.isArray(payload.roles) ? payload.roles : [],
      permisos: Array.isArray(payload.permisos) ? payload.permisos : [],
    };
    return next();
  } catch (error) {
    const message = error && error.expired
      ? 'La sesión expiró. Inicie sesión nuevamente.'
      : 'Token inválido o expirado.';
    return next(new AppError(401, 'UNAUTHORIZED', message));
  }
};
