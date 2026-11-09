'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./devoluciones.service');

const router = express.Router();
const permiso = requirePermiso('devoluciones.gestionar');

function manejar(accion) {
  return async (req, res, next) => {
    try {
      await accion(req, res);
    } catch (error) {
      next(error);
    }
  };
}

// GET /api/devoluciones?estado=&desde=&hasta=&q=&sort=&page=&limit=&after=<id>
// `after` (entero >= 1) devuelve solo devoluciones con id mayor al cursor.
// Incluye meta.next_cursor y meta.has_more.
router.get('/', permiso, manejar(async (req, res) => {
  res.json(await service.listDevoluciones(req.query));
}));

router.get('/:id', permiso, manejar(async (req, res) => {
  res.json(await service.getDevolucion(req.params.id));
}));

router.post('/', permiso, manejar(async (req, res) => {
  res.status(201).json(await service.crearDevolucion(req.body, req.usuario));
}));

router.post('/:id/resolver', permiso, manejar(async (req, res) => {
  res.json(await service.resolverDevolucion(req.params.id, req.body, req.usuario));
}));

router.post('/:id/reembolso', permiso, manejar(async (req, res) => {
  res.json(await service.registrarReembolso(req.params.id, req.body, req.usuario));
}));

module.exports = router;
