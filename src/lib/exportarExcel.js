'use strict';

// Generador de libros XLSX reutilizable (ExcelJS).
// Las rutas solo aportan la definición (hojas, columnas y filas); este módulo
// se encarga del formato: cabecera con relleno, anchos fijos, montos con
// formato #,##0.00, panel congelado y sin fórmulas.

const ExcelJS = require('exceljs');

const FORMATO_MONTO = '#,##0.00';
const COLOR_CABECERA = 'FF1F3864';
const COLOR_TITULO = 'FFD9E2F3';
const MAX_NOMBRE_HOJA = 31;

function hoyIso() {
  return new Date().toISOString().slice(0, 10);
}

function textoFecha(valor) {
  if (valor === null || valor === undefined || valor === '') {
    return 'Sin límite';
  }
  return String(valor).slice(0, 10);
}

function nombreHoja(valor) {
  const limpio = String(valor || 'HOJA')
    .replace(/[\\/*?[\]:]/g, '_')
    .trim()
    .toUpperCase();
  return (limpio || 'HOJA').slice(0, MAX_NOMBRE_HOJA);
}

function numeroFinito(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

// Normaliza una columna declarativa a lo que ExcelJS necesita.
function normalizarColumna(columna, indice) {
  return {
    clave: columna.clave || `c${indice + 1}`,
    etiqueta: columna.etiqueta || columna.clave || `Columna ${indice + 1}`,
    ancho: Number(columna.ancho) > 0 ? Number(columna.ancho) : 18,
    dinero: Boolean(columna.dinero) || columna.formato === 'monto',
  };
}

// Valor listo para la celda: fechas/bool/strings se conservan, los números
// de columna monetaria se envían como número para que numFmt haga el resto.
function valorCelda(valor, columna) {
  if (valor === null || valor === undefined) {
    return null;
  }
  if (typeof valor === 'boolean' || valor instanceof Date) {
    return valor;
  }
  if (typeof valor === 'number') {
    return valor;
  }
  if (columna.dinero) {
    const numero = numeroFinito(valor);
    if (numero !== null) {
      return numero;
    }
  }
  if (Array.isArray(valor)) {
    return valor.join(', ');
  }
  if (typeof valor === 'object') {
    return JSON.stringify(valor);
  }
  return valor;
}

function pintarCabecera(fila) {
  fila.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  fila.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: COLOR_CABECERA },
  };
  fila.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  fila.height = 20;
}

function construirResumen(libro, definicion) {
  const hoja = libro.addWorksheet('RESUMEN', {
    properties: { defaultRowHeight: 18 },
  });
  hoja.columns = [
    { key: 'concepto', width: 36 },
    { key: 'valor', width: 34 },
  ];

  const titulo = hoja.addRow([definicion.titulo]);
  hoja.mergeCells(`A${titulo.number}:B${titulo.number}`);
  titulo.getCell(1).font = { bold: true, size: 14, color: { argb: COLOR_CABECERA } };
  titulo.getCell(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: COLOR_TITULO },
  };
  titulo.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
  titulo.height = 24;

  const meta = [
    ['Tipo', definicion.tipo],
    ['Desde', textoFecha(definicion.desde)],
    ['Hasta', textoFecha(definicion.hasta)],
    ['Generado en', definicion.generadoEn],
  ];
  for (const [etiqueta, valor] of meta) {
    const fila = hoja.addRow([etiqueta, valor]);
    fila.getCell(1).font = { bold: true };
  }

  hoja.addRow([]);

  const cabeceraKpi = hoja.addRow(['KPI', 'Valor']);
  pintarCabecera(cabeceraKpi);

  for (const kpi of definicion.kpis || []) {
    const fila = hoja.addRow([kpi.etiqueta, kpi.valor === undefined ? null : kpi.valor]);
    if (kpi.formato === 'monto') {
      fila.getCell(2).numFmt = FORMATO_MONTO;
    }
    fila.getCell(2).alignment = { horizontal: kpi.formato === 'monto' ? 'right' : 'left' };
  }

  // Fija título, metadatos y cabecera de KPIs al desplazarse.
  hoja.views = [{ state: 'frozen', ySplit: 7 }];
  return hoja;
}

function construirHoja(libro, seccion, maxFilas) {
  const columnas = (seccion.columnas || []).map(normalizarColumna);
  const hoja = libro.addWorksheet(nombreHoja(seccion.nombre));

  hoja.columns = columnas.map((columna) => ({
    header: columna.etiqueta,
    key: columna.clave,
    width: columna.ancho,
  }));
  pintarCabecera(hoja.getRow(1));

  const filas = Array.isArray(seccion.filas) ? seccion.filas : [];
  const visibles = typeof maxFilas === 'number' ? filas.slice(0, maxFilas) : filas;

  for (const item of visibles) {
    const valores = {};
    for (const columna of columnas) {
      valores[columna.clave] = valorCelda(item[columna.clave], columna);
    }
    hoja.addRow(valores);
  }

  // El formato monetario se aplica a toda la columna (incluye filas futuras).
  columnas.forEach((columna, indice) => {
    if (columna.dinero) {
      hoja.getColumn(indice + 1).numFmt = FORMATO_MONTO;
    }
  });

  if (filas.length > visibles.length) {
    const nota = hoja.addRow([`Mostrando ${visibles.length} de ${filas.length} filas.`]);
    nota.font = { italic: true, color: { argb: 'FF7F7F7F' } };
  }

  hoja.views = [{ state: 'frozen', ySplit: 1 }];
  return hoja;
}

function crearLibro(definicion) {
  const libro = new ExcelJS.Workbook();
  libro.creator = "Fratelli's · Sistema de Gestión Integral";
  libro.created = new Date();

  construirResumen(libro, definicion);

  const maxFilas = definicion.maxFilas === undefined ? 500 : definicion.maxFilas;
  for (const seccion of definicion.hojas || []) {
    construirHoja(libro, seccion, maxFilas);
  }

  return libro;
}

async function libroABuffer(libro) {
  const datos = await libro.xlsx.writeBuffer();
  return Buffer.isBuffer(datos) ? datos : Buffer.from(datos);
}

// Punto de entrada único: recibe la definición y devuelve el .xlsx en memoria.
async function exportarExcel(definicion) {
  return libroABuffer(crearLibro(definicion));
}

// Utilidades para las definiciones de cada reporte.
function kpi(etiqueta, valor, formato) {
  return { etiqueta, valor, formato };
}

function columna(clave, etiqueta, ancho, dinero = false) {
  return { clave, etiqueta, ancho, dinero };
}

module.exports = {
  FORMATO_MONTO,
  exportarExcel,
  crearLibro,
  libroABuffer,
  kpi,
  columna,
  hoyIso,
  textoFecha,
};
