'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const { responderConEtag, estabilizarGenerado } = require('../../middleware/etag');
const service = require('./cocina.service');

const router = express.Router();
const permisoKds = requirePermiso('cocina.kds');
const permisoEntrega = requirePermiso('venta.registrar');

function manejar(accion) {
  return async (req, res, next) => {
    try {
      await accion(req, res);
    } catch (error) {
      next(error);
    }
  };
}

// GET /api/kds/pedidos (y /api/cocina/pedidos) — respuesta con ETag.
router.get('/pedidos', permisoKds, manejar(async (req, res) => {
  const payload = await service.listKds(req.query);
  payload.meta = estabilizarGenerado(
    `kds:${JSON.stringify(req.query)}`,
    payload.meta,
  );
  responderConEtag(req, res, payload);
}));

router.get('/comandas', permisoKds, manejar(async (req, res) => {
  responderConEtag(req, res, await service.listKds(req.query));
}));

router.get('/pedidos-listos', permisoKds, manejar(async (req, res) => {
  res.json(await service.pedidosListos(req.query));
}));

router.patch(
  '/pedidos/:pedidoId/platos/:detalleId/estado',
  permisoKds,
  manejar(async (req, res) => {
    res.json(await service.actualizarEstadoPlato(
      req.params.pedidoId,
      req.params.detalleId,
      req.body,
    ));
  }),
);

// KDS v2 — entrega por línea. Solo el mozo/cajero/dueño confirma la entrega;
// cocina termina en "listo" y el aviso pasa por /pedidos-listos.
router.patch(
  '/pedidos/:pedidoId/platos/:detalleId/entregar',
  permisoEntrega,
  manejar(async (req, res) => {
    res.json(await service.entregarPlato(
      req.params.pedidoId,
      req.params.detalleId,
      req.usuario,
    ));
  }),
);

// KDS v2 — entregar la ronda completa (todas las líneas deben estar listas).
router.patch('/pedidos/:id/entregar', permisoEntrega, manejar(async (req, res) => {
  res.json(await service.entregarRonda(req.params.id, req.usuario));
}));

// KDS v2 — atajo "todo listo".
router.patch('/pedidos/:id/listo', permisoKds, manejar(async (req, res) => {
  res.json(await service.marcarTodoListo(req.params.id));
}));

router.get('/pedidos/:id/ingredientes', permisoKds, manejar(async (req, res) => {
  res.json(await service.ingredientesPedido(req.params.id));
}));

router.get('/metricas', permisoKds, manejar(async (req, res) => {
  res.json(await service.metricas(req.query));
}));

const listosRouter = express.Router();

listosRouter.get(
  '/pedidos-listos',
  requirePermiso('venta.registrar', 'cocina.kds'),
  manejar(async (req, res) => {
    responderConEtag(req, res, await service.pedidosListos(req.query));
  }),
);

module.exports = router;
module.exports.listosRouter = listosRouter;
