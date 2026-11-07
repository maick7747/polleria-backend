'use strict';

const cocina = require('../cocina/cocina.service');

async function listComandas(query = {}) {
  return cocina.listKds(query);
}

module.exports = { listComandas };
