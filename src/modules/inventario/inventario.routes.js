'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const { responderConEtag } = require('../../middleware/etag');
const service = require('./inventario.service');

const router = express.Router();
const permiso = requirePermiso('inventario.gestionar');

function manejar(accion) {
  return async (req, res, next) => {
    try {
      await accion(req, res);
    } catch (error) {
      next(error);
    }
  };
}

router.get('/', permiso, manejar(async (req, res) => {
  res.json(await service.listInventario(req.query));
}));

router.get('/alertas', permiso, manejar(async (req, res) => {
  res.json(await service.listAlertas());
}));

// Debe declararse antes de cualquier ruta /:id para no colisionar.
// GET /api/inventario/movimientos?tipo=&insumo_id=&desde=&hasta=&sort=&page=&limit=&after=<id>
// `after` (entero >= 1) devuelve solo movimientos con id mayor al cursor.
// Incluye meta.next_cursor y meta.has_more. Respuesta con ETag.
router.get('/movimientos', permiso, manejar(async (req, res) => {
  responderConEtag(req, res, await service.listMovimientos(req.query));
}));

router.post('/verificar', permiso, manejar(async (req, res) => {
  res.json(await service.verificarStock(req.body));
}));

router.post('/ajustes', permiso, manejar(async (req, res) => {
  res.status(201).json(await service.aplicarAjustes(req.body, req.usuario));
}));

router.get('/:insumoId/movimientos', permiso, manejar(async (req, res) => {
  res.json(await service.historialMovimientos(req.params.insumoId, req.query));
}));

router.patch('/:insumoId/minimo', permiso, manejar(async (req, res) => {
  res.json(await service.actualizarMinimo(req.params.insumoId, req.body));
}));

module.exports = router;
