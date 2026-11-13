'use strict';

class AppError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function notFoundHandler(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', `No existe el recurso ${req.method} ${req.originalUrl}.`));
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  let status = Number(error.status || error.statusCode) || 500;
  let code = error.code || 'INTERNAL_ERROR';
  let message = error.message || 'Ocurrió un error interno.';
  let details = Array.isArray(error.details) ? error.details : [];

  // Errores de PostgreSQL/PostgREST sin status: se traducen a códigos HTTP
  // útiles en lugar de un 500 genérico. `repository.supabaseError` conserva
  // `code`, `details` y `hint` de la respuesta de Supabase.
  const codigoBase = String(error.code || '');
  const MAPEO_BASE = {
    '23505': { status: 409, code: 'DUPLICATE', message: 'El registro ya existe (valor duplicado).' },
    '23503': { status: 409, code: 'FOREIGN_KEY', message: 'El registro referencia datos inexistentes o en uso.' },
    '23514': { status: 400, code: 'CHECK_VIOLATION', message: 'El dato no cumple una regla de la base de datos.' },
    '23502': { status: 400, code: 'VALIDATION_ERROR', message: 'Falta un dato obligatorio.' },
    '22P02': { status: 400, code: 'VALIDATION_ERROR', message: 'El formato de un dato no es válido.' },
    'PGRST102': { status: 400, code: 'VALIDATION_ERROR', message: 'El cuerpo de la petición no es válido.' },
    'PGRST103': { status: 400, code: 'VALIDATION_ERROR', message: 'El rango solicitado no es válido.' },
  };
  if (MAPEO_BASE[codigoBase]) {
    ({ status, code, message } = MAPEO_BASE[codigoBase]);
    details = [];
  }

  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'El cuerpo JSON enviado no es válido.';
    details = [];
  }

  if (status >= 500) {
    console.error('[error]', req.method, req.originalUrl, error);
    code = 'INTERNAL_ERROR';
    message = 'Ocurrió un error interno. Intente nuevamente.';
    details = [];
  }

  res.status(status).json({
    error: {
      code,
      message,
      details,
      requestId: req.id || null,
    },
  });
}

module.exports = { AppError, notFoundHandler, errorHandler };
