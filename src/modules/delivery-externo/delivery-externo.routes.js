'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./delivery-externo.service');

const router = express.Router();
const permiso = requirePermiso('delivery.externo');

router.get('/pedidos', permiso, (req, res) => {
  res.json(service.listPedidos(req.query));
});

router.post('/pedidos', permiso, (req, res) => {
  res.status(201).json(service.crearPedido(req.body, req.usuario));
});

router.post('/pedidos/:id/aceptar', permiso, (req, res) => {
  res.json(service.aceptarPedido(req.params.id, req.usuario));
});

router.post('/pedidos/:id/cancelar', permiso, (req, res) => {
  res.json(service.cancelarPedido(req.params.id, req.body, req.usuario));
});

router.get('/liquidaciones', permiso, (req, res) => {
  res.json(service.listLiquidaciones(req.query));
});

router.post('/liquidaciones', permiso, (req, res) => {
  res.status(201).json(service.crearLiquidacion(req.body, req.usuario));
});

module.exports = router;
