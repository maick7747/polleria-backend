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
