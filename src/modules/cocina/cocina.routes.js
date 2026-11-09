'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const { responderConEtag, estabilizarGenerado } = require('../../middleware/etag');
const service = require('./cocina.service');

const router = express.Router();
const permisoKds = requirePermiso('cocina.kds');

// GET /api/kds/pedidos (y /api/cocina/pedidos) — respuesta con ETag.
router.get('/pedidos', permisoKds, async (req, res) => {
  const payload = await service.listKds(req.query);
  payload.meta = estabilizarGenerado(
    `kds:${JSON.stringify(req.query)}`,
    payload.meta,
  );
  responderConEtag(req, res, payload);
});

router.get('/comandas', permisoKds, async (req, res) => {
  responderConEtag(req, res, await service.listKds(req.query));
});

router.get('/pedidos-listos', permisoKds, async (req, res) => {
  res.json(await service.pedidosListos(req.query));
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
  responderConEtag(req, res, await service.pedidosListos(req.query));
});

module.exports = router;
module.exports.listosRouter = listosRouter;
