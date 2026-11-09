'use strict';

// Generador de PDF reutilizable (PDFKit). No usa fuentes externas: solo las
// Helvetica que trae PDFKit. Se comparte entre los reportes y el cuadre de caja.

const PDFDocument = require('pdfkit');

const TAMANO = 'A4';
const MARGEN = 40;
const ALTO_FILA = 16;
const MAX_FILAS_POR_DEFECTO = 500;

const COLOR_TITULO = '#1f3864';
const COLOR_TEXTO = '#333333';
const COLOR_SUAVE = '#666666';
const COLOR_CABECERA = '#e0e0e0';
const COLOR_LINEA = '#cccccc';
const COLOR_NOTA = '#7f7f7f';

function numeroFinito(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

function formatoMonto(valor) {
  const numero = numeroFinito(valor);
  if (numero === null) {
    return '—';
  }
  return `S/ ${numero.toLocaleString('es-PE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatoEntero(valor) {
  const numero = numeroFinito(valor);
  if (numero === null) {
    return '—';
  }
  return numero.toLocaleString('es-PE', { maximumFractionDigits: 0 });
}

function formatoFecha(valor) {
  if (valor === null || valor === undefined || valor === '') {
    return '—';
  }
  return String(valor).slice(0, 10);
}

function valorTexto(valor, formato) {
  if (valor === null || valor === undefined || valor === '') {
    return '—';
  }
  if (formato === 'monto') {
    return formatoMonto(valor);
  }
  if (formato === 'entero') {
    return formatoEntero(valor);
  }
  if (formato === 'fecha') {
    return formatoFecha(valor);
  }
  if (typeof valor === 'boolean') {
    return valor ? 'Sí' : 'No';
  }
  if (Array.isArray(valor)) {
    return valor.join(', ') || '—';
  }
  if (typeof valor === 'object') {
    return JSON.stringify(valor);
  }
  return String(valor);
}

function anchoContenido(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function limiteInferior(doc) {
  return doc.page.height - doc.page.margins.bottom;
}

function nuevoDocumento(opciones = {}) {
  return new PDFDocument({
    size: TAMANO,
    margins: { top: MARGEN, bottom: MARGEN + 10, left: MARGEN, right: MARGEN },
    bufferPages: true,
    info: {
      Title: opciones.titulo || "Fratelli's",
      Author: opciones.autor || "Fratelli's · Sistema de Gestión Integral",
      Creator: 'fratellis-backend',
      CreationDate: new Date(),
    },
  });
}

function linea(doc, color = COLOR_LINEA) {
  const y = doc.y;
  doc
    .save()
    .lineWidth(0.7)
    .strokeColor(color)
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .stroke()
    .restore();
}

function asegurarEspacio(doc, alto) {
  if (doc.y + alto > limiteInferior(doc)) {
    doc.addPage();
  }
}

function dibujarEncabezado(doc, { titulo, subtitulo, generadoEn }) {
  doc.font('Helvetica-Bold').fontSize(16).fillColor(COLOR_TITULO).text(titulo);
  if (subtitulo) {
    doc.moveDown(0.15);
    doc.font('Helvetica').fontSize(10).fillColor(COLOR_SUAVE).text(subtitulo);
  }
  if (generadoEn) {
    doc.moveDown(0.15);
    doc.font('Helvetica').fontSize(8).fillColor(COLOR_NOTA).text(`Generado: ${generadoEn}`);
  }
  doc.moveDown(0.4);
  linea(doc);
  doc.moveDown(0.5);
}

// Panel de indicadores: etiqueta a la izquierda, valor a la derecha.
function dibujarKpis(doc, kpis) {
  if (!Array.isArray(kpis) || kpis.length === 0) {
    return;
  }
  const x = doc.page.margins.left;
  const ancho = anchoContenido(doc);
  const alto = 24 + kpis.length * ALTO_FILA;
  asegurarEspacio(doc, alto + 10);
  const y = doc.y;

  doc
    .save()
    .lineWidth(0.7)
    .strokeColor(COLOR_LINEA)
    .rect(x, y, ancho, alto)
    .stroke()
    .restore();
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR_TITULO).text('Indicadores', x + 8, y + 6);

  let filaY = y + 24;
  for (const kpi of kpis) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLOR_TEXTO)
      .text(kpi.etiqueta, x + 8, filaY, { width: ancho * 0.55, lineBreak: false, ellipsis: true });
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#111111')
      .text(valorTexto(kpi.valor, kpi.formato), x + 8 + ancho * 0.55, filaY, {
        width: ancho * 0.45 - 16,
        align: 'right',
        lineBreak: false,
      });
    filaY += ALTO_FILA;
  }

  doc.y = y + alto + 8;
}

// Ficha de pares etiqueta/valor (datos de cabecera del cuadre).
function dibujarFicha(doc, filas) {
  if (!Array.isArray(filas) || filas.length === 0) {
    return;
  }
  const x = doc.page.margins.left;
  const ancho = anchoContenido(doc);
  asegurarEspacio(doc, filas.length * ALTO_FILA + 10);

  for (const fila of filas) {
    const y = doc.y;
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLOR_SUAVE)
      .text(fila.etiqueta, x, y, { width: ancho * 0.55, lineBreak: false, ellipsis: true });
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(COLOR_TEXTO)
      .text(valorTexto(fila.valor, fila.formato), x + ancho * 0.55, y, {
        width: ancho * 0.45,
        align: 'left',
        lineBreak: false,
      });
    doc.y = y + ALTO_FILA;
  }
  doc.moveDown(0.5);
}

function anchosDeColumna(columnas, anchoDisponible) {
  const pesos = columnas.map((columna) => {
    const peso = Number(columna.peso ?? columna.ancho);
    return Number.isFinite(peso) && peso > 0 ? peso : 10;
  });
  const suma = pesos.reduce((total, peso) => total + peso, 0);

  const anchos = pesos.map((peso) => Math.floor((anchoDisponible * peso) / suma));
  const diferencia = anchoDisponible - anchos.reduce((total, ancho) => total + ancho, 0);
  if (anchos.length > 0) {
    anchos[anchos.length - 1] += diferencia;
  }
  return anchos;
}

function dibujarCabeceraTabla(doc, columnas, anchos) {
  const x = doc.page.margins.left;
  const y = doc.y;
  const anchoTotal = anchos.reduce((total, ancho) => total + ancho, 0);

  doc
    .save()
    .rect(x, y, anchoTotal, ALTO_FILA + 4)
    .fill(COLOR_CABECERA)
    .restore();

  let cursor = x;
  for (let indice = 0; indice < columnas.length; indice += 1) {
    const columna = columnas[indice];
    const ancho = anchos[indice];
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor('#222222')
      .text(String(columna.etiqueta || columna.clave || ''), cursor + 4, y + 5, {
        width: ancho - 8,
        height: ALTO_FILA - 2,
        align: columna.alineacion || 'left',
        lineBreak: false,
        ellipsis: true,
      });
    cursor += ancho;
  }

  doc.y = y + ALTO_FILA + 4;
}

function dibujarTabla(doc, opciones) {
  const columnas = Array.isArray(opciones.columnas) ? opciones.columnas : [];
  const filas = Array.isArray(opciones.filas) ? opciones.filas : [];
  const maxFilas = Number.isFinite(Number(opciones.maxFilas))
    ? Math.max(1, Number(opciones.maxFilas))
    : MAX_FILAS_POR_DEFECTO;

  asegurarEspacio(doc, 40);
  if (opciones.titulo) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR_TITULO).text(opciones.titulo);
    doc.moveDown(0.25);
  }

  if (columnas.length === 0 || filas.length === 0) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(9)
      .fillColor(COLOR_NOTA)
      .text(opciones.vacio || 'Sin datos para mostrar.');
    doc.moveDown(0.6);
    return;
  }

  const anchos = anchosDeColumna(columnas, anchoContenido(doc));
  dibujarCabeceraTabla(doc, columnas, anchos);

  const visibles = filas.slice(0, maxFilas);
  let indice = 0;
  for (const fila of visibles) {
    if (doc.y + ALTO_FILA > limiteInferior(doc)) {
      doc.addPage();
      dibujarCabeceraTabla(doc, columnas, anchos);
    }
    const y = doc.y;
    const fondo = indice % 2 === 1;
    if (fondo) {
      doc
        .save()
        .rect(doc.page.margins.left, y, anchos.reduce((total, ancho) => total + ancho, 0), ALTO_FILA)
        .fill('#f5f5f5')
        .restore();
    }

    let cursor = doc.page.margins.left;
    for (let indiceColumna = 0; indiceColumna < columnas.length; indiceColumna += 1) {
      const columna = columnas[indiceColumna];
      const ancho = anchos[indiceColumna];
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(COLOR_TEXTO)
        .text(valorTexto(fila[columna.clave], columna.formato), cursor + 4, y + 4, {
          width: ancho - 8,
          height: ALTO_FILA - 2,
          align: columna.alineacion || 'left',
          lineBreak: false,
          ellipsis: true,
        });
      cursor += ancho;
    }

    doc.y = y + ALTO_FILA;
    indice += 1;
  }

  if (filas.length > visibles.length) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(8)
      .fillColor(COLOR_NOTA)
      .text(`Mostrando ${visibles.length} de ${filas.length} filas.`);
  }
  doc.moveDown(0.7);
}

// Pie con numeración de páginas. Se escribe cuando el contenido ya está creado
// (bufferPages) para conocer el total.
function dibujarPie(doc, texto) {
  const rango = doc.bufferedPageRange();
  for (let indice = 0; indice < rango.count; indice += 1) {
    doc.switchToPage(rango.start + indice);
    const margenInferior = doc.page.margins.bottom;
    const margenIzquierdo = doc.page.margins.left;
    const ancho = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLOR_NOTA)
      .text(`${texto} · Página ${indice + 1} de ${rango.count}`, margenIzquierdo, doc.page.height - 30, {
        width: ancho,
        align: 'center',
        lineBreak: false,
      });
    doc.page.margins.bottom = margenInferior;
  }
}

function finalizarPdf(doc) {
  return new Promise((resolve, reject) => {
    const trozos = [];
    doc.on('data', (troz) => trozos.push(troz));
    doc.on('end', () => resolve(Buffer.concat(trozos)));
    doc.on('error', reject);
    doc.end();
  });
}

// Punto de entrada: arma el documento completo y devuelve el PDF en memoria.
async function exportarPdf(opciones) {
  const doc = nuevoDocumento(opciones);
  dibujarEncabezado(doc, opciones);

  if (Array.isArray(opciones.kpis) && opciones.kpis.length > 0) {
    dibujarKpis(doc, opciones.kpis);
  }
  if (Array.isArray(opciones.ficha) && opciones.ficha.length > 0) {
    dibujarFicha(doc, opciones.ficha);
  }
  for (const seccion of opciones.secciones || []) {
    dibujarTabla(doc, {
      ...seccion,
      maxFilas: seccion.maxFilas === undefined ? opciones.maxFilas : seccion.maxFilas,
    });
  }

  dibujarPie(doc, opciones.pie || "Fratelli's");
  return finalizarPdf(doc);
}

module.exports = {
  MAX_FILAS_POR_DEFECTO,
  formatoMonto,
  formatoEntero,
  formatoFecha,
  valorTexto,
  nuevoDocumento,
  dibujarEncabezado,
  dibujarKpis,
  dibujarFicha,
  dibujarTabla,
  dibujarPie,
  finalizarPdf,
  exportarPdf,
};
