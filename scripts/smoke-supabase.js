'use strict';

// Smoke test del backend con persistencia real en Supabase.
// Uso: npm run smoke:supabase
//
// Requiere que .env tenga SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.
// No imprime secretos. No borra el seed: deja una cuenta cobrada y dos
// movimientos de ajuste de inventario (uno +1 y otro de restauración).

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// La consulta previa (solo lectura) elige un platillo sin ficha técnica para
// no consumir stock del seed en cada ejecución.
process.env.DB_MODE = 'supabase';
const repository = require('../src/data/repository');

async function platilloSinFicha() {
  try {
    const { data: fichas } = await repository.list('fichas_tecnicas', { limit: 100 });
    const conFicha = new Set(fichas.map((ficha) => ficha.platillo_id));
    const { data: platillos } = await repository.list('platillos', {
      filters: { activo: true },
      limit: 100,
    });
    const libre = platillos.find((platillo) => !conFicha.has(platillo.id));
    return libre ? libre.id : (platillos[0] ? platillos[0].id : 1);
  } catch (error) {
    return 2;
  }
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
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api`;
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    env: {
      ...process.env,
      DB_MODE: 'supabase',
      PORT: String(port),
      NODE_ENV: 'test',
      LOG_REQUESTS: '0',
      JWT_SECRET: process.env.JWT_SECRET || 'smoke-supabase-secret-fratellis-32-bytes',
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
  const push = (name, status, detail) => results.push({ name, status, detail });

  let cuentaCobrada = null;
  let ajustes = 0;

  try {
    const health = await waitForHealth(base);
    push('GET /api/health', 200, `${health.status} · modo supabase`);
    if (health.status !== 'ok') {
      throw new Error('Health no devolvió status=ok');
    }

    const login = await request(base, 'POST', '/auth/login', {
      body: { email: 'maick@fratellis.pe', password: 'demo123' },
    });
    push(
      'POST /api/auth/login',
      login.status,
      login.ok ? `roles=${(login.body.roles || []).join('+')}` : JSON.stringify(login.body),
    );
    if (!login.ok || !login.body.token) {
      throw new Error(`Login falló: ${JSON.stringify(login.body)}`);
    }
    const token = login.body.token;

    const mesas = await request(base, 'GET', '/mesas?limit=100', { token });
    push('GET /api/mesas', mesas.status, `${mesas.body?.meta?.total ?? '?'} mesas`);
    if (!mesas.ok) {
      throw new Error(`GET /mesas falló: ${JSON.stringify(mesas.body)}`);
    }
    const mesaLibre = (mesas.body.data || []).find((mesa) => mesa.estado === 'libre');
    if (!mesaLibre) {
      throw new Error(
        'No hay mesas libres en Supabase. Libere una mesa (cobre o cancele su cuenta) y reintente.',
      );
    }

    const cuenta = await request(base, 'POST', '/cuentas', {
      token,
      body: { mesa_id: mesaLibre.id },
    });
    push(
      'POST /api/cuentas',
      cuenta.status,
      cuenta.ok ? `cuenta ${cuenta.body.id} · mesa ${mesaLibre.numero}` : JSON.stringify(cuenta.body),
    );
    if (!cuenta.ok) {
      throw new Error(`Abrir cuenta falló: ${JSON.stringify(cuenta.body)}`);
    }
    const cuentaId = cuenta.body.id;

    // Se elige un platillo sin ficha técnica para no consumir stock del seed.
    const platilloId = await platilloSinFicha();
    const claveRonda = `smoke-supabase-${Date.now()}`;
    const cuerpoRonda = {
      items: [{ platillo_id: platilloId, cantidad: 1 }],
      idempotency_key: claveRonda,
      enviar_cocina: true,
    };
    const ronda = await request(base, 'POST', `/cuentas/${cuentaId}/pedidos`, {
      token,
      body: cuerpoRonda,
    });
    push(
      'POST /api/cuentas/:id/pedidos (enviar_cocina)',
      ronda.status,
      ronda.ok
        ? `pedido ${ronda.body.numero} · estado=${ronda.body.estado} · mov=${ronda.body.movimientos_inventario}`
        : JSON.stringify(ronda.body),
    );
    if (!ronda.ok) {
      throw new Error(`Agregar ronda falló: ${JSON.stringify(ronda.body)}`);
    }
    const pedidoId = ronda.body.id;

    let envio = ronda;
    if (ronda.body.estado !== 'en_cocina') {
      envio = await request(base, 'POST', `/pedidos/${pedidoId}/enviar-cocina`, {
        token,
      });
      push(
        'POST /api/pedidos/:id/enviar-cocina (fallback)',
        envio.status,
        envio.ok ? `estado=${envio.body.estado} · movimientos=${envio.body.movimientos_inventario}` : JSON.stringify(envio.body),
      );
    }
    if (!envio.ok || envio.body.estado !== 'en_cocina') {
      throw new Error(`Enviar a cocina falló: ${JSON.stringify(envio.body)}`);
    }
    const detalleId = (envio.body.detalles || [])[0]?.id;
    if (!detalleId) {
      throw new Error('El pedido no devolvió líneas de detalle.');
    }

    const duplicado = await request(base, 'POST', `/cuentas/${cuentaId}/pedidos`, {
      token,
      body: cuerpoRonda,
    });
    const idempotenteOk =
      duplicado.ok && duplicado.body.idempotente === true && duplicado.body.id === pedidoId;
    push(
      'POST /api/cuentas/:id/pedidos (idempotente)',
      idempotenteOk ? duplicado.status : 500,
      idempotenteOk
        ? `id=${duplicado.body.id} · sin duplicar total`
        : JSON.stringify(duplicado.body),
    );
    if (!idempotenteOk) {
      throw new Error(`La idempotencia falló: ${JSON.stringify(duplicado.body)}`);
    }

    const kds = await request(base, 'GET', '/kds/pedidos', { token });
    const enKds = kds.ok
      ? (kds.body.data || []).find((pedido) => pedido.id === pedidoId)
      : null;
    push(
      'GET /api/kds/pedidos',
      kds.status,
      kds.ok ? `${kds.body.meta.total} pedidos · propio=${Boolean(enKds)}` : JSON.stringify(kds.body),
    );
    if (!kds.ok || !enKds) {
      throw new Error('El pedido enviado a cocina no aparece en el KDS.');
    }

    const listo = await request(
      base,
      'PATCH',
      `/kds/pedidos/${pedidoId}/platos/${detalleId}/estado`,
      { token, body: { estado: 'listo' } },
    );
    push(
      'PATCH /api/kds/pedidos/:pedidoId/platos/:detalleId/estado',
      listo.status,
      listo.ok ? `pedido=${listo.body.pedido_estado} · todas_listas=${listo.body.todas_listas}` : JSON.stringify(listo.body),
    );
    if (!listo.ok) {
      throw new Error(`Marcar plato listo falló: ${JSON.stringify(listo.body)}`);
    }

    const detalleCuenta = await request(base, 'GET', `/cuentas/${cuentaId}`, { token });
    if (!detalleCuenta.ok) {
      throw new Error(`Obtener cuenta falló: ${JSON.stringify(detalleCuenta.body)}`);
    }
    const total = detalleCuenta.body.total_consolidado;

    const cobro = await request(base, 'POST', `/cuentas/${cuentaId}/cobrar`, {
      token,
      body: { metodo: 'efectivo', monto: total },
    });
    push(
      'POST /api/cuentas/:id/cobrar',
      cobro.status,
      cobro.ok ? `comprobante ${cobro.body.comprobante.numero} · total ${cobro.body.comprobante.total}` : JSON.stringify(cobro.body),
    );
    if (!cobro.ok) {
      throw new Error(`Cobrar cuenta falló: ${JSON.stringify(cobro.body)}`);
    }
    cuentaCobrada = {
      id: cuentaId,
      comprobante: cobro.body.comprobante.numero,
      total: cobro.body.comprobante.total,
    };

    const inventario = await request(base, 'GET', '/inventario?limit=100', { token });
    push(
      'GET /api/inventario',
      inventario.status,
      inventario.ok ? `${inventario.body.meta.total} insumos` : JSON.stringify(inventario.body),
    );
    if (!inventario.ok) {
      throw new Error(`Listar inventario falló: ${JSON.stringify(inventario.body)}`);
    }
    const insumo = (inventario.body.data || []).find((item) => item.codigo === 'INS-012')
      || inventario.body.data[0];
    if (!insumo) {
      throw new Error('No hay insumos para probar el ajuste.');
    }
    const stockOriginal = Number(insumo.stock_actual);

    const ajuste = await request(base, 'POST', '/inventario/ajustes', {
      token,
      body: {
        items: [
          {
            insumo_id: insumo.id,
            cantidad: stockOriginal + 1,
            observacion: 'smoke-supabase (+1 temporal)',
          },
        ],
      },
    });
    push(
      'POST /api/inventario/ajustes (+1)',
      ajuste.status,
      ajuste.ok ? `movimientos=${ajuste.body.total}` : JSON.stringify(ajuste.body),
    );
    if (!ajuste.ok || ajuste.body.total !== 1) {
      throw new Error(`Ajuste de inventario falló: ${JSON.stringify(ajuste.body)}`);
    }
    ajustes += 1;

    const restauracion = await request(base, 'POST', '/inventario/ajustes', {
      token,
      body: {
        items: [
          {
            insumo_id: insumo.id,
            cantidad: stockOriginal,
            observacion: 'smoke-supabase (restauración)',
          },
        ],
      },
    });
    push(
      'POST /api/inventario/ajustes (restauración)',
      restauracion.status,
      restauracion.ok ? `movimientos=${restauracion.body.total}` : JSON.stringify(restauracion.body),
    );
    if (!restauracion.ok || restauracion.body.total !== 1) {
      throw new Error(`Restauración de inventario falló: ${JSON.stringify(restauracion.body)}`);
    }
    ajustes += 1;

    let cuadre = await request(base, 'GET', '/cuadre-caja', { token });
    if (cuadre.ok && cuadre.body === null) {
      const apertura = await request(base, 'POST', '/cuadre-caja/apertura', {
        token,
        body: { fondo_inicial: 0, observaciones: 'smoke-supabase' },
      });
      cuadre = apertura;
    }
    push(
      'GET /api/cuadre-caja',
      cuadre.status,
      cuadre.ok && cuadre.body ? `caja ${cuadre.body.estado} · ventas ${cuadre.body.resumen.total_ventas}` : JSON.stringify(cuadre.body),
    );
    if (!cuadre.ok || !cuadre.body) {
      throw new Error(`Consultar cuadre falló: ${JSON.stringify(cuadre.body)}`);
    }

    console.log('\nSmoke test Fratelli\'s — DB_MODE=supabase');
    console.log('─'.repeat(86));
    for (const item of results) {
      console.log(`${String(item.status).padEnd(4)} ${item.name.padEnd(54)} ${item.detail}`);
    }
    console.log('─'.repeat(86));
    console.log(`SMOKE SUPABASE OK — ${results.length} comprobaciones en el puerto ${port}`);
    if (cuentaCobrada) {
      console.log(
        `Datos de prueba: cuenta ${cuentaCobrada.id} cobrada (${cuentaCobrada.comprobante}, S/ ${cuentaCobrada.total}); ` +
        `${ajustes} movimientos de ajuste de inventario. El seed no se borró.`,
      );
    }
  } catch (error) {
    console.error('\nSMOKE SUPABASE FAIL:', error.message);
    if (logs.trim()) {
      console.error('\nSalida del servidor:\n' + logs.trim());
    }
    process.exitCode = 1;
  } finally {
    await stop(child);
  }
})().catch((error) => {
  console.error('SMOKE SUPABASE FAIL:', error.message);
  process.exitCode = 1;
});
