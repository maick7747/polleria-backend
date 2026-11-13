'use strict';

/**
 * Verificación offline del redondeo monetario.
 * Casos límite que fallaban con el hack `+ Number.EPSILON`.
 */

const { round2, round3 } = require('../src/lib/moneda');
const store = require('../src/data/store');

const CASOS = [
  ['round2(1.005)', round2(1.005), 1.01],
  ['round2(10.005)', round2(10.005), 10.01],
  ['round2(2.675)', round2(2.675), 2.68],
  ['round2(1.004)', round2(1.004), 1],
  ['round2(-1.005)', round2(-1.005), -1.01],
  ['round2(0)', round2(0), 0],
  ['round3(1.0005)', round3(1.0005), 1.001],
  ['round3(2.0004)', round3(2.0004), 2],
  ['store.round2 === moneda.round2', store.round2(1.005), 1.01],
];

let fallos = 0;
for (const [nombre, obtenido, esperado] of CASOS) {
  const ok = Object.is(obtenido, esperado);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${nombre} = ${obtenido} (esperado ${esperado})`);
  if (!ok) {
    fallos += 1;
  }
}

console.log(`\nVERIFY MONEDA: ${CASOS.length - fallos}/${CASOS.length} OK`);
process.exit(fallos === 0 ? 0 : 1);
