'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSort, pageParams } = require('../src/middleware/validate');
const { round2, round3 } = require('../src/lib/moneda');
const store = require('../src/data/store');

test('parseSort usa el fallback controlado', () => {
  assert.deepEqual(parseSort(undefined, ['id', 'fecha'], 'id:desc'), {
    campo: 'id',
    ascending: false,
  });
});

test('parseSort acepta campo:asc y campo:desc', () => {
  assert.deepEqual(parseSort('fecha:desc', ['id', 'fecha']), {
    campo: 'fecha',
    ascending: false,
  });
  assert.deepEqual(parseSort('total', ['id', 'total']), {
    campo: 'total',
    ascending: true,
  });
});

test('parseSort rechaza campos fuera de la whitelist con 400', () => {
  assert.throws(
    () => parseSort('inventado:desc', ['id', 'fecha']),
    (error) => error.status === 400 && error.code === 'VALIDATION_ERROR',
  );
});

test('parseSort rechaza direcciones inválidas', () => {
  assert.throws(
    () => parseSort('id:lado', ['id']),
    (error) => error.status === 400 && error.code === 'VALIDATION_ERROR',
  );
});

test('pageParams aplica defaults y tope de 100', () => {
  assert.deepEqual(pageParams({}), { page: 1, limit: 20 });
  assert.deepEqual(pageParams({ page: '2', limit: '50' }), { page: 2, limit: 50 });
  assert.throws(
    () => pageParams({ limit: '101' }),
    (error) => error.status === 400 && error.code === 'VALIDATION_ERROR',
  );
});

test('round2/round3 corrigen los casos binarios', () => {
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(10.005), 10.01);
  assert.equal(round2(2.675), 2.68);
  assert.equal(round2(1.004), 1);
  assert.equal(round2(-1.005), -1.01);
  assert.equal(round3(1.0005), 1.001);
  assert.equal(store.round2(1.005), round2(1.005));
});
