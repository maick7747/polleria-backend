'use strict';

// Traduce la respuesta de reportes.service.obtenerReporte() a una definición
// única que alimenta los helpers de Excel y PDF (mismas columnas, mismo orden).

const { exportarExcel, kpi } = require('../../lib/exportarExcel');
const { exportarPdf } = require('../../lib/exportarPdf');

const MAX_FILAS_TABLA = 500;

function columna(clave, etiqueta, ancho, formato = 'texto', peso) {
  return {
    clave,
    etiqueta,
    ancho,
    formato,
    peso: peso || Math.max(8, Math.round(ancho * 0.75)),
  };
}

function aNumero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

function mapear(items, construir) {
  return (Array.isArray(items) ? items : []).map(construir);
}

function kpisVentas(datos) {
  return [
    kpi('Total vendido', aNumero(datos.total), 'monto'),
    kpi('Cantidad de pagos', aNumero(datos.cantidad_pagos), 'entero'),
    kpi('Tickets', aNumero(datos.cantidad_tickets), 'entero'),
    kpi('Ticket promedio', aNumero(datos.ticket_promedio), 'monto'),
  ];
}

function hojasVentas(datos) {
  return [
    {
      nombre: 'POR_DIA',
      titulo: 'Ventas por día',
      columnas: [
        columna('fecha', 'Fecha', 14, 'fecha'),
        columna('cantidad', 'Pagos', 12, 'entero'),
        columna('monto', 'Monto', 16, 'monto'),
      ],
      filas: mapear(datos.por_dia, (item) => ({
        fecha: item.fecha,
        cantidad: item.cantidad,
        monto: item.monto,
      })),
    },
    {
      nombre: 'POR_CANAL',
      titulo: 'Ventas por canal',
      columnas: [
        columna('canal', 'Canal', 20),
        columna('cantidad', 'Pagos', 12, 'entero'),
        columna('monto', 'Monto', 16, 'monto'),
      ],
      filas: mapear(datos.por_canal, (item) => ({
        canal: item.canal,
        cantidad: item.cantidad,
        monto: item.monto,
      })),
    },
    {
      nombre: 'POR_METODO',
      titulo: 'Ventas por método de pago',
      columnas: [
        columna('metodo', 'Método', 20),
        columna('cantidad', 'Pagos', 12, 'entero'),
        columna('monto', 'Monto', 16, 'monto'),
      ],
      filas: mapear(datos.por_metodo, (item) => ({
        metodo: item.metodo,
        cantidad: item.cantidad,
        monto: item.monto,
      })),
    },
    {
      nombre: 'TOP_PLATILLOS',
      titulo: 'Top platillos',
      columnas: [
        columna('platillo', 'Platillo', 30),
        columna('cantidad', 'Cantidad', 12, 'entero'),
        columna('monto', 'Monto', 16, 'monto'),
      ],
      filas: mapear(datos.top_platillos, (item) => ({
        platillo: item.platillo,
        cantidad: item.cantidad,
        monto: item.monto,
      })),
    },
    {
      nombre: 'DETALLE',
      titulo: 'Detalle de pagos',
      columnas: [
        columna('fecha', 'Fecha', 22, 'fecha'),
        columna('canal', 'Canal', 18),
        columna('metodo', 'Método', 16),
        columna('sujeto', 'Pedido/Cuenta', 22),
        columna('monto', 'Monto', 14, 'monto'),
      ],
      filas: mapear(datos.detalle, (item) => ({
        fecha: item.fecha,
        canal: item.canal,
        metodo: item.metodo,
        sujeto: item.sujeto,
        monto: item.monto,
      })),
    },
  ];
}

function kpisCostos(datos) {
  return [
    kpi('Total compras', aNumero(datos.compras && datos.compras.total), 'monto'),
    kpi('Total gastos', aNumero(datos.gastos && datos.gastos.total), 'monto'),
    kpi('Total mermas', aNumero(datos.mermas && datos.mermas.total), 'monto'),
    kpi('Total costos', aNumero(datos.total_costos), 'monto'),
  ];
}

function hojasCostos(datos) {
  return [
    {
      nombre: 'POR_PROVEEDOR',
      titulo: 'Compras por proveedor',
      columnas: [
        columna('proveedor', 'Proveedor', 30),
        columna('registros', 'Registros', 12, 'entero'),
        columna('total', 'Total', 16, 'monto'),
      ],
      filas: mapear(datos.compras && datos.compras.por_proveedor, (item) => ({
        proveedor: item.proveedor,
        registros: item.registros,
        total: item.total,
      })),
    },
    {
      nombre: 'POR_CATEGORIA',
      titulo: 'Gastos por categoría',
      columnas: [
        columna('categoria', 'Categoría', 24),
        columna('registros', 'Registros', 12, 'entero'),
        columna('total', 'Total', 16, 'monto'),
      ],
      filas: mapear(datos.gastos && datos.gastos.por_categoria, (item) => ({
        categoria: item.categoria,
        registros: item.registros,
        total: item.total,
      })),
    },
    {
      nombre: 'POR_TIPO',
      titulo: 'Mermas por tipo',
      columnas: [
        columna('tipo', 'Tipo', 26),
        columna('registros', 'Registros', 12, 'entero'),
        columna('total', 'Total', 16, 'monto'),
      ],
      filas: mapear(datos.mermas && datos.mermas.por_tipo, (item) => ({
        tipo: item.tipo,
        registros: item.registros,
        total: item.total,
      })),
    },
  ];
}

function hojasMerma(datos) {
  return [
    {
      nombre: 'POR_TIPO',
      titulo: 'Mermas por tipo',
      columnas: [
        columna('tipo', 'Tipo', 26),
        columna('registros', 'Registros', 12, 'entero'),
        columna('costo', 'Costo', 16, 'monto'),
      ],
      filas: mapear(datos.por_tipo, (item) => ({
        tipo: item.tipo,
        registros: item.registros,
        costo: item.costo,
      })),
    },
    {
      nombre: 'POR_CLASIFICACION',
      titulo: 'Mermas por clasificación',
      columnas: [
        columna('clasificacion', 'Clasificación', 26),
        columna('registros', 'Registros', 12, 'entero'),
        columna('costo', 'Costo', 16, 'monto'),
      ],
      filas: mapear(datos.por_clasificacion, (item) => ({
        clasificacion: item.clasificacion,
        registros: item.registros,
        costo: item.costo,
      })),
    },
  ];
}

function hojasDevoluciones(datos) {
  return [
    {
      nombre: 'POR_ESTADO',
      titulo: 'Devoluciones por estado',
      columnas: [
        columna('estado', 'Estado', 24),
        columna('registros', 'Registros', 12, 'entero'),
      ],
      filas: mapear(datos.por_estado, (item) => ({
        estado: item.estado,
        registros: item.registros,
      })),
    },
    {
      nombre: 'POR_RESOLUCION',
      titulo: 'Devoluciones por resolución',
      columnas: [
        columna('resolucion', 'Resolución', 24),
        columna('registros', 'Registros', 12, 'entero'),
        columna('reembolsado', 'Reembolsado', 16, 'monto'),
      ],
      filas: mapear(datos.por_resolucion, (item) => ({
        resolucion: item.resolucion,
        registros: item.registros,
        reembolsado: item.reembolsado,
      })),
    },
    {
      nombre: 'DETALLE',
      titulo: 'Detalle de devoluciones',
      columnas: [
        columna('id', 'ID', 8, 'entero'),
        columna('pedido_id', 'Pedido', 10, 'entero'),
        columna('motivo', 'Motivo', 34),
        columna('estado', 'Estado', 14),
        columna('resolucion', 'Resolución', 18),
        columna('monto_reembolsado', 'Reembolsado', 14, 'monto'),
        columna('fecha', 'Fecha', 14, 'fecha'),
      ],
      filas: mapear(datos.detalle, (item) => ({
        id: item.id,
        pedido_id: item.pedido_id,
        motivo: item.motivo,
        estado: item.estado,
        resolucion: item.resolucion,
        monto_reembolsado: item.monto_reembolsado,
        fecha: item.fecha,
      })),
    },
  ];
}

function hojasInventario(datos) {
  return [
    {
      nombre: 'POR_CATEGORIA',
      titulo: 'Inventario por categoría',
      columnas: [
        columna('categoria', 'Categoría', 24),
        columna('insumos', 'Insumos', 12, 'entero'),
        columna('valor', 'Valor', 16, 'monto'),
      ],
      filas: mapear(datos.por_categoria, (item) => ({
        categoria: item.categoria,
        insumos: item.insumos,
        valor: item.valor,
      })),
    },
    {
      nombre: 'INSUMOS',
      titulo: 'Detalle de insumos',
      columnas: [
        columna('id', 'ID', 8, 'entero'),
        columna('codigo', 'Código', 14),
        columna('nombre', 'Insumo', 28),
        columna('categoria', 'Categoría', 18),
        columna('unidad_medida', 'Unidad', 10),
        columna('stock_actual', 'Stock', 10, 'entero'),
        columna('stock_minimo', 'Mínimo', 10, 'entero'),
        columna('costo_promedio', 'Costo prom.', 14, 'monto'),
        columna('valor', 'Valor', 14, 'monto'),
        columna('estado', 'Estado', 12),
      ],
      filas: mapear(datos.insumos, (item) => ({
        id: item.id,
        codigo: item.codigo,
        nombre: item.nombre,
        categoria: item.categoria,
        unidad_medida: item.unidad_medida,
        stock_actual: item.stock_actual,
        stock_minimo: item.stock_minimo,
        costo_promedio: item.costo_promedio,
        valor: item.valor,
        estado: item.estado,
      })),
    },
  ];
}

function hojasActivos(datos) {
  return [
    {
      nombre: 'POR_CATEGORIA',
      titulo: 'Activos por categoría',
      columnas: [
        columna('categoria', 'Categoría', 24),
        columna('activos', 'Activos', 12, 'entero'),
        columna('valor', 'Valor', 16, 'monto'),
      ],
      filas: mapear(datos.por_categoria, (item) => ({
        categoria: item.categoria,
        activos: item.activos,
        valor: item.valor,
      })),
    },
    {
      nombre: 'ACTIVOS',
      titulo: 'Detalle de activos',
      columnas: [
        columna('id', 'ID', 8, 'entero'),
        columna('nombre', 'Activo', 30),
        columna('categoria', 'Categoría', 18),
        columna('estado', 'Estado', 16),
        columna('cantidad', 'Cantidad', 10, 'entero'),
        columna('vida_util_meses', 'Vida útil (m)', 12, 'entero'),
        columna('antiguedad_meses', 'Antigüedad (m)', 12, 'entero'),
        columna('vida_util_vencida', 'Vida vencida', 12),
        columna('mantenimientos', 'Mant.', 8, 'entero'),
      ],
      filas: mapear(datos.activos, (item) => ({
        id: item.id,
        nombre: item.nombre,
        categoria: item.categoria,
        estado: item.estado,
        cantidad: item.cantidad,
        vida_util_meses: item.vida_util_meses,
        antiguedad_meses: item.antiguedad_meses,
        vida_util_vencida: item.vida_util_vencida,
        mantenimientos: item.mantenimientos,
      })),
    },
  ];
}

function hojasPersonal(datos) {
  return [
    {
      nombre: 'POR_ROL',
      titulo: 'Usuarios por rol',
      columnas: [
        columna('rol', 'Rol', 24),
        columna('usuarios', 'Usuarios', 12, 'entero'),
      ],
      filas: mapear(datos.por_rol, (item) => ({
        rol: item.rol,
        usuarios: item.usuarios,
      })),
    },
    {
      nombre: 'USUARIOS',
      titulo: 'Detalle de usuarios',
      columnas: [
        columna('id', 'ID', 8, 'entero'),
        columna('nombre', 'Nombre', 28),
        columna('email', 'Correo', 30),
        columna('roles', 'Roles', 22),
        columna('permisos', 'Permisos', 10, 'entero'),
        columna('activo', 'Activo', 8),
        columna('ultimo_acceso', 'Último acceso', 22, 'fecha'),
      ],
      filas: mapear(datos.usuarios, (item) => ({
        id: item.id,
        nombre: item.nombre,
        email: item.email,
        roles: item.roles,
        permisos: Array.isArray(item.permisos) ? item.permisos.length : item.permisos,
        activo: item.activo,
        ultimo_acceso: item.ultimo_acceso,
      })),
    },
  ];
}

// Definición única por tipo de reporte.
function construirDefinicion(tipo, datos, opciones = {}) {
  const normalizado = String(tipo || '').toLowerCase();
  let kpis = [];
  let hojas = [];

  switch (normalizado) {
    case 'ventas':
      kpis = kpisVentas(datos);
      hojas = hojasVentas(datos);
      break;
    case 'costos':
      kpis = kpisCostos(datos);
      hojas = hojasCostos(datos);
      break;
    case 'merma':
      kpis = [
        kpi('Costo total', aNumero(datos.total_costo), 'monto'),
        kpi('Registros', aNumero(datos.registros), 'entero'),
      ];
      hojas = hojasMerma(datos);
      break;
    case 'devoluciones':
      kpis = [
        kpi('Registros', aNumero(datos.registros), 'entero'),
        kpi('Monto reembolsado', aNumero(datos.monto_reembolsado), 'monto'),
      ];
      hojas = hojasDevoluciones(datos);
      break;
    case 'inventario':
      kpis = [
        kpi('Insumos activos', aNumero(datos.total_insumos), 'entero'),
        kpi('Valor total', aNumero(datos.valor_total), 'monto'),
        kpi('Bajo mínimo', aNumero(datos.bajo_minimo), 'entero'),
      ];
      hojas = hojasInventario(datos);
      break;
    case 'activos':
      kpis = [
        kpi('Activos', aNumero(datos.total_activos), 'entero'),
        kpi('Valor de adquisición', aNumero(datos.valor_adquisicion), 'monto'),
        kpi('En reparación', aNumero(datos.en_reparacion), 'entero'),
        kpi('Dados de baja', aNumero(datos.dados_de_baja), 'entero'),
        kpi('Costo mantenimientos', aNumero(datos.costo_mantenimientos), 'monto'),
      ];
      hojas = hojasActivos(datos);
      break;
    case 'personal':
      kpis = [kpi('Usuarios activos', aNumero(datos.total_usuarios), 'entero')];
      hojas = hojasPersonal(datos);
      break;
    default:
      kpis = [];
      hojas = [];
  }

  return {
    titulo: `Fratelli's · Reporte ${normalizado}`,
    tipo: datos.tipo || normalizado,
    desde: datos.desde,
    hasta: datos.hasta,
    generadoEn: opciones.generadoEn || new Date().toISOString(),
    kpis,
    hojas,
  };
}

async function exportarReporteExcel(tipo, datos, opciones = {}) {
  const definicion = construirDefinicion(tipo, datos, opciones);
  return exportarExcel({ ...definicion, maxFilas: MAX_FILAS_TABLA });
}

async function exportarReportePdf(tipo, datos, opciones = {}) {
  const definicion = construirDefinicion(tipo, datos, opciones);
  return exportarPdf({
    titulo: definicion.titulo,
    subtitulo: `Periodo: ${definicion.desde || 'sin límite'} a ${definicion.hasta || 'sin límite'}`,
    generadoEn: definicion.generadoEn,
    kpis: definicion.kpis,
    secciones: definicion.hojas.map((hoja) => ({
      titulo: hoja.titulo,
      columnas: hoja.columnas,
      filas: hoja.filas,
    })),
    maxFilas: MAX_FILAS_TABLA,
    pie: `Fratelli's · Reporte ${definicion.tipo}`,
  });
}

module.exports = {
  MAX_FILAS_TABLA,
  construirDefinicion,
  exportarReporteExcel,
  exportarReportePdf,
};
