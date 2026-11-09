'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./delivery-propio.service');

const router = express.Router();
const permiso = requirePermiso('delivery.propio');

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

router.patch('/pedidos/:id/repartidor', permiso, manejar(async (req, res) => {
  res.json(await service.asignarRepartidor(req.params.id, req.body));
}));

router.patch('/pedidos/:id/estado', permiso, manejar(async (req, res) => {
  res.json(await service.actualizarEstado(req.params.id, req.body));
}));

router.post('/pedidos/:id/entrega', permiso, manejar(async (req, res) => {
  res.json(await service.registrarEntrega(req.params.id, req.body, req.usuario));
}));

module.exports = router;
