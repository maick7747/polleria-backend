'use strict';

// Los smoke/verify base se ejecutan en memoria; usa SMOKE_DB_MODE=supabase para probar persistencia.
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) {
        return response.json();
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`El servidor no respondió en /health: ${lastError ? lastError.message : 'sin detalle'}`);
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
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (error) {
    parsed = text;
  }
  return { status: response.status, ok: response.ok, body: parsed };
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (error) {
        // el proceso ya no existe
      }
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch (error) {
      clearTimeout(timer);
      resolve();
    }
  });
}

function resumen(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).slice(0, 5).join(', ');
    return `{${keys}${Object.keys(value).length > 5 ? ', …' : ''}}`;
  }
  return String(value);
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
      JWT_SECRET: 'smoke-test-secret-fratellis-32-bytes-long',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk.toString();
  });

  const results = [];

  try {
    const health = await waitForHealth(base);
    results.push({ name: 'GET /api/health', status: 200, detail: health.status });
    if (health.status !== 'ok') {
      throw new Error('Health no devolvió status=ok');
    }

    const login = await request(base, 'POST', '/auth/login', {
      body: { email: 'maick@fratellis.pe', password: 'demo123' },
    });
    results.push({
      name: 'POST /api/auth/login',
      status: login.status,
      detail: login.ok ? `roles=${(login.body.roles || []).join('+')}` : resumen(login.body),
    });
    if (!login.ok || !login.body.token) {
      throw new Error(`Login falló: ${JSON.stringify(login.body)}`);
    }
    const token = login.body.token;

    const checks = [
      ['GET /api/dashboard', '/dashboard'],
      ['GET /api/venta-local/mesas', '/venta-local/mesas'],
      ['GET /api/venta-local/tablero', '/venta-local/tablero'],
      ['GET /api/mesas', '/mesas'],
      ['GET /api/cocina/comandas', '/cocina/comandas'],
      ['GET /api/kds/pedidos', '/kds/pedidos'],
      ['GET /api/inventario', '/inventario'],
      ['GET /api/inventario/alertas', '/inventario/alertas'],
      ['GET /api/cuadre-caja', '/cuadre-caja'],
      ['GET /api/tipos-merma', '/tipos-merma'],
      ['GET /api/configuracion', '/configuracion'],
      ['GET /api/reportes/ventas', '/reportes/ventas'],
    ];

    for (const [name, endpoint] of checks) {
      const response = await request(base, 'GET', endpoint, { token });
      let detail;
      if (response.body === null) {
        detail = 'null';
      } else if (name.includes('mesas') || name.includes('comandas') || name.includes('kds')) {
        detail = `${response.body.meta ? response.body.meta.total : '?'} registros`;
      } else if (endpoint === '/dashboard') {
        detail = `ventas=S/ ${response.body.kpis ? response.body.kpis.ventas : '?'}`;
      } else if (endpoint === '/inventario') {
        detail = `${response.body.meta ? response.body.meta.total : '?'} insumos`;
      } else if (endpoint === '/cuadre-caja') {
        detail = response.body ? `caja ${response.body.estado}` : 'sin cuadre';
      } else {
        detail = resumen(response.body);
      }
      results.push({ name, status: response.status, detail });
      if (!response.ok) {
        throw new Error(`${name} devolvió ${response.status}: ${JSON.stringify(response.body)}`);
      }
    }

    const cuentas = await request(base, 'GET', '/cuentas?estado=abierta&limit=10', { token });
    const listaCuentas = Array.isArray(cuentas.body && cuentas.body.data) ? cuentas.body.data : [];
    const sinNombre = listaCuentas.filter(
      (cuenta) => typeof cuenta.usuario_apertura_nombre !== 'string' || cuenta.usuario_apertura_nombre.length === 0,
    );
    results.push({
      name: 'GET /api/cuentas (mozo)',
      status: cuentas.status,
      detail:
        cuentas.ok && listaCuentas.length > 0 && sinNombre.length === 0
          ? `${listaCuentas.length} cuentas con usuario_apertura_nombre`
          : `faltan nombres en ${sinNombre.length}/${listaCuentas.length}`,
    });
    if (!cuentas.ok || listaCuentas.length === 0 || sinNombre.length > 0) {
      throw new Error(`GET /api/cuentas no devolvió usuario_apertura_nombre: ${JSON.stringify(cuentas.body)}`);
    }

    const mesaId = listaCuentas[0].mesa_id;
    const mesa = await request(base, 'GET', `/mesas/${mesaId}`, { token });
    const nombreMesa = mesa.body && mesa.body.cuenta_abierta
      ? mesa.body.cuenta_abierta.usuario_apertura_nombre
      : null;
    results.push({
      name: 'GET /api/mesas/:id (mozo)',
      status: mesa.status,
      detail: nombreMesa ? `mozo=${nombreMesa}` : 'sin usuario_apertura_nombre',
    });
    if (!mesa.ok || !nombreMesa) {
      throw new Error(`GET /api/mesas/${mesaId} no devolvió usuario_apertura_nombre`);
    }

    const cuentaId = listaCuentas[0].id;
    const totalAntes = (await request(base, 'GET', `/cuentas/${cuentaId}`, { token })).body
      .total_consolidado;
    const idempotencyKey = `smoke-${Date.now()}-ronda`;
    const ronda1 = await request(base, 'POST', `/cuentas/${cuentaId}/pedidos`, {
      token,
      body: {
        items: [{ platillo_id: 4, cantidad: 1 }],
        idempotency_key: idempotencyKey,
      },
    });
    const ronda2 = await request(base, 'POST', `/cuentas/${cuentaId}/pedidos`, {
      token,
      body: {
        items: [{ platillo_id: 4, cantidad: 1 }],
        idempotency_key: idempotencyKey,
      },
    });
    const totalDespues = (await request(base, 'GET', `/cuentas/${cuentaId}`, { token })).body
      .total_consolidado;
    const totalEsperado = Number((Number(totalAntes) + Number(ronda1.body.total)).toFixed(2));
    const idempotenteOk =
      ronda1.ok &&
      ronda2.ok &&
      ronda1.body.id === ronda2.body.id &&
      ronda2.body.idempotente === true &&
      Number(totalDespues) === totalEsperado;
    results.push({
      name: 'POST /api/cuentas/:id/pedidos (idempotente)',
      status: idempotenteOk ? 201 : 500,
      detail: idempotenteOk
        ? `id=${ronda1.body.id}, total=${totalAntes} -> ${totalDespues}`
        : `ids=${ronda1.body.id}/${ronda2.body.id}, total=${totalAntes} -> ${totalDespues} (esperado ${totalEsperado})`,
    });
    if (!idempotenteOk) {
      throw new Error(
        `La ronda no fue idempotente: ${JSON.stringify({ r1: ronda1.body, r2: ronda2.body, totalDespues, totalEsperado })}`,
      );
    }

    const rondaEnvio = await request(base, 'POST', `/cuentas/${cuentaId}/pedidos`, {
      token,
      body: {
        items: [{ platillo_id: 4, cantidad: 1 }],
        idempotency_key: `smoke-${Date.now()}-envio`,
        enviar_cocina: true,
      },
    });
    const envioOk = rondaEnvio.ok && rondaEnvio.body.estado === 'en_cocina';
    results.push({
      name: 'POST /api/cuentas/:id/pedidos (enviar_cocina)',
      status: envioOk ? 201 : 500,
      detail: envioOk
        ? `id=${rondaEnvio.body.id}, estado=${rondaEnvio.body.estado}, mov=${rondaEnvio.body.movimientos_inventario}`
        : JSON.stringify(rondaEnvio.body),
    });
    if (!envioOk) {
      throw new Error(
        `La ronda con enviar_cocina no quedó en cocina: ${JSON.stringify(rondaEnvio.body)}`,
      );
    }

    const documentoSmoke = '99999999';
    const clientePatch = await request(base, 'PATCH', `/cuentas/${cuentaId}/cliente`, {
      token,
      body: {
        cliente: {
          nombre: 'Cliente Smoke',
          tipo_documento: 'DNI',
          numero_documento: documentoSmoke,
          telefono: '999999999',
        },
      },
    });
    const detalleCliente = await request(base, 'GET', `/cuentas/${cuentaId}`, { token });
    const clienteGuardado = detalleCliente.body && detalleCliente.body.cliente;
    const clienteOk =
      clientePatch.ok &&
      clientePatch.body.cliente_id != null &&
      clientePatch.body.cliente &&
      clientePatch.body.cliente.nombre === 'Cliente Smoke' &&
      detalleCliente.ok &&
      clienteGuardado &&
      clienteGuardado.nombre === 'Cliente Smoke' &&
      String(clienteGuardado.numero_documento) === documentoSmoke;
    results.push({
      name: 'PATCH /api/cuentas/:id/cliente',
      status: clienteOk ? 200 : 500,
      detail: clienteOk
        ? `cliente_id=${clientePatch.body.cliente_id}, ${clienteGuardado.nombre}`
        : `patch=${clientePatch.status}, detalle=${JSON.stringify(clienteGuardado)}`,
    });
    if (!clienteOk) {
      throw new Error(
        `El cliente no se persistió en la cuenta: ${JSON.stringify({ patch: clientePatch.body, detalle: clienteGuardado })}`,
      );
    }

    console.log('\nSmoke test Fratelli\'s');
    console.log('─'.repeat(74));
    for (const item of results) {
      console.log(`${String(item.status).padEnd(4)} ${item.name.padEnd(42)} ${item.detail}`);
    }
    console.log('─'.repeat(74));
    console.log(`SMOKE OK — ${results.length} comprobaciones en el puerto ${port}`);
  } catch (error) {
    console.error('\nSMOKE FAIL:', error.message);
    if (logs.trim()) {
      console.error('\nSalida del servidor:\n' + logs.trim());
    }
    process.exitCode = 1;
  } finally {
    await stop(child);
  }
})().catch((error) => {
  console.error('SMOKE FAIL:', error.message);
  process.exitCode = 1;
});
