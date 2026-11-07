'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./configuracion.service');

const router = express.Router();
const permiso = requirePermiso('config.gestionar');

router.get('/usuarios', permiso, (req, res) => {
  res.json(service.listUsuarios(req.query));
});

router.post('/usuarios', permiso, (req, res) => {
  res.status(201).json(service.crearUsuario(req.body));
});

router.patch('/usuarios/:id', permiso, (req, res) => {
  res.json(service.actualizarUsuario(req.params.id, req.body));
});

router.put('/usuarios/:id/roles', permiso, (req, res) => {
  res.json(service.actualizarRoles(req.params.id, req.body));
});

router.get('/roles', permiso, (req, res) => {
  res.json(service.listRoles());
});

router.get('/permisos', permiso, (req, res) => {
  res.json(service.listPermisos());
});

router.get('/configuracion', permiso, (req, res) => {
  res.json(service.getConfiguracion());
});

router.put('/configuracion', permiso, (req, res) => {
  res.json(service.updateConfiguracion(req.body));
});

module.exports = router;
