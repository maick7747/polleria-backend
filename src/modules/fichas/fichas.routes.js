'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./fichas.service');

const router = express.Router();
const permiso = requirePermiso('menu.gestionar');

router.get('/categorias-platillo', permiso, (req, res) => {
  res.json(service.listCategorias());
});

router.get('/platillos', permiso, async (req, res) => {
  res.json(await service.listPlatillos(req.query));
});

router.get('/platillos/:id', permiso, (req, res) => {
  res.json(service.fichaConDetalle(req.params.id));
});

router.post('/platillos', permiso, (req, res) => {
  res.status(201).json(service.crearPlatillo(req.body));
});

router.patch('/platillos/:id', permiso, (req, res) => {
  res.json(service.actualizarPlatillo(req.params.id, req.body));
});

router.patch('/platillos/:id/activo', permiso, (req, res) => {
  res.json(service.cambiarActivo(req.params.id, req.body));
});

router.get('/platillos/:id/ficha', permiso, (req, res) => {
  res.json(service.fichaConDetalle(req.params.id));
});

router.put('/platillos/:id/ficha', permiso, (req, res) => {
  res.json(service.guardarFicha(req.params.id, req.body));
});

router.get('/ingredientes', permiso, (req, res) => {
  res.json(service.listIngredientes(req.query));
});

const fichasRouter = express.Router();

fichasRouter.get('/', permiso, (req, res) => {
  res.json(service.listFichas(req.query));
});

module.exports = router;
module.exports.fichasRouter = fichasRouter;
