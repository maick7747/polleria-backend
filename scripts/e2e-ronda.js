'use strict';

// E2E de la ronda transaccional (migracion 007) contra Supabase real.
// Uso: npm run e2e:ronda
//
// Flujo: login -> mesa libre -> abrir cuenta -> POST /cuentas/:id/pedidos
// con enviar_cocina=true -> verificar estado/total/stock -> repetir con la
// misma idempotency_key -> cancelar la cuenta -> verificar stock restaurado
// y mesa liberada. No deja cuentas abiertas ni cobros.

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

process.env.DB_MODE = 'supabase';
const repository = require('../src/data/repository');

async function elegirPlatilloConStock() {
  const { data: fichas } = await repository.list('fichas_tecnicas', {
    filters: { activa: true },
    limit: 100,
  });
  const { data: platillos } = await repository.list('platillos', {
    filters: { activo: true },
    limit: 100,
  });
  const { data: insumos } = await repository.list('insumos', { limit: 1000 });
  const platilloPorId = new Map(platillos.map((platillo) => [platillo.id, platillo]));
  const stockPorId = new Map(insumos.map((insumo) => [insumo.id, Number(insumo.stock_actual)]));

  for (const ficha of fichas) {
    const platillo = platilloPorId.get(ficha.platillo_id);
    if (!platillo) {
      continue;
    }
    const { data: detalle } = await repository.list('fichas_tecnicas_detalle', {
      filters: { ficha_id: ficha.id },
      limit: 100,
    });
    if (detalle.length === 0) {
      continue;
    }
    const porciones = Number(ficha.porciones_rendimiento) || 1;
    const alcanza = detalle.every((ingrediente) => {
      const requerido = Number(ingrediente.cantidad) / porciones;
      return (stockPorId.get(ingrediente.insumo_id) || 0) >= requerido + 0.01;
    });
    if (alcanza) {
      return {
        platilloId: platillo.id,
        platilloNombre: platillo.nombre,
        insumoId: detalle[0].insumo_id,
      };
    }
  }

  return null;
}

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

async function waitForHealth(base, timeoutMs = 30000) {
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
    await delay(300);
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

(async () => {
  const candidato = await elegirPlatilloConStock();
  if (!candidato) {
    throw new Error('No hay platillos con ficha tecnica y stock suficiente para el E2E.');
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api`;
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    env: {
      ...process.env,
      DB_MODE: 'supabase',
      PORT: String(port),
      NODE_ENV: 'test',
      LOG_REQUESTS: '0',
      JWT_SECRET: process.env.JWT_SECRET || 'e2e-ronda-secret-fratellis-32-bytes',
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
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  let cuentaId = null;
  let mesaId = null;
  let stockInicial = null;

  try {
    const health = await waitForHealth(base);
    push('GET /api/health', health.status === 'ok', `${health.status} · modo supabase`);

    const login = await request(base, 'POST', '/auth/login', {
      body: { email: 'maick@fratellis.pe', password: 'demo123' },
    });
    push(
      'POST /api/auth/login',
      login.ok && Boolean(login.body.token),
      login.ok ? `roles=${(login.body.roles || []).join('+')}` : JSON.stringify(login.body),
    );
    if (!login.ok || !login.body.token) {
      throw new Error(`Login falló: ${JSON.stringify(login.body)}`);
    }
    const token = login.body.token;

    let cuadre = await request(base, 'GET', '/cuadre-caja', { token });
    if (cuadre.ok && cuadre.body === null) {
      await request(base, 'POST', '/cuadre-caja/apertura', {
        token,
        body: { fondo_inicial: 0, observaciones: 'e2e-ronda' },
      });
    }

    const mesas = await request(base, 'GET', '/mesas?limit=100', { token });
    const mesaLibre = (mesas.body.data || []).find((mesa) => mesa.estado === 'libre');
    push('GET /api/mesas (libre)', Boolean(mesaLibre), mesaLibre ? `mesa ${mesaLibre.numero}` : 'sin mesas libres');
    if (!mesaLibre) {
      throw new Error('No hay mesas libres en Supabase para el E2E.');
    }
    mesaId = mesaLibre.id;

    const inventarioAntes = await request(base, 'GET', '/inventario?limit=100', { token });
    const insumoAntes = (inventarioAntes.body.data || []).find(
      (insumo) => insumo.id === candidato.insumoId,
    );
    stockInicial = insumoAntes ? Number(insumoAntes.stock_actual) : null;

    const cuenta = await request(base, 'POST', '/cuentas', {
      token,
      body: { mesa_id: mesaId },
    });
    cuentaId = cuenta.ok ? cuenta.body.id : null;
    push(
      'POST /api/cuentas',
      cuenta.ok && Boolean(cuentaId),
      cuenta.ok ? `cuenta ${cuentaId} · mesa ${mesaLibre.numero}` : JSON.stringify(cuenta.body),
    );
    if (!cuenta.ok || !cuentaId) {
      throw new Error(`Abrir cuenta falló: ${JSON.stringify(cuenta.body)}`);
    }

    const clave = `e2e-ronda-${Date.now()}`;
    const cuerpo = {
      items: [{ platillo_id: candidato.platilloId, cantidad: 1 }],
      idempotency_key: clave,
      enviar_cocina: true,
    };
    const inicioRonda = Date.now();
    const ronda = await request(base, 'POST', `/cuentas/${cuentaId}/pedidos`, {
      token,
      body: cuerpo,
    });
    const msRonda = Date.now() - inicioRonda;
    const rondaOk =
      ronda.ok &&
      ronda.body.estado === 'en_cocina' &&
      ronda.body.origen === 'rpc' &&
      Array.isArray(ronda.body.detalles) &&
      ronda.body.detalles.length === 1;
    push(
      'POST /api/cuentas/:id/pedidos (enviar_cocina)',
      rondaOk,
      rondaOk
        ? `${ronda.body.numero} · ${ronda.body.estado} · origen=${ronda.body.origen} · mov=${ronda.body.movimientos_inventario} · ${msRonda} ms`
        : `${JSON.stringify(ronda.body)} (¿migración 007 aplicada?)`,
    );
    if (!rondaOk) {
      throw new Error(`La ronda no quedó en cocina: ${JSON.stringify(ronda.body)}`);
    }

    const detalleCuenta = await request(base, 'GET', `/cuentas/${cuentaId}`, { token });
    const totalOk =
      detalleCuenta.ok &&
      Number(detalleCuenta.body.total_consolidado) === Number(ronda.body.total);
    push(
      'GET /api/cuentas/:id (total)',
      totalOk,
      `total=${detalleCuenta.body?.total_consolidado} · ronda=${ronda.body.total}`,
    );
    if (!totalOk) {
      throw new Error('El total consolidado no coincide con la ronda.');
    }

    const inventarioDespues = await request(base, 'GET', '/inventario?limit=100', { token });
    const insumoDespues = (inventarioDespues.body.data || []).find(
      (insumo) => insumo.id === candidato.insumoId,
    );
    const stockDespues = insumoDespues ? Number(insumoDespues.stock_actual) : null;
    const stockOk =
      stockInicial !== null && stockDespues !== null && stockDespues < stockInicial;
    push(
      'Stock descontado',
      stockOk,
      `${stockInicial} -> ${stockDespues} (${candidato.platilloNombre})`,
    );
    if (!stockOk) {
      throw new Error('El stock no se descontó al enviar a cocina.');
    }

    const duplicado = await request(base, 'POST', `/cuentas/${cuentaId}/pedidos`, {
      token,
      body: cuerpo,
    });
    const idemOk =
      duplicado.ok &&
      duplicado.body.idempotente === true &&
      duplicado.body.id === ronda.body.id;
    const cuentaTrasDuplicado = await request(base, 'GET', `/cuentas/${cuentaId}`, { token });
    const totalSinDuplicar =
      Number(cuentaTrasDuplicado.body.total_consolidado) === Number(ronda.body.total);
    push(
      'Idempotencia (misma clave)',
      idemOk && totalSinDuplicar,
      idemOk
        ? `id=${duplicado.body.id} · total=${cuentaTrasDuplicado.body.total_consolidado}`
        : JSON.stringify(duplicado.body),
    );
    if (!idemOk || !totalSinDuplicar) {
      throw new Error('La idempotencia no evitó la ronda duplicada.');
    }

    const cancelacion = await request(base, 'POST', `/cuentas/${cuentaId}/cancelar`, {
      token,
      body: { motivo: 'E2E ronda transaccional' },
    });
    const cancelOk = cancelacion.ok && cancelacion.body.estado === 'cancelada';
    push(
      'POST /api/cuentas/:id/cancelar',
      cancelOk,
      cancelOk
        ? `estado=${cancelacion.body.estado} · mov=${cancelacion.body.movimientos_inventario}`
        : JSON.stringify(cancelacion.body),
    );
    if (!cancelOk) {
      throw new Error(`Cancelar cuenta falló: ${JSON.stringify(cancelacion.body)}`);
    }

    const inventarioFinal = await request(base, 'GET', '/inventario?limit=100', { token });
    const insumoFinal = (inventarioFinal.body.data || []).find(
      (insumo) => insumo.id === candidato.insumoId,
    );
    const stockFinal = insumoFinal ? Number(insumoFinal.stock_actual) : null;
    const restaurado =
      stockInicial !== null && stockFinal !== null && Math.abs(stockFinal - stockInicial) < 0.001;
    push('Stock restaurado', restaurado, `${stockDespues} -> ${stockFinal} (inicial ${stockInicial})`);
    if (!restaurado) {
      throw new Error('El stock no se restauró al cancelar la cuenta.');
    }

    const mesaFinal = await request(base, 'GET', `/mesas/${mesaId}`, { token });
    const mesaLiberada = mesaFinal.ok && mesaFinal.body.estado === 'libre';
    push('Mesa liberada', mesaLiberada, `estado=${mesaFinal.body?.estado}`);
    if (!mesaLiberada) {
      throw new Error('La mesa no se liberó tras cancelar la cuenta.');
    }

    console.log('\nE2E ronda transaccional — DB_MODE=supabase');
    console.log('─'.repeat(84));
    for (const item of results) {
      console.log(`${item.ok ? 'OK  ' : 'FAIL'} ${item.name.padEnd(46)} ${item.detail}`);
    }
    console.log('─'.repeat(84));
    console.log(`E2E RONDA OK — ${results.length} comprobaciones (cuenta ${cuentaId} cancelada)`);
  } catch (error) {
    if (cuentaId) {
      await request(base, 'POST', `/cuentas/${cuentaId}/cancelar`, {
        token: (await request(base, 'POST', '/auth/login', {
          body: { email: 'maick@fratellis.pe', password: 'demo123' },
        })).body?.token,
        body: { motivo: 'Limpieza tras fallo E2E' },
      }).catch(() => null);
    }
    console.error('\nE2E RONDA FAIL:', error.message);
    if (logs.trim()) {
      console.error('\nSalida del servidor:\n' + logs.trim());
    }
    process.exitCode = 1;
  } finally {
    await stop(child);
  }
})().catch((error) => {
  console.error('E2E RONDA FAIL:', error.message);
  process.exitCode = 1;
});
