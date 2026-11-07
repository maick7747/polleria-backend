'use strict';

// ZIP mínimo sin dependencias externas.
// - crearZip(): escribe entradas con método "store" (sin compresión).
// - leerZip(): lee entradas con método store (0) o deflate (8).
//
// SUNAT exige enviar el comprobante UBL dentro de un ZIP y devuelve el CDR
// también dentro de un ZIP, por eso se necesita ambas direcciones.

const zlib = require('zlib');

const TABLA_CRC = (() => {
  const tabla = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tabla[n] = c;
  }
  return tabla;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ TABLA_CRC[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function crearZip(entradas) {
  const partes = [];
  const central = [];
  let offset = 0;

  for (const entrada of entradas) {
    const nombre = Buffer.from(String(entrada.nombre), 'utf8');
    const contenido = Buffer.isBuffer(entrada.contenido)
      ? entrada.contenido
      : Buffer.from(String(entrada.contenido), 'utf8');
    const crc = crc32(contenido);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(contenido.length, 18);
    local.writeUInt32LE(contenido.length, 22);
    local.writeUInt16LE(nombre.length, 26);
    local.writeUInt16LE(0, 28);

    partes.push(local, nombre, contenido);

    const registro = Buffer.alloc(46);
    registro.writeUInt32LE(0x02014b50, 0);
    registro.writeUInt16LE(20, 4);
    registro.writeUInt16LE(20, 6);
    registro.writeUInt16LE(0x0800, 8);
    registro.writeUInt16LE(0, 10);
    registro.writeUInt16LE(0, 12);
    registro.writeUInt16LE(0x21, 14);
    registro.writeUInt32LE(crc, 16);
    registro.writeUInt32LE(contenido.length, 20);
    registro.writeUInt32LE(contenido.length, 24);
    registro.writeUInt16LE(nombre.length, 28);
    registro.writeUInt16LE(0, 30);
    registro.writeUInt16LE(0, 32);
    registro.writeUInt16LE(0, 34);
    registro.writeUInt16LE(0, 36);
    registro.writeUInt32LE(0, 38);
    registro.writeUInt32LE(offset, 42);

    central.push(Buffer.concat([registro, nombre]));
    offset += local.length + nombre.length + contenido.length;
  }

  const directorio = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(0, 4);
  fin.writeUInt16LE(0, 6);
  fin.writeUInt16LE(entradas.length, 8);
  fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(offset, 16);
  fin.writeUInt16LE(0, 20);

  return Buffer.concat([...partes, directorio, fin]);
}

function buscarFinDirectorio(buffer) {
  const minimo = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minimo; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      return i;
    }
  }
  return -1;
}

function leerZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('ZIP inválido: contenido demasiado corto.');
  }

  const fin = buscarFinDirectorio(buffer);
  if (fin < 0) {
    throw new Error('ZIP inválido: no se encontró el fin del directorio central.');
  }

  const total = buffer.readUInt16LE(fin + 10);
  let puntero = buffer.readUInt32LE(fin + 16);
  const entradas = [];

  for (let i = 0; i < total; i += 1) {
    if (buffer.readUInt32LE(puntero) !== 0x02014b50) {
      throw new Error('ZIP inválido: firma del directorio central incorrecta.');
    }

    const metodo = buffer.readUInt16LE(puntero + 10);
    const tamanoComprimido = buffer.readUInt32LE(puntero + 20);
    const largoNombre = buffer.readUInt16LE(puntero + 28);
    const largoExtra = buffer.readUInt16LE(puntero + 30);
    const largoComentario = buffer.readUInt16LE(puntero + 32);
    const offsetLocal = buffer.readUInt32LE(puntero + 42);
    const nombre = buffer
      .slice(puntero + 46, puntero + 46 + largoNombre)
      .toString('utf8');

    if (buffer.readUInt32LE(offsetLocal) !== 0x04034b50) {
      throw new Error(`ZIP inválido: cabecera local incorrecta para ${nombre}.`);
    }

    const nombreLocal = buffer.readUInt16LE(offsetLocal + 26);
    const extraLocal = buffer.readUInt16LE(offsetLocal + 28);
    const inicioDatos = offsetLocal + 30 + nombreLocal + extraLocal;
    const crudo = buffer.slice(inicioDatos, inicioDatos + tamanoComprimido);
    const contenido = metodo === 8 ? zlib.inflateRawSync(crudo) : crudo;

    entradas.push({ nombre, metodo, contenido });

    puntero += 46 + largoNombre + largoExtra + largoComentario;
  }

  return entradas;
}

module.exports = { crc32, crearZip, leerZip };
