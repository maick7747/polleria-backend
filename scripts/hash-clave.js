'use strict';

/**
 * Genera el hash scrypt que espera `src/lib/password.js` (formato `salt:hash`).
 *
 * Uso (la clave NO queda en el historial si se pasa por stdin):
 *   echo "MiClaveFuerte" | node scripts/hash-clave.js
 *   node scripts/hash-clave.js "MiClaveFuerte"      (queda en el historial)
 *
 * Luego, en Supabase SQL Editor:
 *   UPDATE usuarios SET password_hash = '<hash>' WHERE email = '...';
 *
 * Nunca imprime la clave; solo el hash.
 */

const fs = require('fs');
const { hashPassword } = require('../src/lib/password');

function leerClave() {
  const porArgumento = process.argv[2];
  if (porArgumento) {
    return porArgumento;
  }
  try {
    return fs.readFileSync(0, 'utf8').trim();
  } catch {
    return '';
  }
}

const clave = leerClave();

if (!clave) {
  console.error('Falta la clave. Usa: echo "MiClaveFuerte" | node scripts/hash-clave.js');
  process.exit(1);
}

if (clave === 'demo123') {
  console.error('Rechazado: `demo123` es la clave pública de los usuarios demo.');
  process.exit(1);
}

if (clave.length < 10) {
  console.error('Rechazado: usa al menos 10 caracteres.');
  process.exit(1);
}

console.log(hashPassword(clave));
