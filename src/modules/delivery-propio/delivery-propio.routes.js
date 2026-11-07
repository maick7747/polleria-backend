'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./delivery-propio.service');

const router = express.Router();
const permiso = requirePermiso('delivery.propio');

router.get('/pedidos', permiso, (req, res) => {
  res.json(service.listPedidos(req.query));
});

router.post('/pedidos', permiso, (req, res) => {
  res.status(201).json(service.crearPedido(req.body, req.usuario));
});

router.patch('/pedidos/:id/repartidor', permiso, (req, res) => {
  res.json(service.asignarRepartidor(req.params.id, req.body));
});

router.patch('/pedidos/:id/estado', permiso, (req, res) => {
  res.json(service.actualizarEstado(req.params.id, req.body));
});

router.post('/pedidos/:id/entrega', permiso, (req, res) => {
  res.json(service.registrarEntrega(req.params.id, req.body, req.usuario));
});

module.exports = router;
