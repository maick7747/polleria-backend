'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const { responderConEtag } = require('../../middleware/etag');
const { requiredEnum } = require('../../middleware/validate');
const service = require('./reportes.service');
const exportador = require('./reportes.export');

const router = express.Router();
const permiso = requirePermiso('reportes.ver');

const FORMATOS = ['xlsx', 'pdf'];
const TIPOS_CONTENIDO = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

function nombreArchivo(tipo, fecha, formato) {
  const limpio = String(tipo || 'reporte').replace(/[^a-z0-9_-]/gi, '') || 'reporte';
  return `reporte-${limpio}-${fecha}.${formato}`;
}

// GET /api/reportes/:tipo/export?formato=xlsx|pdf&desde&hasta
router.get('/:tipo/export', permiso, async (req, res, next) => {
  try {
    const crudo = req.query.formato === undefined ? undefined : String(req.query.formato).toLowerCase();
    const formato = requiredEnum(crudo, 'formato', FORMATOS);

    const datos = await service.obtenerReporte(req.params.tipo, req.query);
    const tipo = String(datos.tipo || req.params.tipo).toLowerCase();
    const generadoEn = new Date().toISOString();

    const cuerpo = formato === 'xlsx'
      ? await exportador.exportarReporteExcel(tipo, datos, { generadoEn })
      : await exportador.exportarReportePdf(tipo, datos, { generadoEn });

    res.setHeader('Content-Type', TIPOS_CONTENIDO[formato]);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nombreArchivo(tipo, generadoEn.slice(0, 10), formato)}"`,
    );
    res.setHeader('Content-Length', cuerpo.length);
    res.setHeader('Cache-Control', 'no-store');
    res.send(cuerpo);
  } catch (error) {
    next(error);
  }
});

router.get('/tipos', permiso, (req, res) => {
  res.json({ data: service.TIPOS, meta: { total: service.TIPOS.length } });
});

// GET /api/reportes/:tipo — respuesta con ETag (las exportaciones van aparte).
router.get('/:tipo', permiso, async (req, res, next) => {
  try {
    responderConEtag(req, res, await service.obtenerReporte(req.params.tipo, req.query));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
