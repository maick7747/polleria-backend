'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./fichas.service');

const router = express.Router();
// Escribir el menú/fichas es de administración del menú.
const permiso = requirePermiso('menu.gestionar');
// Leer el menú también lo necesitan quien toma pedidos (Mozo/Cajero) y cocina
// (KDS muestra los platos); sin esto la carta llega vacía al mozo.
const leerMenu = requirePermiso('menu.gestionar', 'venta.registrar', 'cocina.kds');
// Los insumos los consultan menú, inventario y cocina.
const leerIngredientes = requirePermiso(
  'menu.gestionar',
  'inventario.gestionar',
  'cocina.kds',
);

function manejar(accion) {
  return async (req, res, next) => {
    try {
      await accion(req, res);
    } catch (error) {
      next(error);
    }
  };
}

router.get('/categorias-platillo', leerMenu, manejar(async (req, res) => {
  res.json(await service.listCategorias());
}));

router.get('/platillos', leerMenu, manejar(async (req, res) => {
  res.json(await service.listPlatillos(req.query));
}));

router.get('/platillos/:id', leerMenu, manejar(async (req, res) => {
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

router.get('/platillos/:id/ficha', leerMenu, manejar(async (req, res) => {
  res.json(await service.obtenerPlatillo(req.params.id));
}));

router.put('/platillos/:id/ficha', permiso, manejar(async (req, res) => {
  res.json(await service.guardarFicha(req.params.id, req.body));
}));

router.get('/ingredientes', leerIngredientes, manejar(async (req, res) => {
  res.json(await service.listIngredientes(req.query));
}));

const fichasRouter = express.Router();

fichasRouter.get('/', permiso, manejar(async (req, res) => {
  res.json(await service.listFichas(req.query));
}));

module.exports = router;
module.exports.fichasRouter = fichasRouter;
