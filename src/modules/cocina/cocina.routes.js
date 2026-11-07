'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./cocina.service');

const router = express.Router();
const permisoKds = requirePermiso('cocina.kds');

router.get('/pedidos', permisoKds, async (req, res) => {
  res.json(await service.listKds(req.query));
});

router.get('/comandas', permisoKds, async (req, res) => {
  res.json(await service.listKds(req.query));
});

router.get('/pedidos-listos', permisoKds, async (req, res) => {
  res.json(await service.pedidosListos());
});

router.patch('/pedidos/:pedidoId/platos/:detalleId/estado', permisoKds, async (req, res) => {
  res.json(await service.actualizarEstadoPlato(req.params.pedidoId, req.params.detalleId, req.body));
});

router.get('/pedidos/:id/ingredientes', permisoKds, async (req, res) => {
  res.json(await service.ingredientesPedido(req.params.id));
});

router.get('/metricas', permisoKds, async (req, res) => {
  res.json(await service.metricas(req.query));
});

const listosRouter = express.Router();

listosRouter.get('/pedidos-listos', requirePermiso('venta.registrar', 'cocina.kds'), async (req, res) => {
  res.json(await service.pedidosListos());
});

module.exports = router;
module.exports.listosRouter = listosRouter;
