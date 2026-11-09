'use strict';

const { AppError } = require('./error');

function fail(field, message, value) {
  throw new AppError(400, 'VALIDATION_ERROR', message, [
    { field, value: value === undefined ? null : value },
  ]);
}

function requiredObject(value, field = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(field, 'Se esperaba un objeto JSON.', value);
  }
  return value;
}

function requiredString(value, field, options = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    fail(field, `El campo "${field}" es obligatorio.`, value);
  }
  if (options.max && text.length > options.max) {
    fail(field, `El campo "${field}" supera ${options.max} caracteres.`, text);
  }
  return text;
}

function optionalString(value, field, options = {}) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return requiredString(value, field, options);
}

function requiredInt(value, field, options = {}) {
  const number = Number(value);
  const min = options.min === undefined ? 1 : options.min;
  const max = options.max === undefined ? Number.MAX_SAFE_INTEGER : options.max;
  if (!Number.isInteger(number) || number < min || number > max) {
    fail(field, `El campo "${field}" debe ser un entero entre ${min} y ${max}.`, value);
  }
  return number;
}

function optionalInt(value, field, options = {}) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return requiredInt(value, field, options);
}

function requiredNumber(value, field, options = {}) {
  const number = Number(value);
  const min = options.min === undefined ? 0 : options.min;
  const max = options.max === undefined ? Number.MAX_SAFE_INTEGER : options.max;
  if (!Number.isFinite(number) || number < min || number > max) {
    fail(field, `El campo "${field}" debe ser un número entre ${min} y ${max}.`, value);
  }
  return number;
}

function optionalNumber(value, field, options = {}) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return requiredNumber(value, field, options);
}

function requiredEnum(value, field, allowed) {
  if (!allowed.includes(value)) {
    fail(field, `El campo "${field}" debe ser uno de: ${allowed.join(', ')}.`, value);
  }
  return value;
}

function requiredArray(value, field, options = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(field, `El campo "${field}" debe ser un arreglo con al menos un elemento.`, value);
  }
  if (options.max && value.length > options.max) {
    fail(field, `El campo "${field}" admite como máximo ${options.max} elementos.`, value.length);
  }
  return value;
}

function parseId(value, field = 'id') {
  return requiredInt(value, field, { min: 1 });
}

// Interpreta `campo:asc|desc` (por defecto asc si se omite la dirección).
// `fallback` es un valor controlado por el servicio, nunca por el cliente.
function parseSort(value, allowed, fallback = 'id:asc', field = 'sort') {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  const texto = raw || fallback;
  const partes = texto.split(':');
  const campo = partes[0];
  const direccion = (partes[1] || 'asc').toLowerCase();

  if (partes.length > 2 || !allowed.includes(campo)) {
    fail(
      field,
      `El campo "${field}" debe tener el formato campo:asc|desc con campo en: ${allowed.join(', ')}.`,
      value === undefined ? null : value,
    );
  }
  if (direccion !== 'asc' && direccion !== 'desc') {
    fail(field, `El campo "${field}" solo admite la dirección asc o desc.`, value);
  }
  return { campo, ascending: direccion === 'asc' };
}

function pageParams(query = {}) {
  const page = query.page === undefined ? 1 : requiredInt(query.page, 'page', { min: 1 });
  const limit = query.limit === undefined
    ? 20
    : requiredInt(query.limit, 'limit', { min: 1, max: 100 });
  return { page, limit };
}

function paginate(items, query = {}) {
  const { page, limit } = pageParams(query);
  const total = items.length;
  const start = (page - 1) * limit;
  return {
    data: items.slice(start, start + limit),
    meta: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

function isDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function optionalDate(value, field) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!isDateString(value) || Number.isNaN(Date.parse(`${value}T00:00:00`))) {
    fail(field, `El campo "${field}" debe tener formato YYYY-MM-DD.`, value);
  }
  return value;
}

module.exports = {
  fail,
  requiredObject,
  requiredString,
  optionalString,
  requiredInt,
  optionalInt,
  requiredNumber,
  optionalNumber,
  requiredEnum,
  requiredArray,
  parseId,
  pageParams,
  paginate,
  parseSort,
  optionalDate,
};
