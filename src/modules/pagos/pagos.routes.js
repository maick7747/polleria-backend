'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const service = require('./pagos.service');

const router = express.Router();
const permiso = requirePermiso('caja.cuadrar');

// GET /api/pagos?fecha=YYYY-MM-DD (default: hoy en Lima)
// Cobros del día para la pantalla de caja/comandas, con totales por método.
router.get('/', permiso, async (req, res, next) => {
  try {
    res.json(await service.listPagos(req.query));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
