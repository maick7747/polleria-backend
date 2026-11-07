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
