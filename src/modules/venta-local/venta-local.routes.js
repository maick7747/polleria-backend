'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./venta-local.service');

const router = express.Router();
const permisoVenta = requirePermiso('venta.registrar');

router.get('/mesas', permisoVenta, async (req, res) => {
  res.json(await service.listMesas(req.query));
});

router.get('/mesas/:id', permisoVenta, async (req, res) => {
  res.json(await service.getMesa(req.params.id));
});

router.get('/cuentas', permisoVenta, async (req, res) => {
  res.json(await service.listCuentas(req.query));
});

router.post('/cuentas', permisoVenta, async (req, res) => {
  res.status(201).json(await service.createCuenta(req.body, req.usuario));
});

router.post('/cuentas/:id/pedidos', permisoVenta, async (req, res) => {
  res.status(201).json(await service.addRonda(req.params.id, req.body, req.usuario));
});

router.get('/pedidos', permisoVenta, async (req, res) => {
  res.json(await service.listPedidos(req.query));
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

router.get('/clientes', permisoVenta, async (req, res) => {
  res.json(await service.listClientes(req.query));
});

router.post('/clientes', permisoVenta, async (req, res) => {
  res.status(201).json(await service.createCliente(req.body));
});

router.post('/clientes/validar-documento', permisoVenta, async (req, res) => {
  res.json(await service.validarDocumento(req.body));
});

module.exports = router;
