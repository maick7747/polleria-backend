'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./cerrar-cuenta.service');

const router = express.Router();

router.get('/cuentas/:id', requirePermiso('venta.registrar', 'caja.cobrar'), async (req, res) => {
  res.json(await service.cuentaDetalle(req.params.id));
});

router.get('/cuentas/:id/pagos', requirePermiso('venta.registrar', 'caja.cobrar'), async (req, res) => {
  res.json(await service.listPagos(req.params.id));
});

router.post('/cuentas/:id/cobrar', requirePermiso('caja.cobrar'), async (req, res) => {
  res.json(await service.cobrarCuenta(req.params.id, req.body, req.usuario));
});

router.get('/cuentas/:id/comprobante', requirePermiso('venta.registrar', 'caja.cobrar'), async (req, res) => {
  res.json(await service.comprobanteCuenta(req.params.id));
});

router.post('/cuentas/:id/comprobante/enviar', requirePermiso('caja.cobrar'), async (req, res) => {
  res.json(await service.enviarComprobante(req.params.id));
});

router.post('/cuentas/:id/cancelar', requirePermiso('caja.cobrar'), async (req, res) => {
  res.json(await service.cancelarCuenta(req.params.id, req.body, req.usuario));
});

const aliasRouter = express.Router();

aliasRouter.get('/:id', requirePermiso('venta.registrar', 'caja.cobrar'), async (req, res) => {
  res.json(await service.cuentaDetalle(req.params.id));
});

aliasRouter.get('/:id/pagos', requirePermiso('venta.registrar', 'caja.cobrar'), async (req, res) => {
  res.json(await service.listPagos(req.params.id));
});

aliasRouter.post('/:id/cobrar', requirePermiso('caja.cobrar'), async (req, res) => {
  res.json(await service.cobrarCuenta(req.params.id, req.body, req.usuario));
});

aliasRouter.get('/:id/comprobante', requirePermiso('venta.registrar', 'caja.cobrar'), async (req, res) => {
  res.json(await service.comprobanteCuenta(req.params.id));
});

aliasRouter.post('/:id/comprobante/enviar', requirePermiso('caja.cobrar'), async (req, res) => {
  res.json(await service.enviarComprobante(req.params.id));
});

aliasRouter.post('/:id/cancelar', requirePermiso('caja.cobrar'), async (req, res) => {
  res.json(await service.cancelarCuenta(req.params.id, req.body, req.usuario));
});

module.exports = router;
module.exports.aliasRouter = aliasRouter;
