'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./delivery-externo.service');

const router = express.Router();
const permiso = requirePermiso('delivery.externo');

function manejar(accion) {
  return async (req, res, next) => {
    try {
      await accion(req, res);
    } catch (error) {
      next(error);
    }
  };
}

router.get('/pedidos', permiso, manejar(async (req, res) => {
  res.json(await service.listPedidos(req.query));
}));

router.post('/pedidos', permiso, manejar(async (req, res) => {
  res.status(201).json(await service.crearPedido(req.body, req.usuario));
}));

router.post('/pedidos/:id/aceptar', permiso, manejar(async (req, res) => {
  res.json(await service.aceptarPedido(req.params.id, req.usuario));
}));

router.post('/pedidos/:id/cancelar', permiso, manejar(async (req, res) => {
  res.json(await service.cancelarPedido(req.params.id, req.body, req.usuario));
}));

router.get('/liquidaciones', permiso, manejar(async (req, res) => {
  res.json(await service.listLiquidaciones(req.query));
}));

router.post('/liquidaciones', permiso, manejar(async (req, res) => {
  res.status(201).json(await service.crearLiquidacion(req.body, req.usuario));
}));

module.exports = router;
