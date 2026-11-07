'use strict';

// Verificación offline de las integraciones (sin red).
// Ejecutar: npm run verify:integraciones
//
// - Prueba el patrón Strategy de documentos: mock, apiperu, openruc y fallback.
// - Prueba el patrón Strategy de SUNAT: simulado, beta (CDR simulado) y produccion.
// - Prueba el ZIP propio (escritura y lectura) y el XML UBL.
//
// No requiere servidor ni credenciales: reemplaza global.fetch por un stub.

process.env.DB_MODE = 'memory';
process.env.DOCUMENTO_PROVIDER = 'mock';
process.env.DOCUMENTO_FALLBACK = 'mock';
process.env.DOCUMENTO_CACHE_TTL_SEC = '60';
process.env.SUNAT_MODE = 'simulado';
process.env.SUNAT_RUC = '10759888079';

const env = require('../src/config/env');
const documento = require('../src/modules/venta-local/providers/documento');
const sunat = require('../src/lib/sunat');
const { crearZip, leerZip } = require('../src/lib/sunat/zip');
const { construirUbl } = require('../src/lib/sunat/ubl');

const resultados = [];
let llamadas = [];
let programado = null;

function check(nombre, ok, detalle) {
  resultados.push({ nombre, ok, detalle });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}

function respuestaHttp(texto, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => texto,
  };
}

global.fetch = async (url, opciones) => {
  llamadas.push({ url: String(url), opciones });
  if (typeof programado === 'function') {
    return programado(String(url), opciones);
  }
  throw new Error(`fetch no programado: ${url}`);
};

function reiniciar(programacion) {
  llamadas = [];
  programado = programacion || null;
  documento.limpiarCache();
}

function comprobanteDemo() {
  return {
    tipo: 'boleta',
    numero: 'B001-00000001',
    fecha: '2026-11-07T18:30:00-05:00',
    cliente: 'Cliente varios',
    ruc: null,
    moneda: 'PEN',
    subtotal: 100,
    igv: 18,
    total: 118,
    items: [
      { platillo: 'Pollo a la brasa', cantidad: 2, precio_unitario: 40, subtotal: 80 },
      { platillo: 'Inca Kola 1L', cantidad: 2, precio_unitario: 10, subtotal: 20 },
    ],
  };
}

(async () => {
  // 1. mock -------------------------------------------------------------
  env.documentoProvider = 'mock';
  env.documentoFallback = 'mock';
  reiniciar();
  let r = await documento.validarDocumento({ tipo: 'DNI', numero: '12345678' });
  check('mock: DNI válido', r.valido === true && r.fuente === 'mock', `fuente=${r.fuente}`);
  r = await documento.validarDocumento({ tipo: 'DNI', numero: '1234' });
  check('mock: DNI inválido no bloquea', r.valido === false && Boolean(r.motivo), r.motivo);

  // 2. apiperu DNI ------------------------------------------------------
  env.documentoProvider = 'apiperu';
  env.apiperuToken = 'token-de-prueba';
  reiniciar(() => respuestaHttp(JSON.stringify({
    success: true,
    code: 'found',
    data: { numero: '44556677', nombre_completo: 'PEREZ GARCIA JUAN CARLOS' },
  })));
  r = await documento.validarDocumento({ tipo: 'DNI', numero: '44556677' });
  check(
    'apiperu: DNI encontrado',
    r.valido === true && r.nombre === 'PEREZ GARCIA JUAN CARLOS' && r.fuente === 'apiperu',
    `${r.fuente} · ${r.nombre}`,
  );
  check(
    'apiperu: usa Bearer y POST /dni',
    llamadas[0] && llamadas[0].url.endsWith('/dni')
      && llamadas[0].opciones.headers.Authorization === 'Bearer token-de-prueba',
    llamadas[0] ? llamadas[0].url : 'sin llamada',
  );

  // 3. apiperu RUC ------------------------------------------------------
  reiniciar(() => respuestaHttp(JSON.stringify({
    success: true,
    code: 'found',
    data: {
      ruc: '20131312955',
      nombre_o_razon_social: 'SUPERINTENDENCIA NACIONAL DE ADUANAS',
      estado: 'ACTIVO',
      condicion: 'HABIDO',
    },
  })));
  r = await documento.validarDocumento({ tipo: 'RUC', numero: '20131312955' });
  check(
    'apiperu: RUC encontrado con estado',
    r.valido === true && r.datos && r.datos.estado === 'ACTIVO',
    `${r.nombre} · ${r.datos ? r.datos.estado : '-'}`,
  );

  // 3b. apiperu 404 = no encontrado (no es fallo del proveedor) ---------
  reiniciar(() => respuestaHttp(JSON.stringify({
    success: false,
    code: 'document_not_found',
    message: 'El DNI no existe',
  }), 404));
  r = await documento.validarDocumento({ tipo: 'DNI', numero: '99999999' });
  check(
    'apiperu: 404 devuelve valido=false sin fallback',
    r.valido === false && r.fuente === 'apiperu',
    `fuente=${r.fuente} · valido=${r.valido}`,
  );

  // 4. fallback apiperu -> mock ----------------------------------------
  env.documentoFallback = 'mock';
  reiniciar(() => {
    throw new Error('red caída');
  });
  r = await documento.validarDocumento({ tipo: 'DNI', numero: '87654321' });
  check(
    'fallback: apiperu cae y responde mock',
    r.valido === true && r.fuente === 'mock' && r.intentos === undefined,
    `fuente=${r.fuente}`,
  );

  // 5. sin fallback -> manual ------------------------------------------
  env.documentoFallback = 'none';
  reiniciar(() => {
    throw new Error('red caída');
  });
  r = await documento.validarDocumento({ tipo: 'DNI', numero: '11223344' });
  check(
    'sin fallback: resultado manual no bloquea',
    r.valido === false && r.modo === 'manual' && r.intentos.length >= 1,
    `modo=${r.modo}`,
  );

  // 6. openruc ----------------------------------------------------------
  env.documentoProvider = 'openruc';
  env.documentoFallback = 'mock';
  reiniciar(() => respuestaHttp(JSON.stringify({
    ruc: '20100047218',
    razon_social: 'BANCO DE CREDITO DEL PERU',
    estado: 'ACTIVO',
    condicion: 'HABIDO',
  })));
  r = await documento.validarDocumento({ tipo: 'RUC', numero: '20100047218' });
  check(
    'openruc: RUC sin token',
    r.valido === true && r.fuente === 'openruc' && r.nombre === 'BANCO DE CREDITO DEL PERU',
    `${r.fuente} · ${r.nombre}`,
  );

  reiniciar();
  r = await documento.validarDocumento({ tipo: 'DNI', numero: '44556677' });
  check(
    'openruc: DNI no soportado cae al fallback',
    r.fuente === 'mock',
    `fuente=${r.fuente}`,
  );

  // 7. caché ------------------------------------------------------------
  env.documentoProvider = 'apiperu';
  env.documentoFallback = 'mock';
  reiniciar(() => respuestaHttp(JSON.stringify({
    success: true,
    code: 'found',
    data: { nombre_completo: 'CACHE PRUEBA' },
  })));
  await documento.validarDocumento({ tipo: 'DNI', numero: '10101010' });
  const antes = llamadas.length;
  r = await documento.validarDocumento({ tipo: 'DNI', numero: '10101010' });
  check(
    'caché: segunda consulta no hace HTTP',
    r.cache === true && llamadas.length === antes,
    `cache=${r.cache} · llamadas=${llamadas.length}`,
  );

  // 8. ZIP ida y vuelta -------------------------------------------------
  const zip = crearZip([{ nombre: 'prueba.xml', contenido: Buffer.from('<a>hola</a>', 'utf8') }]);
  const entradas = leerZip(zip);
  check(
    'zip: escritura y lectura propias',
    entradas.length === 1 && entradas[0].contenido.toString('utf8') === '<a>hola</a>',
    `${entradas.length} entrada(s)`,
  );

  // 9. UBL --------------------------------------------------------------
  const xml = construirUbl(comprobanteDemo(), { ruc: '10759888079', razonSocial: 'FRATELLIS' });
  check(
    'ubl: XML con Invoice, ID e IGV',
    xml.includes('<Invoice') && xml.includes('B001-00000001') && xml.includes('<cbc:TaxAmount'),
    `${xml.length} caracteres`,
  );

  // 10. SUNAT simulado --------------------------------------------------
  env.sunatMode = 'simulado';
  let s = await sunat.enviar(comprobanteDemo());
  check(
    'sunat simulado: no_enviado',
    s.modo === 'simulado' && s.estado === 'no_enviado',
    `${s.modo} · ${s.estado}`,
  );

  // 11. SUNAT beta con CDR simulado ------------------------------------
  env.sunatMode = 'beta';
  const cdrXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ApplicationResponse>',
    '  <cbc:ResponseCode>0</cbc:ResponseCode>',
    '  <cbc:Description>El comprobante fue registrado exitosamente</cbc:Description>',
    '</ApplicationResponse>',
  ].join('\n');
  const cdrZip = crearZip([{ nombre: 'R-10759888079-03-B001-00000001.xml', contenido: Buffer.from(cdrXml, 'utf8') }]);
  reiniciar(() => respuestaHttp([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">',
    '  <soap-env:Body>',
    '    <ns2:sendBillResponse xmlns:ns2="http://service.sunat.gob.pe">',
    `      <applicationResponse>${cdrZip.toString('base64')}</applicationResponse>`,
    '    </ns2:sendBillResponse>',
    '  </soap-env:Body>',
    '</soap-env:Envelope>',
  ].join('\n')));
  s = await sunat.enviar(comprobanteDemo());
  check(
    'sunat beta: CDR aceptado (ResponseCode 0)',
    s.estado === 'aceptado' && s.codigo === '0',
    `${s.estado} · codigo=${s.codigo}`,
  );
  check(
    'sunat beta: sobre SOAP con sendBill y credenciales MODDATOS',
    llamadas[0]
      && llamadas[0].opciones.body.includes('<ser:sendBill>')
      && llamadas[0].opciones.body.includes('10759888079MODDATOS'),
    llamadas[0] ? llamadas[0].url : 'sin llamada',
  );

  // 12. SUNAT beta con fault -------------------------------------------
  reiniciar(() => respuestaHttp([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">',
    '  <soap-env:Body>',
    '    <soap-env:Fault>',
    '      <faultstring>0103 - El comprobante fue rechazado</faultstring>',
    '    </soap-env:Fault>',
    '  </soap-env:Body>',
    '</soap-env:Envelope>',
  ].join('\n')));
  s = await sunat.enviar(comprobanteDemo());
  check(
    'sunat beta: fault se reporta como error (no bloquea)',
    s.estado === 'error' && String(s.codigo) === 'SOAP_FAULT',
    `${s.estado} · ${s.codigo}`,
  );

  // 13. SUNAT produccion sin credenciales -------------------------------
  env.sunatMode = 'produccion';
  reiniciar();
  s = await sunat.enviar(comprobanteDemo());
  check(
    'sunat produccion: sin credenciales devuelve error',
    s.estado === 'error' && s.codigo === 'NO_CONFIGURADO',
    `${s.estado} · ${s.codigo}`,
  );

  // 14. Estado de integraciones ----------------------------------------
  env.sunatMode = 'simulado';
  const estado = require('../src/modules/integraciones/integraciones.service').estado();
  check(
    'integraciones: estado sin secretos',
    Boolean(estado.documento.proveedores_disponibles) && !JSON.stringify(estado).includes('token-de-prueba'),
    `sunat=${estado.sunat.modo}`,
  );

  const fallidos = resultados.filter((item) => !item.ok);
  console.log('\n' + '─'.repeat(74));
  console.log(`VERIFY INTEGRACIONES: ${resultados.length - fallidos.length}/${resultados.length} OK`);
  if (fallidos.length) {
    console.log(`Fallaron: ${fallidos.map((item) => item.nombre).join(', ')}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('VERIFY INTEGRACIONES FAIL:', error);
  process.exitCode = 1;
});
