'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const { optionalDate } = require('../../middleware/validate');
const { responderConEtag } = require('../../middleware/etag');
const service = require('./dashboard.service');

const router = express.Router();

router.get('/', requirePermiso('reportes.ver'), async (req, res, next) => {
  try {
    const fecha = optionalDate(req.query.fecha, 'fecha');
    responderConEtag(req, res, await service.getDashboard({ fecha }));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
