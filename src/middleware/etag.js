'use strict';

// ETag débil para GET de lectura frecuente (polling).
// El cliente reenvía el valor en If-None-Match y, si el cuerpo no cambió,
// recibe 304 sin cuerpo: se ahorra ancho de banda y parseo.
//
// Solo para respuestas exitosas: nunca se aplica a errores ni a
// POST/PATCH/DELETE (allí el controlador responde con res.json directo).

const crypto = require('crypto');

function serializar(payload) {
  return JSON.stringify(payload === undefined ? null : payload);
}

function hash(body) {
  return crypto.createHash('sha1').update(body, 'utf8').digest('hex');
}

// Compara If-None-Match (lista separada por comas, puede traer W/ y comillas)
// contra el hash calculado. `*` coincide con cualquier representación.
function coincide(ifNoneMatch, etiqueta) {
  if (!ifNoneMatch) {
    return false;
  }
  const valores = String(ifNoneMatch).split(',').map((valor) => valor.trim());
  return valores.some((valor) => {
    if (valor === '*') {
      return true;
    }
    const limpio = valor.replace(/^W\//, '').replace(/"/g, '');
    return limpio === etiqueta;
  });
}

function responderConEtag(req, res, payload) {
  const body = serializar(payload);
  const etiqueta = hash(body);
  res.setHeader('ETag', `W/"${etiqueta}"`);

  if (coincide(req.headers['if-none-match'], etiqueta)) {
    res.status(304).end();
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(body);
}

// `generado_en` cambia en cada petición y anularía el ETag. Se conserva el
// valor original mientras el resto del objeto no cambie, así el 304 es real y
// el campo sigue significando "cuándo se generó este contenido".
const firmas = new Map();

function estabilizarGenerado(clave, objeto) {
  if (!objeto || typeof objeto !== 'object' || !('generado_en' in objeto)) {
    return objeto;
  }
  const { generado_en: generado, ...resto } = objeto;
  const firma = JSON.stringify(resto);
  const previo = firmas.get(clave);
  if (previo && previo.firma === firma) {
    return previo.objeto;
  }
  const estable = { ...objeto, generado_en: generado };
  firmas.set(clave, { firma, objeto: estable });
  return estable;
}

module.exports = { responderConEtag, estabilizarGenerado };
