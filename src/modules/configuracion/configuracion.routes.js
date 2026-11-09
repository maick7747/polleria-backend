'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./configuracion.service');

const router = express.Router();
const permiso = requirePermiso('config.gestionar');

function manejar(accion) {
  return async (req, res, next) => {
    try {
      await accion(req, res);
    } catch (error) {
      next(error);
    }
  };
}

router.get('/usuarios', permiso, manejar(async (req, res) => {
  res.json(await service.listUsuarios(req.query));
}));

router.post('/usuarios', permiso, manejar(async (req, res) => {
  res.status(201).json(await service.crearUsuario(req.body));
}));

router.patch('/usuarios/:id', permiso, manejar(async (req, res) => {
  res.json(await service.actualizarUsuario(req.params.id, req.body));
}));

router.put('/usuarios/:id/roles', permiso, manejar(async (req, res) => {
  res.json(await service.actualizarRoles(req.params.id, req.body));
}));

router.get('/roles', permiso, manejar(async (req, res) => {
  res.json(await service.listRoles());
}));

router.get('/permisos', permiso, manejar(async (req, res) => {
  res.json(await service.listPermisos());
}));

router.get('/configuracion', permiso, manejar(async (req, res) => {
  res.json(await service.getConfiguracion());
}));

router.put('/configuracion', permiso, manejar(async (req, res) => {
  res.json(await service.updateConfiguracion(req.body));
}));

module.exports = router;
