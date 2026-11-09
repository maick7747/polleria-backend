'use strict';

const express = require('express');
const { requirePermiso } = require('../../middleware/roles');
const { responderConEtag } = require('../../middleware/etag');
const service = require('./reportes.service');

const router = express.Router();
const permiso = requirePermiso('reportes.ver');

router.get('/:tipo/export', permiso, (req, res) => {
  res.status(501).json({
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'La exportación PDF/XLSX está pendiente de definición.',
      details: [],
      requestId: req.id || null,
    },
  });
});

router.get('/tipos', permiso, (req, res) => {
  res.json({ data: service.TIPOS, meta: { total: service.TIPOS.length } });
});

// GET /api/reportes/:tipo — respuesta con ETag (las exportaciones van aparte).
router.get('/:tipo', permiso, async (req, res, next) => {
  try {
    responderConEtag(req, res, await service.obtenerReporte(req.params.tipo, req.query));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
