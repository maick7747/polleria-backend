'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./activos.service');

const router = express.Router();
const permiso = requirePermiso('activos.gestionar');

function manejar(accion) {
  return async (req, res, next) => {
    try {
      await accion(req, res);
    } catch (error) {
      next(error);
    }
  };
}

router.get('/alertas', permiso, manejar(async (req, res) => {
  res.json(await service.alertasActivos(req.query));
}));

// GET /api/activos?categoria=&estado=&q=&sort=&page=&limit=&after=<id>
// `after` (entero >= 1) devuelve solo activos con id mayor al cursor.
// Incluye meta.next_cursor y meta.has_more.
router.get('/', permiso, manejar(async (req, res) => {
  res.json(await service.listActivos(req.query));
}));

router.post('/', permiso, manejar(async (req, res) => {
  res.status(201).json(await service.crearActivo(req.body, req.usuario));
}));

router.get('/:id', permiso, manejar(async (req, res) => {
  res.json(await service.getActivo(req.params.id));
}));

router.patch('/:id', permiso, manejar(async (req, res) => {
  res.json(await service.actualizarActivo(req.params.id, req.body));
}));

router.get('/:id/mantenimientos', permiso, manejar(async (req, res) => {
  res.json(await service.listMantenimientos(req.params.id));
}));

router.post('/:id/mantenimientos', permiso, manejar(async (req, res) => {
  res.status(201).json(await service.crearMantenimiento(req.params.id, req.body, req.usuario));
}));

const mantenimientosRouter = express.Router();

mantenimientosRouter.post('/:id/autorizar', permiso, manejar(async (req, res) => {
  res.json(await service.autorizarMantenimiento(req.params.id, req.body));
}));

module.exports = router;
module.exports.mantenimientosRouter = mantenimientosRouter;
