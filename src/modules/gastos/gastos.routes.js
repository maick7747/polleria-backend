'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./gastos.service');

const router = express.Router();
const permiso = requirePermiso('gastos.registrar');

function manejar(accion) {
  return async (req, res, next) => {
    try {
      await accion(req, res);
    } catch (error) {
      next(error);
    }
  };
}

router.get('/resumen', permiso, manejar(async (req, res) => {
  res.json(await service.resumenGastos(req.query));
}));

router.get('/', permiso, manejar(async (req, res) => {
  res.json(await service.listGastos(req.query));
}));

router.get('/:id', permiso, manejar(async (req, res) => {
  res.json(await service.getGasto(req.params.id));
}));

router.post('/', permiso, manejar(async (req, res) => {
  res.status(201).json(await service.crearGasto(req.body, req.usuario));
}));

router.patch('/:id', permiso, manejar(async (req, res) => {
  res.json(await service.actualizarGasto(req.params.id, req.body));
}));

module.exports = router;
