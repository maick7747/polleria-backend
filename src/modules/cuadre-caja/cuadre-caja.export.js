'use strict';

// Definición del PDF del cuadre de caja. Reutiliza src/lib/exportarPdf.js.

const { exportarPdf } = require('../../lib/exportarPdf');

function aNumero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

function mayusculaInicial(texto) {
  const valor = String(texto || '');
  return valor ? valor.charAt(0).toUpperCase() + valor.slice(1) : valor;
}

// Los datos del negocio son opcionales: solo se muestran si están en
// `configuracion`. Fratelli's no guarda razón social ni RUC en esta versión.
function leerNegocio(raw = {}) {
  const tomar = (...claves) => {
    for (const clave of claves) {
      const valor = raw[clave];
      if (valor !== undefined && valor !== null && String(valor).trim() !== '') {
        return String(valor).trim();
      }
    }
    return null;
  };

  return {
    nombre:
      tomar('negocio_nombre', 'nombre_comercial', 'razon_social', 'clinica_nombre') ||
      "Fratelli's",
    ruc: tomar('ruc', 'negocio_ruc'),
    direccion: tomar('direccion', 'negocio_direccion'),
    telefono: tomar('telefono', 'negocio_telefono'),
  };
}

// `metodos` viene del reporte de ventas del mismo día (por_metodo). Es
// opcional: si falla o no hay pagos, el PDF se emite igual.
function seccionesMetodos(metodos) {
  const filas = (Array.isArray(metodos) ? metodos : []).map((item) => ({
    metodo: item.metodo,
    cantidad: aNumero(item.cantidad),
    monto: aNumero(item.monto),
  }));
  if (filas.length === 0) {
    return [];
  }
  return [
    {
      titulo: 'Resumen por método de pago',
      columnas: [
        { clave: 'metodo', etiqueta: 'Método', ancho: 24, formato: 'texto' },
        { clave: 'cantidad', etiqueta: 'Pagos', ancho: 12, formato: 'entero' },
        { clave: 'monto', etiqueta: 'Monto', ancho: 18, formato: 'monto' },
      ],
      filas,
    },
  ];
}

function fichaCuadre(cuadre, negocio) {
  const filas = [{ etiqueta: 'Negocio', valor: negocio.nombre }];
  if (negocio.ruc) {
    filas.push({ etiqueta: 'RUC', valor: negocio.ruc });
  }
  if (negocio.direccion) {
    filas.push({ etiqueta: 'Dirección', valor: negocio.direccion });
  }
  if (negocio.telefono) {
    filas.push({ etiqueta: 'Teléfono', valor: negocio.telefono });
  }
  filas.push({ etiqueta: 'Cuadre', valor: `#${cuadre.id}` });
  filas.push({ etiqueta: 'Fecha', valor: cuadre.fecha, formato: 'fecha' });
  filas.push({ etiqueta: 'Estado', valor: mayusculaInicial(cuadre.estado) });
  filas.push({
    etiqueta: 'Observaciones',
    valor: cuadre.observaciones || 'Sin observaciones registradas',
  });
  return filas;
}

function kpisCuadre(cuadre, resumen) {
  return [
    { etiqueta: 'Fondo inicial', valor: aNumero(cuadre.fondo_inicial), formato: 'monto' },
    { etiqueta: 'Ventas del día', valor: aNumero(resumen.total_ventas), formato: 'monto' },
    { etiqueta: 'Gastos', valor: aNumero(resumen.total_gastos), formato: 'monto' },
    { etiqueta: 'Reembolsos', valor: aNumero(resumen.total_reembolsos), formato: 'monto' },
    { etiqueta: 'Egresos totales', valor: aNumero(resumen.total_egresos), formato: 'monto' },
    { etiqueta: 'Pagos digitales', valor: aNumero(cuadre.pagos_digitales), formato: 'monto' },
    { etiqueta: 'Monto esperado', valor: aNumero(resumen.monto_esperado), formato: 'monto' },
    { etiqueta: 'Efectivo contado', valor: aNumero(cuadre.efectivo_contado), formato: 'monto' },
    { etiqueta: 'Total real', valor: aNumero(resumen.total_real), formato: 'monto' },
    { etiqueta: 'Diferencia', valor: aNumero(resumen.diferencia), formato: 'monto' },
    { etiqueta: 'Tolerancia', valor: 0, formato: 'monto' },
  ];
}

async function exportarPdfCuadre(cuadre, opciones = {}) {
  const resumen = cuadre.resumen || {};
  const negocio = leerNegocio(opciones.configuracion || {});
  const generadoEn = opciones.generadoEn || new Date().toISOString();

  return exportarPdf({
    titulo: "Fratelli's · Cuadre de caja",
    subtitulo: `Cuadre #${cuadre.id} · ${String(cuadre.fecha).slice(0, 10)} · ${mayusculaInicial(cuadre.estado)}`,
    generadoEn,
    ficha: fichaCuadre(cuadre, negocio),
    kpis: kpisCuadre(cuadre, resumen),
    secciones: seccionesMetodos(opciones.metodos),
    pie: 'Documento generado por el sistema',
  });
}

module.exports = {
  leerNegocio,
  exportarPdfCuadre,
};
