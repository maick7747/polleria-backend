'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./compras.service');

const router = express.Router();
const permiso = requirePermiso('compras.gestionar');

function manejar(accion) {
  return async (req, res, next) => {
    try {
      await accion(req, res);
    } catch (error) {
      next(error);
    }
  };
}

router.get('/sugerencia', permiso, manejar(async (req, res) => {
  res.json(await service.sugerenciaCompra());
}));

// Rutas de proveedores (alias de /api/proveedores). Van antes de /:id para que
// "proveedores" no se interprete como identificador.
router.get('/proveedores', permiso, manejar(async (req, res) => {
  res.json(await service.listProveedores(req.query));
}));

router.post('/proveedores', permiso, manejar(async (req, res) => {
  res.status(201).json(await service.crearProveedor(req.body));
}));

router.get('/', permiso, manejar(async (req, res) => {
  res.json(await service.listCompras(req.query));
}));

router.post('/', permiso, manejar(async (req, res) => {
  res.status(201).json(await service.crearCompra(req.body, req.usuario));
}));

router.get('/:id', permiso, manejar(async (req, res) => {
  res.json(await service.getCompra(req.params.id));
}));

router.patch('/:id', permiso, manejar(async (req, res) => {
  res.json(await service.actualizarCompra(req.params.id, req.body));
}));

router.post('/:id/recibir', permiso, manejar(async (req, res) => {
  res.json(await service.recibirCompra(req.params.id, req.body, req.usuario));
}));

router.post('/:id/cancelar', permiso, manejar(async (req, res) => {
  res.json(await service.cancelarCompra(req.params.id, req.body));
}));

router.post('/:id/pagos', permiso, manejar(async (req, res) => {
  res.status(201).json(await service.registrarPago(req.params.id, req.body, req.usuario));
}));

router.get('/:id/plantilla', permiso, manejar(async (req, res) => {
  res.json(await service.plantillaCompra(req.params.id, req.query));
}));

const proveedoresRouter = express.Router();

proveedoresRouter.get('/', permiso, manejar(async (req, res) => {
  res.json(await service.listProveedores(req.query));
}));

proveedoresRouter.post('/', permiso, manejar(async (req, res) => {
  res.status(201).json(await service.crearProveedor(req.body));
}));

module.exports = router;
module.exports.proveedoresRouter = proveedoresRouter;
