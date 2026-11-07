'use strict';

// Las reglas base se verifican en memoria; usa SMOKE_DB_MODE=supabase para probar persistencia.
process.env.DB_MODE = process.env.SMOKE_DB_MODE || 'memory';

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) {
        return response.json();
      }
    } catch (error) {
      // el servidor aún no levanta
    }
    await delay(250);
  }
  throw new Error('El servidor no respondió en /health');
}

async function request(base, method, endpoint, options = {}) {
  const headers = {};
  let body;
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${base}${endpoint}`, { method, headers, body });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (error) {
    parsed = text;
  }
  return { status: response.status, ok: response.ok, body: parsed };
}

const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api`;
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      LOG_REQUESTS: '0',
      JWT_SECRET: 'verification-secret-fratellis-32-bytes',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  try {
    await waitForHealth(base);

    const ownerLogin = await request(base, 'POST', '/auth/login', {
      body: { email: 'maick@fratellis.pe', password: 'demo123' },
    });
    const owner = ownerLogin.body.token;
    check(
      'login dueño',
      ownerLogin.ok && ownerLogin.body.roles.includes('Dueño/Admin'),
      `roles=${ownerLogin.body.roles}`,
    );

    const cashierLogin = await request(base, 'POST', '/auth/login', {
      body: { email: 'cajero@fratellis.pe', password: 'demo123' },
    });
    const cashier = cashierLogin.body.token;
    check(
      'multi-rol cajero',
      cashierLogin.ok &&
        cashierLogin.body.roles.includes('Mozo') &&
        cashierLogin.body.roles.includes('Cajero'),
      `roles=${cashierLogin.body.roles}`,
    );
    check(
      'permisos unión multi-rol',
      cashierLogin.body.permisos.includes('caja.cobrar') &&
        cashierLogin.body.permisos.includes('venta.registrar'),
      `${cashierLogin.body.permisos.length} permisos`,
    );

    const forbidden = await request(base, 'GET', '/mermas', { token: cashier });
    check('RBAC: cajero no gestiona merma', forbidden.status === 403, `HTTP ${forbidden.status}`);
    const allowed = await request(base, 'GET', '/mermas', { token: owner });
    check('RBAC: dueño gestiona merma', allowed.ok, `HTTP ${allowed.status}`);

    const pagosAntes = await request(base, 'GET', '/cuentas/1/pagos', { token: owner });
    check(
      'cobro solo al cerrar: sin pagos previos',
      pagosAntes.ok && pagosAntes.body.total_pagado === 0,
      `total_pagado=${pagosAntes.body.total_pagado}`,
    );

    const ronda = await request(base, 'POST', '/cuentas/1/pedidos', {
      token: cashier,
      body: { items: [{ platillo_id: 4, cantidad: 1 }] },
    });
    check(
      'agregar ronda a cuenta abierta',
      ronda.status === 201 && ronda.body.estado === 'borrador',
      `HTTP ${ronda.status}, estado=${ronda.body.estado}`,
    );
    const pagosTrasRonda = await request(base, 'GET', '/cuentas/1/pagos', { token: owner });
    check(
      'ronda no genera cobro',
      pagosTrasRonda.body.total_pagado === 0,
      `total_pagado=${pagosTrasRonda.body.total_pagado}`,
    );

    const detalle = await request(base, 'GET', '/cuentas/1', { token: owner });
    const totalCuenta = detalle.body.total_consolidado;
    const cobro = await request(base, 'POST', '/cuentas/1/cobrar', {
      token: cashier,
      body: { metodo: 'efectivo', monto: totalCuenta },
    });
    check(
      'cobrar cuenta abierta',
      cobro.ok && cobro.body.comprobante && cobro.body.pago,
      `HTTP ${cobro.status}, total=${totalCuenta}`,
    );
    const doble = await request(base, 'POST', '/cuentas/1/cobrar', {
      token: cashier,
      body: { metodo: 'efectivo', monto: totalCuenta },
    });
    check(
      'doble cobro 409',
      doble.status === 409 &&
        doble.body.error &&
        doble.body.error.code === 'CUENTA_YA_COBRADA',
      `HTTP ${doble.status}, code=${doble.body.error && doble.body.error.code}`,
    );

    const invAntes = await request(base, 'GET', '/inventario', { token: owner });
    const stockPapaAntes = invAntes.body.data.find((item) => item.id === 2).stock_actual;
    const merma = await request(base, 'POST', '/mermas', {
      token: owner,
      body: {
        tipo_merma_id: 2,
        insumo_id: 2,
        cantidad: 1,
        clasificacion: 'evitable',
        causa_raiz: 'Verificación',
        motivo: 'Verificación de regla',
      },
    });
    const aprobada = await request(base, 'POST', `/mermas/${merma.body.id}/aprobar`, {
      token: owner,
    });
    const invDespues = await request(base, 'GET', '/inventario', { token: owner });
    const stockPapaDespues = invDespues.body.data.find((item) => item.id === 2).stock_actual;
    check(
      'merma aprobada descuenta stock',
      aprobada.ok &&
        Number((stockPapaAntes - stockPapaDespues).toFixed(3)) === 1,
      `${stockPapaAntes} -> ${stockPapaDespues}`,
    );
    const dobleMerma = await request(base, 'POST', `/mermas/${merma.body.id}/aprobar`, {
      token: owner,
    });
    check(
      'doble aprobación de merma 409',
      dobleMerma.status === 409 && dobleMerma.body.error.code === 'MERMA_YA_RESUELTA',
      `HTTP ${dobleMerma.status}, code=${dobleMerma.body.error && dobleMerma.body.error.code}`,
    );

    const stockPolloAntes = invDespues.body.data.find((item) => item.id === 1).stock_actual;
    const externo = await request(base, 'POST', '/delivery-externo/pedidos', {
      token: owner,
      body: {
        plataforma: 'rappi',
        direccion_entrega: 'Jr. Prueba 123',
        items: [{ platillo_id: 1, cantidad: 1 }],
      },
    });
    const aceptado = await request(base, 'POST', `/delivery-externo/pedidos/${externo.body.id}/aceptar`, {
      token: owner,
    });
    const invAceptado = await request(base, 'GET', '/inventario', { token: owner });
    const stockPolloAceptado = invAceptado.body.data.find((item) => item.id === 1).stock_actual;
    const cancelado = await request(base, 'POST', `/delivery-externo/pedidos/${externo.body.id}/cancelar`, {
      token: owner,
      body: { motivo: 'Prueba de reversa' },
    });
    const invCancelado = await request(base, 'GET', '/inventario', { token: owner });
    const stockPolloCancelado = invCancelado.body.data.find((item) => item.id === 1).stock_actual;
    check(
      'aceptar externo descuenta stock',
      aceptado.ok && stockPolloAceptado < stockPolloAntes,
      `${stockPolloAntes} -> ${stockPolloAceptado}`,
    );
    check(
      'cancelar externo repone stock',
      cancelado.ok &&
        cancelado.body.stock_revertido === true &&
        stockPolloCancelado === stockPolloAntes,
      `${stockPolloAceptado} -> ${stockPolloCancelado}`,
    );

    const cuadreDup = await request(base, 'POST', '/cuadre-caja/apertura', {
      token: owner,
      body: { fondo_inicial: 100 },
    });
    check(
      'cuadre único por día 409',
      cuadreDup.status === 409 && cuadreDup.body.error.code === 'CUADRE_YA_EXISTE',
      `HTTP ${cuadreDup.status}, code=${cuadreDup.body.error && cuadreDup.body.error.code}`,
    );

    const nuevaCuenta = await request(base, 'POST', '/cuentas', {
      token: owner,
      body: { mesa_id: 1 },
    });
    const cuentaId = nuevaCuenta.body.id;
    const totalBase = (await request(base, 'GET', `/cuentas/${cuentaId}`, { token: owner })).body
      .total_consolidado;
    const nuevaRonda = await request(base, 'POST', `/cuentas/${cuentaId}/pedidos`, {
      token: owner,
      body: { items: [{ platillo_id: 5, cantidad: 1 }] },
    });
    const totalConRonda = (await request(base, 'GET', `/cuentas/${cuentaId}`, { token: owner })).body
      .total_consolidado;
    const cancelada = await request(base, 'POST', `/pedidos/${nuevaRonda.body.id}/cancelar`, {
      token: owner,
      body: { motivo: 'Prueba' },
    });
    const totalTrasCancelar = (await request(base, 'GET', `/cuentas/${cuentaId}`, { token: owner })).body
      .total_consolidado;
    check(
      'pedido cancelado no se cobra',
      cancelada.ok && totalConRonda > totalBase && totalTrasCancelar === totalBase,
      `${totalBase} -> ${totalConRonda} -> ${totalTrasCancelar}`,
    );

    const failures = results.filter((item) => !item.ok).length;
    console.log(`\nRESUMEN: ${results.length - failures}/${results.length} reglas verificadas`);
    if (failures > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('VERIFY FAIL:', error.message);
    process.exitCode = 1;
  } finally {
    try {
      child.kill('SIGTERM');
    } catch (error) {
      // el proceso ya no existe
    }
    await delay(300);
    try {
      child.kill('SIGKILL');
    } catch (error) {
      // el proceso ya no existe
    }
  }
})();
