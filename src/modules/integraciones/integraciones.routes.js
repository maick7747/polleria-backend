'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./integraciones.service');

const router = express.Router();

router.get(
  '/estado',
  requirePermiso('config.gestionar', 'reportes.ver'),
  async (req, res) => {
    res.json(service.estado());
  },
);

module.exports = router;
