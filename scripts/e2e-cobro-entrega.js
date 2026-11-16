'use strict';

// E2E de la reformulación 2026-11-14:
//   * aviso al mozo por plato listo (bandeja con pedidos parcialmente listos);
//   * entrega por línea;
//   * cobro bloqueado hasta que TODO esté entregado;
//   * IGV calculado sobre el total de la cuenta;
//   * boleta PDF de 80 mm y reimpresión.
//
// Corre contra un servidor en memoria (no toca Supabase).

process.env.DB_MODE = 'memory';

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IGV_PCT = 18;
const IGV_MIN = 70;

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
    } catch {
      // aún levanta
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
  } catch {
    parsed = text;
  }
  return { status: response.status, ok: response.ok, body: parsed };
}

const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

const round2 = (valor) => Math.round((Number(valor) + Number.EPSILON) * 100) / 100;

(async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api`;
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      LOG_REQUESTS: '0',
      JWT_SECRET: 'e2e-cobro-entrega-secret-32-bytes',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`[e2e] servidor terminó con código ${code} (${signal || 'sin señal'})`);
    }
  });

  try {
    await waitForHealth(base);

    const login = await request(base, 'POST', '/auth/login', {
      body: { email: 'maick@fratellis.pe', password: 'demo123' },
    });
    if (!login.ok) {
      throw new Error(`Login falló: ${JSON.stringify(login.body)}`);
    }
    const token = login.body.token;

    const mesas = await request(base, 'GET', '/venta-local/mesas', { token });
    const libre = (mesas.body.data || []).find(
      (mesa) => mesa.estado === 'libre' && mesa.activa !== false,
    );
    if (!libre) {
      throw new Error('No hay mesas libres para el e2e.');
    }

    const cuenta = await request(base, 'POST', '/cuentas', {
      token,
      body: { mesa_id: libre.id },
    });
    if (!cuenta.ok) {
      throw new Error(`Abrir cuenta falló: ${JSON.stringify(cuenta.body)}`);
    }
    const cuentaId = cuenta.body.id;

    const carta = await request(base, 'GET', '/platillos?limit=100', { token });
    const platillos = (carta.body.data || [])
      .filter((platillo) => platillo.activo && Number(platillo.precio_venta) > 0)
      .sort((a, b) => Number(b.precio_venta) - Number(a.precio_venta));
    if (platillos.length < 2) {
      throw new Error('La carta no tiene platillos suficientes.');
    }
    const [primero, segundo] = platillos;

    const ronda = await request(base, 'POST', `/cuentas/${cuentaId}/pedidos`, {
      token,
      body: {
        items: [
          { platillo_id: primero.id, cantidad: 1 },
          { platillo_id: segundo.id, cantidad: 1 },
        ],
        idempotency_key: `e2e-cobro-${Date.now()}`,
        enviar_cocina: true,
      },
    });
    if (!ronda.ok) {
      throw new Error(`Agregar ronda falló: ${JSON.stringify(ronda.body)}`);
    }
    const pedidoId = ronda.body.id;
    const [linea1, linea2] = ronda.body.detalles || [];
    if (!linea1 || !linea2) {
      throw new Error('La ronda no devolvió dos líneas.');
    }

    // 1. Un plato listo → el aviso aparece aunque el otro siga pendiente.
    await request(base, 'PATCH', `/kds/pedidos/${pedidoId}/platos/${linea1.id}/estado`, {
      token,
      body: { estado: 'listo' },
    });
    const bandejaParcial = await request(
      base,
      'GET',
      '/pedidos-listos?page=1&limit=100&desde=2026-01-01',
      { token },
    );
    const avisoParcial = (bandejaParcial.body.data || []).find((p) => p.id === pedidoId);
    const lineasListas = avisoParcial
      ? avisoParcial.detalles.filter(
          (detalle) => detalle.estado_preparacion === 'listo' && !detalle.entregado_en,
        ).length
      : 0;
    check(
      'aviso parcial al mozo',
      Boolean(avisoParcial) && lineasListas === 1,
      avisoParcial ? `pedido=${pedidoId} · listas=${lineasListas}` : 'no apareció en la bandeja',
    );
    if (!avisoParcial || lineasListas !== 1) {
      throw new Error('El aviso por plato no apareció en /pedidos-listos.');
    }

    // 2. Cobro bloqueado con platos sin entregar.
    const detalleAntes = await request(base, 'GET', `/cuentas/${cuentaId}`, { token });
    const bloqueado = await request(base, 'POST', `/cuentas/${cuentaId}/cobrar`, {
      token,
      body: { metodo: 'efectivo', monto: detalleAntes.body.total_consolidado },
    });
    check(
      'cobro bloqueado sin entrega',
      bloqueado.status === 409 && bloqueado.body?.error?.code === 'PLATOS_NO_ENTREGADOS',
      `HTTP ${bloqueado.status} · ${bloqueado.body?.error?.code}`,
    );
    if (bloqueado.status !== 409 || bloqueado.body?.error?.code !== 'PLATOS_NO_ENTREGADOS') {
      throw new Error(`El cobro debía bloquearse: ${JSON.stringify(bloqueado.body)}`);
    }

    // 3. Entregar solo el plato listo → el aviso desaparece (el otro no está listo).
    const entrega1 = await request(
      base,
      'PATCH',
      `/kds/pedidos/${pedidoId}/platos/${linea1.id}/entregar`,
      { token, body: {} },
    );
    const bandejaTrasEntrega = await request(
      base,
      'GET',
      '/pedidos-listos?page=1&limit=100&desde=2026-01-01',
      { token },
    );
    const sigue = (bandejaTrasEntrega.body.data || []).some((p) => p.id === pedidoId);
    check(
      'entrega por línea sin cerrar el pedido',
      entrega1.ok && !sigue,
      `HTTP ${entrega1.status} · en bandeja=${sigue}`,
    );

    // 4. El segundo plato se marca listo y se entrega la ronda completa.
    await request(base, 'PATCH', `/kds/pedidos/${pedidoId}/platos/${linea2.id}/estado`, {
      token,
      body: { estado: 'listo' },
    });
    const entrega2 = await request(base, 'PATCH', `/kds/pedidos/${pedidoId}/entregar`, {
      token,
      body: {},
    });
    check(
      'entrega completa del pedido',
      entrega2.ok && entrega2.body?.estado_entrega === 'entregado',
      `HTTP ${entrega2.status} · estado_entrega=${entrega2.body?.estado_entrega}`,
    );

    // 5. IGV sobre el total de la cuenta.
    const detalle = await request(base, 'GET', `/cuentas/${cuentaId}`, { token });
    const subtotal = Number(detalle.body.subtotal);
    const igv = Number(detalle.body.igv);
    const total = Number(detalle.body.total_consolidado);
    const igvEsperado = subtotal >= IGV_MIN ? round2((subtotal * IGV_PCT) / 100) : 0;
    const totalEsperado = round2(subtotal + igvEsperado);
    check(
      'IGV sobre el total de la cuenta',
      igv === igvEsperado && total === totalEsperado,
      `subtotal=${subtotal} · igv=${igv} (esperado ${igvEsperado}) · total=${total}`,
    );
    if (igv !== igvEsperado || total !== totalEsperado) {
      throw new Error('El IGV de la cuenta no coincide con la regla.');
    }

    // 6. Cobro y boleta PDF 80 mm.
    const cobro = await request(base, 'POST', `/cuentas/${cuentaId}/cobrar`, {
      token,
      body: { metodo: 'efectivo', monto: total },
    });
    check(
      'cobro con todo entregado',
      cobro.ok && Boolean(cobro.body?.comprobante?.numero),
      cobro.ok ? `comprobante=${cobro.body.comprobante.numero}` : JSON.stringify(cobro.body),
    );
    if (!cobro.ok) {
      throw new Error(`El cobro falló: ${JSON.stringify(cobro.body)}`);
    }

    const pdf = await fetch(`${base}/cuentas/${cuentaId}/comprobante/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const pdfBuffer = Buffer.from(await pdf.arrayBuffer());
    const pdfTexto = pdfBuffer.toString('latin1');
    check(
      'boleta PDF 80 mm',
      pdf.ok &&
        pdfBuffer.subarray(0, 4).toString() === '%PDF' &&
        pdfTexto.includes('226.77'),
      `${pdfBuffer.length} bytes · mediaBox 80mm=${pdfTexto.includes('226.77')}`,
    );

    const reimpresion = await fetch(`${base}/cuentas/${cuentaId}/comprobante/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const reimpresionBuffer = Buffer.from(await reimpresion.arrayBuffer());
    check(
      'reimpresión de boleta',
      reimpresion.ok && reimpresionBuffer.subarray(0, 4).toString() === '%PDF',
      `${reimpresionBuffer.length} bytes`,
    );

    const doble = await request(base, 'POST', `/cuentas/${cuentaId}/cobrar`, {
      token,
      body: { metodo: 'efectivo', monto: total },
    });
    check(
      'doble cobro bloqueado',
      doble.status === 409 && doble.body?.error?.code === 'CUENTA_YA_COBRADA',
      `HTTP ${doble.status} · ${doble.body?.error?.code}`,
    );
  } finally {
    child.kill();
  }

  const fallos = results.filter((resultado) => !resultado.ok);
  console.log(`\nRESUMEN: ${results.length - fallos.length}/${results.length} comprobaciones`);
  if (fallos.length > 0) {
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error(`\nERROR: ${error.message}`);
  process.exitCode = 1;
});
