'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./cuadre-caja.service');
const exportador = require('./cuadre-caja.export');
const reportesService = require('../reportes/reportes.service');
const configuracionService = require('../configuracion/configuracion.service');

const router = express.Router();
const permiso = requirePermiso('caja.cuadrar');

const TIPO_PDF = 'application/pdf';

// El resumen por método es opcional: si el reporte falla, el cuadre se emite
// igual (los importes principales vienen del propio cuadre).
async function metodosDelDia(fecha) {
  try {
    const dia = String(fecha).slice(0, 10);
    const reporte = await reportesService.obtenerReporte('ventas', { desde: dia, hasta: dia });
    return reporte.por_metodo || [];
  } catch (error) {
    return [];
  }
}

async function configuracionNegocio() {
  try {
    const configuracion = await configuracionService.getConfiguracion();
    return configuracion.raw || {};
  } catch (error) {
    return {};
  }
}

router.get('/', permiso, async (req, res) => {
  res.json(await service.obtenerCuadre(req.query.fecha));
});

router.post('/apertura', permiso, async (req, res) => {
  res.status(201).json(await service.apertura(req.body, req.usuario));
});

// Declarado antes de /:id para que "historial" no se interprete como id.
router.get('/historial', permiso, async (req, res, next) => {
  try {
    res.json(await service.historialCuadres(req.query));
  } catch (error) {
    next(error);
  }
});

router.get('/:id', permiso, async (req, res) => {
  res.json(await service.getCuadrePorId(req.params.id));
});

router.post('/:id/cierre', permiso, async (req, res) => {
  res.json(await service.cierre(req.params.id, req.body, req.usuario));
});

// POST /api/cuadre-caja/:id/reabrir — reabre el cuadre del día (o el de ayer).
router.post('/:id/reabrir', permiso, async (req, res, next) => {
  try {
    res.json(await service.reabrir(req.params.id, req.body, req.usuario));
  } catch (error) {
    next(error);
  }
});

router.get('/:id/resumen', permiso, async (req, res) => {
  res.json(await service.resumenCuadre(req.params.id));
});

// GET /api/cuadre-caja/:id/pdf
router.get('/:id/pdf', permiso, async (req, res, next) => {
  try {
    const cuadre = await service.getCuadrePorId(req.params.id);
    const [metodos, configuracion] = await Promise.all([
      metodosDelDia(cuadre.fecha),
      configuracionNegocio(),
    ]);
    const generadoEn = new Date().toISOString();
    const cuerpo = await exportador.exportarPdfCuadre(cuadre, {
      metodos,
      configuracion,
      generadoEn,
    });

    res.setHeader('Content-Type', TIPO_PDF);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="cuadre-caja-${String(cuadre.fecha).slice(0, 10)}-${cuadre.id}.pdf"`,
    );
    res.setHeader('Content-Length', cuerpo.length);
    res.setHeader('Cache-Control', 'no-store');
    res.send(cuerpo);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
