'use strict';

// Boleta / ticket en PDF para impresora térmica de 80 mm.
//
// No usa fuentes externas: Courier y Courier-Bold vienen con PDFKit. El ancho
// de página es 80 mm (226.77 pt) y la altura se calcula según el número de
// platos para que la etiqueta no salga con un espacio blanco enorme.

const PDFDocument = require('pdfkit');
const { finalizarPdf } = require('./exportarPdf');

const ANCHO_MM80 = 226.77;
const MARGEN = 10;
const ANCHO_CONTENIDO = ANCHO_MM80 - MARGEN * 2;
const ALTO_MINIMO = 300;

const TIPO_LABEL = {
  boleta: 'BOLETA ELECTRÓNICA',
  ticket: 'TICKET DE VENTA',
  factura: 'FACTURA ELECTRÓNICA',
  ninguno: 'COMPROBANTE INTERNO',
};

const METODO_LABEL = {
  efectivo: 'EFECTIVO',
  tarjeta: 'TARJETA',
  yape: 'YAPE',
  plin: 'PLIN',
  transferencia: 'TRANSFERENCIA',
};

function texto(valor) {
  return valor === undefined || valor === null ? '' : String(valor);
}

function monto(valor) {
  const numero = Number(valor);
  const seguro = Number.isFinite(numero) ? numero : 0;
  return `S/ ${seguro.toFixed(2)}`;
}

function fechaLima(iso) {
  if (!iso) {
    return '—';
  }
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) {
    return String(iso).slice(0, 19);
  }
  const formateador = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return formateador.format(fecha).replace(',', '');
}

function alturaEstimada(comprobante) {
  const items = Array.isArray(comprobante.items) ? comprobante.items : [];
  const altoItems = items.reduce(
    (total, item) => total + (item.notas ? 26 : 18),
    0,
  );
  return Math.max(ALTO_MINIMO, 210 + altoItems + 150);
}

function crearDocumento(comprobante) {
  return new PDFDocument({
    size: [ANCHO_MM80, alturaEstimada(comprobante)],
    margins: { top: MARGEN, bottom: MARGEN, left: MARGEN, right: MARGEN },
    bufferPages: true,
    info: {
      Title: `${TIPO_LABEL[comprobante.tipo] || 'Comprobante'} ${texto(comprobante.numero)}`,
      Author: comprobante.negocio?.nombre || "Fratelli's",
      Creator: 'fratellis-backend',
      CreationDate: new Date(),
    },
  });
}

function centrado(doc, contenido, opciones = {}) {
  doc
    .font(opciones.bold ? 'Courier-Bold' : 'Courier')
    .fontSize(opciones.size || 7.5)
    .fillColor(opciones.color || '#000000')
    .text(contenido, MARGEN, doc.y, {
      width: ANCHO_CONTENIDO,
      align: 'center',
      lineGap: 0,
    });
}

function separador(doc, caracter = '-') {
  doc
    .font('Courier')
    .fontSize(7)
    .fillColor('#444444')
    .text(caracter.repeat(46), MARGEN, doc.y, {
      width: ANCHO_CONTENIDO,
      align: 'center',
      lineGap: 0,
    });
}

function fila(doc, etiqueta, valor, opciones = {}) {
  const y = doc.y;
  // La columna de valores admite 19 caracteres a 7.5 pt Courier sin desbordar
  // el ancho de 80 mm. Un nombre de cliente largo partía la línea y se montaba
  // sobre el separador; aquí se recorta antes de dibujar.
  const recortado = texto(valor).length > 19
    ? `${texto(valor).slice(0, 18)}.`
    : texto(valor);
  doc
    .font(opciones.bold ? 'Courier-Bold' : 'Courier')
    .fontSize(opciones.size || 7.5)
    .fillColor('#000000')
    .text(etiqueta, MARGEN, y, {
      width: ANCHO_CONTENIDO - 86,
      lineBreak: false,
      ellipsis: true,
    });
  doc
    .font(opciones.boldValor ? 'Courier-Bold' : 'Courier')
    .fontSize(opciones.size || 7.5)
    .fillColor('#000000')
    .text(recortado, MARGEN + ANCHO_CONTENIDO - 86, y, {
      width: 86,
      align: 'right',
      lineBreak: false,
    });
  doc.y = y + (opciones.alto || 11);
}

function itemLinea(doc, item) {
  const y = doc.y;
  const cantidad = Number(item.cantidad) || 1;
  const nombre = texto(item.platillo || item.nombre);
  const importe = Number(item.subtotal) || Number(item.precio_unitario) * cantidad || 0;

  doc
    .font('Courier')
    .fontSize(7.2)
    .fillColor('#000000')
    .text(`${cantidad}x`, MARGEN, y, { width: 16, lineBreak: false });

  doc
    .font('Courier')
    .fontSize(7.2)
    .fillColor('#000000')
    .text(nombre, MARGEN + 17, y, {
      width: ANCHO_CONTENIDO - 17 - 54,
      lineBreak: false,
      ellipsis: true,
    });

  doc
    .font('Courier-Bold')
    .fontSize(7.2)
    .fillColor('#000000')
    .text(importe.toFixed(2), MARGEN + ANCHO_CONTENIDO - 54, y, {
      width: 54,
      align: 'right',
      lineBreak: false,
    });

  doc.y = y + 12;

  if (item.notas) {
    doc
      .font('Courier-Oblique')
      .fontSize(6.5)
      .fillColor('#333333')
      .text(`  ${texto(item.notas)}`, MARGEN + 17, doc.y, {
        width: ANCHO_CONTENIDO - 17,
        lineBreak: false,
        ellipsis: true,
      });
    doc.y += 9;
  }
}

function dibujar(doc, comprobante) {
  const negocio = comprobante.negocio || {};
  const items = Array.isArray(comprobante.items) ? comprobante.items : [];
  const tipo = TIPO_LABEL[comprobante.tipo] || TIPO_LABEL.ninguno;

  centrado(doc, texto(negocio.nombre || "Fratelli's Restaurante").toUpperCase(), {
    bold: true,
    size: 9,
  });
  if (negocio.ruc) {
    centrado(doc, `RUC ${negocio.ruc}`, { size: 7.5 });
  }
  if (negocio.direccion) {
    centrado(doc, negocio.direccion, { size: 6.8 });
  }
  if (negocio.telefono) {
    centrado(doc, `Tel. ${negocio.telefono}`, { size: 6.8 });
  }

  doc.y += 3;
  separador(doc, '=');
  doc.y += 2;

  centrado(doc, tipo, { bold: true, size: 8.5 });
  centrado(doc, texto(comprobante.numero), { bold: true, size: 9 });
  doc.y += 2;
  separador(doc);

  fila(doc, 'Fecha', fechaLima(comprobante.fecha));
  if (comprobante.mesa_numero) {
    fila(doc, 'Mesa', String(comprobante.mesa_numero).padStart(2, '0'));
  }
  if (comprobante.mozo) {
    fila(doc, 'Mozo', texto(comprobante.mozo));
  }
  fila(doc, 'Cliente', texto(comprobante.cliente || 'Consumidor final'));
  if (comprobante.documento) {
    fila(
      doc,
      comprobante.tipo_documento || 'Doc.',
      texto(comprobante.documento),
    );
  }

  separador(doc);
  const yCabecera = doc.y;
  doc
    .font('Courier-Bold')
    .fontSize(6.8)
    .fillColor('#000000')
    .text('CANT  DESCRIPCIÓN', MARGEN, yCabecera, { lineBreak: false });
  doc.text('IMPORTE', MARGEN + ANCHO_CONTENIDO - 54, yCabecera, {
    width: 54,
    align: 'right',
    lineBreak: false,
  });
  doc.y = yCabecera + 11;
  separador(doc);

  if (items.length === 0) {
    doc
      .font('Courier-Oblique')
      .fontSize(7)
      .fillColor('#333333')
      .text('Sin platos registrados', MARGEN, doc.y, {
        width: ANCHO_CONTENIDO,
        align: 'center',
      });
    doc.y += 10;
  } else {
    for (const item of items) {
      itemLinea(doc, item);
    }
  }

  separador(doc);
  fila(doc, 'SUBTOTAL', monto(comprobante.subtotal));
  fila(doc, 'IGV (18%)', monto(comprobante.igv));
  separador(doc, '=');
  fila(doc, 'TOTAL', monto(comprobante.total), {
    bold: true,
    boldValor: true,
    size: 9,
    alto: 14,
  });
  separador(doc, '=');

  if (comprobante.metodo) {
    fila(
      doc,
      'Pago',
      METODO_LABEL[comprobante.metodo] || String(comprobante.metodo).toUpperCase(),
    );
  }

  doc.y += 2;
  const sunatEstado = comprobante.sunat && comprobante.sunat.estado
    ? String(comprobante.sunat.estado).toUpperCase()
    : 'SIMULADO';
  centrado(doc, `SUNAT: COMPROBANTE ${sunatEstado}`, {
    size: 6.5,
    color: '#444444',
  });
  centrado(doc, '¡Gracias por su visita!', { bold: true, size: 7.5 });
  centrado(doc, "Fratelli's · Sistema de Gestión", {
    size: 6,
    color: '#666666',
  });
}

async function generarBoletaPdf(comprobante) {
  const doc = crearDocumento(comprobante);
  dibujar(doc, comprobante);
  return finalizarPdf(doc);
}

module.exports = {
  generarBoletaPdf,
  alturaEstimada,
  fechaLima,
  monto,
};
