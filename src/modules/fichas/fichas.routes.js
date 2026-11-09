'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./fichas.service');

const router = express.Router();
const permiso = requirePermiso('menu.gestionar');

function manejar(accion) {
  return async (req, res, next) => {
    try {
      await accion(req, res);
    } catch (error) {
      next(error);
    }
  };
}

router.get('/categorias-platillo', permiso, manejar(async (req, res) => {
  res.json(await service.listCategorias());
}));

router.get('/platillos', permiso, manejar(async (req, res) => {
  res.json(await service.listPlatillos(req.query));
}));

router.get('/platillos/:id', permiso, manejar(async (req, res) => {
  res.json(await service.obtenerPlatillo(req.params.id));
}));

router.post('/platillos', permiso, manejar(async (req, res) => {
  res.status(201).json(await service.crearPlatillo(req.body));
}));

router.patch('/platillos/:id', permiso, manejar(async (req, res) => {
  res.json(await service.actualizarPlatillo(req.params.id, req.body));
}));

router.patch('/platillos/:id/activo', permiso, manejar(async (req, res) => {
  res.json(await service.cambiarActivo(req.params.id, req.body));
}));

router.get('/platillos/:id/ficha', permiso, manejar(async (req, res) => {
  res.json(await service.obtenerPlatillo(req.params.id));
}));

router.put('/platillos/:id/ficha', permiso, manejar(async (req, res) => {
  res.json(await service.guardarFicha(req.params.id, req.body));
}));

router.get('/ingredientes', permiso, manejar(async (req, res) => {
  res.json(await service.listIngredientes(req.query));
}));

const fichasRouter = express.Router();

fichasRouter.get('/', permiso, manejar(async (req, res) => {
  res.json(await service.listFichas(req.query));
}));

module.exports = router;
module.exports.fichasRouter = fichasRouter;
