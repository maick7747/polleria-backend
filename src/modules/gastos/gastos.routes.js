'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./gastos.service');

const router = express.Router();
const permiso = requirePermiso('gastos.registrar');

router.get('/resumen', permiso, (req, res) => {
  res.json(service.resumenGastos(req.query));
});

router.get('/', permiso, (req, res) => {
  res.json(service.listGastos(req.query));
});

router.get('/:id', permiso, (req, res) => {
  res.json(service.getGasto(req.params.id));
});

router.post('/', permiso, (req, res) => {
  res.status(201).json(service.crearGasto(req.body, req.usuario));
});

router.patch('/:id', permiso, (req, res) => {
  res.json(service.actualizarGasto(req.params.id, req.body));
});

module.exports = router;
