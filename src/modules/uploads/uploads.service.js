'use strict';

// Subida de una imagen por entidad (platillos, activos, insumos, proveedores).
//
// - DB_MODE=supabase -> Supabase Storage (bucket público `fratelli-imagenes`).
// - DB_MODE=memory   -> data URL en base64, para que la UI pueda previsualizar
//                       sin depender de un servicio externo en demo/pruebas.
//
// El límite (2 MB) y los MIME (jpeg/png/webp) se validan aquí además de en
// multer, y se comprueba la firma real del archivo: el `Content-Type` que
// declara el cliente no es confiable.

const crypto = require('crypto');
const db = require('../../data/db');
const repository = require('../../data/repository');
const { AppError } = require('../../middleware/error');

const BUCKET = 'fratelli-imagenes';
const MAX_BYTES = 2 * 1024 * 1024;

const CARPETAS = ['platillos', 'activos', 'insumos', 'proveedores'];

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const MIMES = Object.keys(MIME_EXT);

const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function archivoInvalido(message) {
  return new AppError(400, 'ARCHIVO_INVALIDO', message);
}

// Firma real del contenido (magic numbers):
//   JPEG  ff d8 ff
//   PNG   89 50 4e 47 0d 0a 1a 0a
//   WebP  "RIFF" en 0..3 y "WEBP" en 8..11
function firmaValida(buffer, mimetype) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return false;
  }
  switch (mimetype) {
    case 'image/jpeg':
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'image/png':
      return buffer.subarray(0, FIRMA_PNG.length).equals(FIRMA_PNG);
    case 'image/webp':
      return (
        buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
        buffer.subarray(8, 12).toString('latin1') === 'WEBP'
      );
    default:
      return false;
  }
}

function validarCarpeta(carpeta) {
  if (!CARPETAS.includes(carpeta)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `El campo "carpeta" debe ser uno de: ${CARPETAS.join(', ')}.`,
      [{ field: 'carpeta', value: carpeta === undefined ? null : carpeta }],
    );
  }
  return carpeta;
}

function validarArchivo(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new AppError(400, 'ARCHIVO_REQUERIDO', 'Debe adjuntar una imagen en el campo "file".', [
      { field: 'file' },
    ]);
  }

  const mimetype = String(file.mimetype || '').toLowerCase();
  if (!MIMES.includes(mimetype)) {
    throw archivoInvalido('La imagen debe ser JPEG, PNG o WebP.');
  }

  const size = Number.isFinite(file.size) ? Number(file.size) : file.buffer.length;
  if (size > MAX_BYTES) {
    throw new AppError(413, 'ARCHIVO_MUY_GRANDE', 'La imagen supera el límite de 2 MB.', [
      { field: 'file', size, max: MAX_BYTES },
    ]);
  }
  if (size <= 0) {
    throw new AppError(400, 'ARCHIVO_REQUERIDO', 'El archivo adjunto está vacío.', [
      { field: 'file' },
    ]);
  }

  // El MIME declarado debe coincidir con el contenido real.
  if (!firmaValida(file.buffer, mimetype)) {
    throw archivoInvalido('El contenido del archivo no corresponde a una imagen JPEG, PNG o WebP.');
  }

  return { mimetype, size };
}

function nombreArchivo(mimetype) {
  return `${Date.now()}-${crypto.randomUUID()}.${MIME_EXT[mimetype]}`;
}

async function subirASupabase(file, carpeta, mimetype, size) {
  const path = `${carpeta}/${nombreArchivo(mimetype)}`;

  let bucket;
  try {
    bucket = repository.storage().from(BUCKET);
  } catch (error) {
    throw new AppError(502, 'STORAGE_ERROR', 'El almacenamiento de imágenes no está disponible.', [
      { detalle: error.message },
    ]);
  }

  const { error } = await bucket
    .upload(path, file.buffer, {
      contentType: mimetype,
      upsert: false,
      cacheControl: '31536000',
    })
    .catch((fallo) => ({ error: fallo }));
  if (error) {
    throw new AppError(502, 'STORAGE_ERROR', 'No se pudo subir la imagen al almacenamiento.', [
      { detalle: error.message },
    ]);
  }

  let publica;
  try {
    publica = bucket.getPublicUrl(path);
  } catch (fallo) {
    throw new AppError(502, 'STORAGE_ERROR', 'No se pudo obtener la URL pública de la imagen.', [
      { detalle: fallo.message },
    ]);
  }
  const data = publica && publica.data;
  if (!data || !data.publicUrl) {
    throw new AppError(502, 'STORAGE_ERROR', 'No se pudo obtener la URL pública de la imagen.');
  }

  return {
    url: data.publicUrl,
    path,
    content_type: mimetype,
    size,
  };
}

// `usuario` se recibe para auditoría futura (autor de la subida); hoy el
// bucket no guarda metadatos por objeto y no se usa.
async function subirImagen(file, carpeta, usuario) {
  const destino = validarCarpeta(carpeta);
  const { mimetype, size } = validarArchivo(file);

  if (db.isSupabase()) {
    return subirASupabase(file, destino, mimetype, size);
  }

  return {
    url: `data:${mimetype};base64,${file.buffer.toString('base64')}`,
    path: null,
    content_type: mimetype,
    size,
  };
}

module.exports = {
  BUCKET,
  CARPETAS,
  MAX_BYTES,
  MIMES,
  subirImagen,
  firmaValida,
};
