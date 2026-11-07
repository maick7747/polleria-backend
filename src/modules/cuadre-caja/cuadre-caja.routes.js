'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./cuadre-caja.service');

const router = express.Router();
const permiso = requirePermiso('caja.cuadrar');

router.get('/', permiso, async (req, res) => {
  res.json(await service.obtenerCuadre(req.query.fecha));
});

router.post('/apertura', permiso, async (req, res) => {
  res.status(201).json(await service.apertura(req.body, req.usuario));
});

router.get('/:id', permiso, async (req, res) => {
  res.json(await service.getCuadrePorId(req.params.id));
});

router.post('/:id/cierre', permiso, async (req, res) => {
  res.json(await service.cierre(req.params.id, req.body, req.usuario));
});

router.get('/:id/resumen', permiso, async (req, res) => {
  res.json(await service.resumenCuadre(req.params.id));
});

router.get('/:id/pdf', permiso, (req, res) => {
  res.status(501).json({
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'La exportación PDF del cuadre está pendiente de definición.',
      details: [],
      requestId: req.id || null,
    },
  });
});

module.exports = router;
