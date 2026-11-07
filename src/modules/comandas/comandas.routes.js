'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./comandas.service');

const router = express.Router();

router.get('/', requirePermiso('cocina.kds'), async (req, res) => {
  res.json(await service.listComandas(req.query));
});

module.exports = router;
