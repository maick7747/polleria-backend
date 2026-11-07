'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const { optionalDate } = require('../../middleware/validate');
const service = require('./dashboard.service');

const router = express.Router();

router.get('/', requirePermiso('reportes.ver'), (req, res) => {
  const fecha = optionalDate(req.query.fecha, 'fecha');
  res.json(service.getDashboard({ fecha }));
});

module.exports = router;
