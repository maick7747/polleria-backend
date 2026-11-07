'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./devoluciones.service');

const router = express.Router();
const permiso = requirePermiso('devoluciones.gestionar');

router.get('/', permiso, (req, res) => {
  res.json(service.listDevoluciones(req.query));
});

router.get('/:id', permiso, (req, res) => {
  res.json(service.getDevolucion(req.params.id));
});

router.post('/', permiso, (req, res) => {
  res.status(201).json(service.crearDevolucion(req.body, req.usuario));
});

router.post('/:id/resolver', permiso, (req, res) => {
  res.json(service.resolverDevolucion(req.params.id, req.body, req.usuario));
});

router.post('/:id/reembolso', permiso, (req, res) => {
  res.json(service.registrarReembolso(req.params.id, req.body, req.usuario));
});

module.exports = router;
