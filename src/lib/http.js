'use strict';

// Cliente HTTP mínimo sobre el fetch nativo de Node (>= 18).
// No agrega dependencias: expone timeout, normalización de errores y
// lectura de JSON o texto (SOAP devuelve XML, no JSON).

class HttpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = Number(options.status) || 0;
    this.code = options.code || 'HTTP_ERROR';
    this.retryable = Boolean(options.retryable);
    this.body = options.body === undefined ? null : options.body;
  }
}

async function ejecutar(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 5000,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const texto = await response.text();

    if (!response.ok) {
      throw new HttpError(`El servicio externo respondió HTTP ${response.status}.`, {
        status: response.status,
        code: response.status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'HTTP_ERROR',
        retryable: response.status >= 500 || response.status === 429,
        body: texto,
      });
    }

    return { response, texto };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (error && error.name === 'AbortError') {
      throw new HttpError(`Tiempo de espera agotado (${timeoutMs} ms).`, {
        code: 'TIMEOUT',
        retryable: true,
      });
    }
    throw new HttpError(`No se pudo conectar con el servicio externo: ${error.message}`, {
      code: 'NETWORK_ERROR',
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}) {
  const { texto } = await ejecutar(url, options);
  if (!texto) {
    return null;
  }
  try {
    return JSON.parse(texto);
  } catch (error) {
    throw new HttpError('El servicio externo no devolvió JSON válido.', {
      code: 'INVALID_JSON',
      retryable: false,
      body: texto,
    });
  }
}

async function fetchText(url, options = {}) {
  const { texto } = await ejecutar(url, options);
  return texto;
}

module.exports = { HttpError, fetchJson, fetchText };
