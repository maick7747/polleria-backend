'use strict';

/**
 * Redondeo monetario estable para magnitudes < 1e9.
 *
 * El hack `+ Number.EPSILON` falla en casos como 10.005 -> 10.00 o
 * 1.005 -> 1.00. Aquí se multiplica por el factor, se fija el resultado a
 * 6 decimales (absorbe el sesgo binario de IEEE-754) y recién entonces se
 * redondea al decimal pedido.
 */
function redondear(valor, decimales) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) {
    return numero;
  }
  if (numero === 0) {
    return 0;
  }
  // Simétrico (mitad fuera del cero): -1.005 -> -1.01, no -1.00.
  const signo = numero < 0 ? -1 : 1;
  const factor = 10 ** decimales;
  const absoluto = Math.abs(numero);
  return (signo * Math.round(Number((absoluto * factor).toFixed(6)))) / factor;
}

const round2 = (valor) => redondear(valor, 2);
const round3 = (valor) => redondear(valor, 3);

module.exports = { redondear, round2, round3 };
