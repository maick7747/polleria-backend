'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./activos.service');

const router = express.Router();
const permiso = requirePermiso('activos.gestionar');

router.get('/alertas', permiso, (req, res) => {
  res.json(service.alertasActivos(req.query));
});

router.get('/', permiso, (req, res) => {
  res.json(service.listActivos(req.query));
});

router.post('/', permiso, (req, res) => {
  res.status(201).json(service.crearActivo(req.body, req.usuario));
});

router.get('/:id', permiso, (req, res) => {
  res.json(service.getActivo(req.params.id));
});

router.patch('/:id', permiso, (req, res) => {
  res.json(service.actualizarActivo(req.params.id, req.body));
});

router.get('/:id/mantenimientos', permiso, (req, res) => {
  res.json(service.listMantenimientos(req.params.id));
});

router.post('/:id/mantenimientos', permiso, (req, res) => {
  res.status(201).json(service.crearMantenimiento(req.params.id, req.body, req.usuario));
});

const mantenimientosRouter = express.Router();

mantenimientosRouter.post('/:id/autorizar', permiso, (req, res) => {
  res.json(service.autorizarMantenimiento(req.params.id, req.body));
});

module.exports = router;
module.exports.mantenimientosRouter = mantenimientosRouter;
