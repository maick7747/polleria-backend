'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./inventario.service');

const router = express.Router();
const permiso = requirePermiso('inventario.gestionar');

router.get('/', permiso, async (req, res) => {
  res.json(await service.listInventario(req.query));
});

router.get('/alertas', permiso, async (req, res) => {
  res.json(await service.listAlertas());
});

router.post('/verificar', permiso, async (req, res) => {
  res.json(await service.verificarStock(req.body));
});

router.post('/ajustes', permiso, async (req, res) => {
  res.status(201).json(await service.aplicarAjustes(req.body, req.usuario));
});

router.get('/:insumoId/movimientos', permiso, async (req, res) => {
  res.json(await service.historialMovimientos(req.params.insumoId, req.query));
});

router.patch('/:insumoId/minimo', permiso, async (req, res) => {
  res.json(await service.actualizarMinimo(req.params.insumoId, req.body));
});

module.exports = router;
