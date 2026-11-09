'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./merma.service');

const router = express.Router();
const permiso = requirePermiso('merma.gestionar');

function manejar(accion) {
  return async (req, res, next) => {
    try {
      await accion(req, res);
    } catch (error) {
      next(error);
    }
  };
}

router.get('/tipos-merma', permiso, manejar(async (req, res) => {
  res.json(await service.listTipos());
}));

// GET /api/merma/mermas?estado=&tipo_merma_id=&desde=&hasta=&sort=&page=&limit=&after=<id>
// `after` (entero >= 1) devuelve solo mermas con id mayor al cursor.
// Incluye meta.next_cursor y meta.has_more.
router.get('/mermas', permiso, manejar(async (req, res) => {
  res.json(await service.listMermas(req.query));
}));

router.get('/mermas/:id', permiso, manejar(async (req, res) => {
  res.json(await service.getMerma(req.params.id));
}));

router.post('/mermas', permiso, manejar(async (req, res) => {
  res.status(201).json(await service.crearMerma(req.body, req.usuario));
}));

router.post('/mermas/:id/aprobar', permiso, manejar(async (req, res) => {
  res.json(await service.aprobarMerma(req.params.id, req.body, req.usuario));
}));

router.post('/mermas/:id/rechazar', permiso, manejar(async (req, res) => {
  res.json(await service.rechazarMerma(req.params.id, req.body, req.usuario));
}));

module.exports = router;
