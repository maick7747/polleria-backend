'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./compras.service');

const router = express.Router();
const permiso = requirePermiso('compras.gestionar');

router.get('/sugerencia', permiso, (req, res) => {
  res.json(service.sugerenciaCompra());
});

router.get('/', permiso, (req, res) => {
  res.json(service.listCompras(req.query));
});

router.post('/', permiso, (req, res) => {
  res.status(201).json(service.crearCompra(req.body, req.usuario));
});

router.get('/:id', permiso, (req, res) => {
  res.json(service.getCompra(req.params.id));
});

router.patch('/:id', permiso, (req, res) => {
  res.json(service.actualizarCompra(req.params.id, req.body));
});

router.post('/:id/recibir', permiso, (req, res) => {
  res.json(service.recibirCompra(req.params.id, req.body, req.usuario));
});

router.post('/:id/cancelar', permiso, (req, res) => {
  res.json(service.cancelarCompra(req.params.id, req.body));
});

router.post('/:id/pagos', permiso, (req, res) => {
  res.status(201).json(service.registrarPago(req.params.id, req.body, req.usuario));
});

router.get('/:id/plantilla', permiso, (req, res) => {
  res.json(service.plantillaCompra(req.params.id, req.query));
});

const proveedoresRouter = express.Router();

proveedoresRouter.get('/', permiso, (req, res) => {
  res.json(service.listProveedores(req.query));
});

proveedoresRouter.post('/', permiso, (req, res) => {
  res.status(201).json(service.crearProveedor(req.body));
});

module.exports = router;
module.exports.proveedoresRouter = proveedoresRouter;
