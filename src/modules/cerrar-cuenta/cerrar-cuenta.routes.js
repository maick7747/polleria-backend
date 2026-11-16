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

// Boleta/ticket térmico de 80 mm. `inline` permite abrirlo en una pestaña
// nueva; el frontend también puede descargarlo como blob.
async function responderBoleta(req, res) {
  const { pdf, numero, tipo } = await service.boletaPdf(req.params.id);
  const seguro = String(numero || req.params.id).replace(/[^A-Za-z0-9-]/g, '');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${tipo || 'comprobante'}-${seguro}.pdf"`,
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', pdf.length);
  res.send(pdf);
}

router.get(
  '/cuentas/:id/comprobante/pdf',
  requirePermiso('venta.registrar', 'caja.cobrar'),
  responderBoleta,
);

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

aliasRouter.get(
  '/:id/comprobante/pdf',
  requirePermiso('venta.registrar', 'caja.cobrar'),
  responderBoleta,
);

aliasRouter.post('/:id/comprobante/enviar', requirePermiso('caja.cobrar'), async (req, res) => {
  res.json(await service.enviarComprobante(req.params.id));
});

aliasRouter.post('/:id/cancelar', requirePermiso('caja.cobrar'), async (req, res) => {
  res.json(await service.cancelarCuenta(req.params.id, req.body, req.usuario));
});

module.exports = router;
module.exports.aliasRouter = aliasRouter;
