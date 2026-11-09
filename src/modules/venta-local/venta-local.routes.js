'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const { responderConEtag, estabilizarGenerado } = require('../../middleware/etag');
const service = require('./venta-local.service');
const tablero = require('./tablero.service');

const router = express.Router();
const permisoVenta = requirePermiso('venta.registrar');
const permisoTablero = requirePermiso('venta.registrar', 'caja.cobrar', 'cocina.kds');

// GET /api/venta-local/tablero -> { generado_en, meta:{resumen}, mesas[], cuentas[] }
// Respuesta cacheable con ETag (304 si no cambió).
router.get('/tablero', permisoTablero, async (req, res) => {
  const payload = estabilizarGenerado('tablero', await tablero.obtenerTablero());
  responderConEtag(req, res, payload);
});

router.get('/mesas', permisoVenta, async (req, res) => {
  res.json(await service.listMesas(req.query));
});

router.get('/mesas/:id', permisoVenta, async (req, res) => {
  res.json(await service.getMesa(req.params.id));
});

// GET /api/cuentas?estado=&page=&limit=&after=<id>
// `after` (entero >= 1) devuelve solo cuentas con id mayor al cursor.
// Incluye meta.next_cursor y meta.has_more.
router.get('/cuentas', permisoVenta, async (req, res) => {
  responderConEtag(req, res, await service.listCuentas(req.query));
});

router.post('/cuentas', permisoVenta, async (req, res) => {
  res.status(201).json(await service.createCuenta(req.body, req.usuario));
});

router.post('/cuentas/:id/pedidos', permisoVenta, async (req, res) => {
  res.status(201).json(await service.addRonda(req.params.id, req.body, req.usuario));
});

router.patch('/cuentas/:id/cliente', permisoVenta, async (req, res) => {
  res.json(await service.attachCliente(req.params.id, req.body));
});

// GET /api/pedidos?estado=&canal=&desde=&hasta=&page=&limit=&after=<id>
// `after` (entero >= 1) devuelve solo pedidos con id mayor al cursor.
// Incluye meta.next_cursor y meta.has_more. Respuesta con ETag.
router.get('/pedidos', permisoVenta, async (req, res) => {
  responderConEtag(req, res, await service.listPedidos(req.query));
});

router.get('/pedidos/:id', permisoVenta, async (req, res) => {
  res.json(await service.getPedido(req.params.id));
});

router.post('/pedidos', permisoVenta, async (req, res) => {
  res.status(201).json(await service.createPedido(req.body, req.usuario));
});

router.patch('/pedidos/:id', permisoVenta, async (req, res) => {
  res.json(await service.updatePedido(req.params.id, req.body));
});

router.post('/pedidos/:id/enviar-cocina', permisoVenta, async (req, res) => {
  res.json(await service.enviarCocina(req.params.id, req.usuario));
});

router.post('/pedidos/:id/cancelar', permisoVenta, async (req, res) => {
  res.json(await service.cancelarPedido(req.params.id, req.body, req.usuario));
});

// GET /api/clientes?q=&documento=&page=&limit=&after=<id>
// `after` (entero >= 1) devuelve solo clientes con id mayor al cursor.
// Incluye meta.next_cursor y meta.has_more. Respuesta con ETag.
router.get('/clientes', permisoVenta, async (req, res) => {
  responderConEtag(req, res, await service.listClientes(req.query));
});

router.post('/clientes', permisoVenta, async (req, res) => {
  res.status(201).json(await service.createCliente(req.body));
});

router.post('/clientes/validar-documento', permisoVenta, async (req, res) => {
  res.json(await service.validarDocumento(req.body));
});

// Router dedicado para /api/clientes (paginado con meta). Se monta antes del
// router raíz en app.js para que el listado paginado tenga prioridad.
const clientesRouter = express.Router();

clientesRouter.get('/', permisoVenta, async (req, res, next) => {
  try {
    responderConEtag(req, res, await service.listClientes(req.query));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.clientesRouter = clientesRouter;
