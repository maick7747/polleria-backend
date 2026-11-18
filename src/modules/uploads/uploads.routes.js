'use strict';

// POST /api/uploads/imagen — multipart/form-data con:
//   file     imagen JPEG/PNG/WebP (máx. 2 MB)
//   carpeta  platillos | activos | insumos | proveedores
//
// El permiso se decide por la carpeta destino, así que un usuario que puede
// editar el menú no puede subir imágenes de activos ni de proveedores.

const express = require('express');
const multer = require('multer');
const { hasPermiso } = require('../../middleware/roles');
const { AppError } = require('../../middleware/error');
const service = require('./uploads.service');

const router = express.Router();

const PERMISO_POR_CARPETA = {
  platillos: 'menu.gestionar',
  activos: 'activos.gestionar',
  insumos: 'inventario.gestionar',
  proveedores: 'compras.gestionar',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: service.MAX_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    const mimetype = String(file.mimetype || '').toLowerCase();
    if (!service.MIMES.includes(mimetype)) {
      cb(new AppError(400, 'ARCHIVO_INVALIDO', 'La imagen debe ser JPEG, PNG o WebP.'));
      return;
    }
    cb(null, true);
  },
});

// Multer entrega sus errores como MulterError: se traducen a los códigos de
// la API antes de llegar al manejador global.
function recibirArchivo(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        next(new AppError(413, 'ARCHIVO_MUY_GRANDE', 'La imagen supera el límite de 2 MB.', [
          { field: 'file', max: service.MAX_BYTES },
        ]));
        return;
      }
      if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
        next(new AppError(400, 'ARCHIVO_INVALIDO', 'Adjunte una sola imagen en el campo "file".', [
          { field: 'file', detalle: error.code },
        ]));
        return;
      }
      next(new AppError(400, 'ARCHIVO_INVALIDO', `No se pudo leer el archivo (${error.code}).`));
      return;
    }
    next(error);
  });
}

router.post('/imagen', recibirArchivo, async (req, res, next) => {
  try {
    const carpeta = String((req.body && req.body.carpeta) || (req.query && req.query.carpeta) || '');
    const permiso = PERMISO_POR_CARPETA[carpeta];
    if (!permiso) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `El campo "carpeta" debe ser uno de: ${service.CARPETAS.join(', ')}.`,
        [{ field: 'carpeta', value: carpeta || null }],
      );
    }
    if (!hasPermiso(req.usuario, permiso)) {
      throw new AppError(403, 'FORBIDDEN', 'No tiene permiso para subir imágenes en esa sección.');
    }

    const resultado = await service.subirImagen(req.file, carpeta, req.usuario);
    res.status(201).json(resultado);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
