'use strict';

// Proveedor SOAP de SUNAT (SEE del contribuyente).
//
// Implementa la operación `sendBill` de los servicios web de comprobantes:
//   1. Construye el XML UBL 2.1.
//   2. Lo empaqueta en un ZIP.
//   3. Envía el ZIP en base64 dentro de un sobre SOAP con WS-Security.
//   4. Lee el CDR (applicationResponse) y extrae el ResponseCode.
//
// Modos:
//   beta       -> https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService
//                 Credenciales públicas: [RUC]MODDATOS / MODDATOS (sin certificado).
//   produccion -> https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService
//                 Requiere usuario secundario SOL y certificado digital registrado.
//
// NOTA: el XML generado NO está firmado. En beta SUNAT valida estructura; en
// producción el envío será rechazado hasta integrar la firma digital.

const crypto = require('crypto');
const env = require('../../config/env');
const { fetchText } = require('../http');
const { SunatError, estadoDesdeCodigo } = require('./sunat.provider');
const { construirUbl, nombreArchivo } = require('./ubl');
const { crearZip, leerZip } = require('./zip');

function esc(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function emisor() {
  return {
    ruc: String(env.sunatRuc || '').trim(),
    razonSocial: String(env.sunatRazonSocial || "FRATELLI'S RESTAURANTE").trim(),
  };
}

function construirSobre({ usuario, clave, archivo, contenidoBase64 }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
    '  xmlns:ser="http://service.sunat.gob.pe"',
    '  xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">',
    '  <soapenv:Header>',
    '    <wsse:Security>',
    '      <wsse:UsernameToken>',
    `        <wsse:Username>${esc(usuario)}</wsse:Username>`,
    `        <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${esc(clave)}</wsse:Password>`,
    '      </wsse:UsernameToken>',
    '    </wsse:Security>',
    '  </soapenv:Header>',
    '  <soapenv:Body>',
    '    <ser:sendBill>',
    `      <fileName>${esc(archivo)}</fileName>`,
    `      <contentFile>${contenidoBase64}</contentFile>`,
    '    </ser:sendBill>',
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
}

function extraerEtiqueta(xml, etiqueta) {
  const patron = new RegExp(
    `<(?:[\\w.-]+:)?${etiqueta}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${etiqueta}>`,
    'i',
  );
  const coincidencia = String(xml || '').match(patron);
  return coincidencia ? coincidencia[1].trim() : null;
}

function leerCdr(applicationResponseBase64) {
  if (!applicationResponseBase64) {
    throw new SunatError('SUNAT no devolvió el CDR (applicationResponse vacío).', {
      code: 'CDR_VACIO',
    });
  }

  let xmlCdr;
  try {
    const entradas = leerZip(Buffer.from(applicationResponseBase64, 'base64'));
    const entrada = entradas.find((item) => /\.xml$/i.test(item.nombre)) || entradas[0];
    if (!entrada) {
      throw new Error('El ZIP del CDR no contiene archivos.');
    }
    xmlCdr = entrada.contenido.toString('utf8');
  } catch (error) {
    throw new SunatError(`No se pudo leer el CDR: ${error.message}`, {
      code: 'CDR_INVALIDO',
      detalle: error.message,
    });
  }

  return {
    codigo: extraerEtiqueta(xmlCdr, 'ResponseCode'),
    descripcion: extraerEtiqueta(xmlCdr, 'Description'),
  };
}

function crearProveedorSoap(configuracion) {
  const { nombre, modo, endpointPorDefecto, credencialesPorDefecto } = configuracion;

  function endpoint() {
    const especifico = modo === 'beta' ? env.sunatBetaUrl : env.sunatProduccionUrl;
    return String(env.sunatApiUrl || especifico || endpointPorDefecto || '').trim();
  }

  function credenciales() {
    const datos = emisor();
    const usuario = String(env.sunatUsuarioSol || '').trim()
      || (modo === 'beta' ? `${datos.ruc}MODDATOS` : '');
    const clave = String(env.sunatClaveSol || '').trim()
      || (modo === 'beta' ? 'MODDATOS' : '');
    return { usuario, clave, ...credencialesPorDefecto };
  }

  function configurado() {
    const datos = emisor();
    const { usuario, clave } = credenciales();
    if (!endpoint() || !datos.ruc || datos.ruc.length !== 11) {
      return false;
    }
    if (modo === 'beta') {
      return Boolean(usuario && clave);
    }
    return Boolean(usuario && clave && env.sunatCertificadoRuta);
  }

  async function enviar(comprobante) {
    const datos = emisor();
    if (!datos.ruc || datos.ruc.length !== 11) {
      throw new SunatError('Falta SUNAT_RUC (11 dígitos) en la configuración.', {
        code: 'NO_CONFIGURADO',
      });
    }

    const { usuario, clave } = credenciales();
    if (!usuario || !clave) {
      throw new SunatError('Faltan las credenciales SOL (usuario y clave).', {
        code: 'NO_CONFIGURADO',
      });
    }

    const xml = construirUbl(comprobante, datos);
    const archivos = nombreArchivo(datos.ruc, comprobante.tipo, comprobante.numero);
    const zip = crearZip([{ nombre: archivos.xml, contenido: Buffer.from(xml, 'utf8') }]);
    const sobre = construirSobre({
      usuario,
      clave,
      archivo: archivos.zip,
      contenidoBase64: zip.toString('base64'),
    });

    const respuesta = await fetchText(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        SOAPAction: '',
      },
      body: sobre,
      timeoutMs: env.sunatTimeoutMs,
    });

    const fault = extraerEtiqueta(respuesta, 'faultstring');
    if (fault) {
      throw new SunatError(`SUNAT devolvió un fault: ${fault}`, {
        code: 'SOAP_FAULT',
        detalle: fault,
      });
    }

    const applicationResponse = extraerEtiqueta(respuesta, 'applicationResponse');
    const cdr = leerCdr(applicationResponse);
    const estado = estadoDesdeCodigo(cdr.codigo);

    return {
      modo,
      estado,
      codigo: cdr.codigo,
      mensaje: cdr.descripcion || null,
      ticket: null,
      hash: crypto.createHash('sha256').update(xml).digest('hex'),
      fecha_envio: new Date().toISOString(),
      endpoint: endpoint(),
    };
  }

  return { nombre, modo, endpoint, configurado, enviar };
}

module.exports = { crearProveedorSoap, leerCdr, construirSobre, extraerEtiqueta };
