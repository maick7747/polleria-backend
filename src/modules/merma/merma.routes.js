'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./merma.service');

const router = express.Router();
const permiso = requirePermiso('merma.gestionar');

router.get('/tipos-merma', permiso, (req, res) => {
  res.json(service.listTipos());
});

router.get('/mermas', permiso, (req, res) => {
  res.json(service.listMermas(req.query));
});

router.get('/mermas/:id', permiso, (req, res) => {
  res.json(service.getMerma(req.params.id));
});

router.post('/mermas', permiso, (req, res) => {
  res.status(201).json(service.crearMerma(req.body, req.usuario));
});

router.post('/mermas/:id/aprobar', permiso, (req, res) => {
  res.json(service.aprobarMerma(req.params.id, req.body, req.usuario));
});

router.post('/mermas/:id/rechazar', permiso, (req, res) => {
  res.json(service.rechazarMerma(req.params.id, req.body, req.usuario));
});

module.exports = router;
