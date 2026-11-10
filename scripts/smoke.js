'use strict';

// Los smoke/verify base se ejecutan en memoria; usa SMOKE_DB_MODE=supabase para probar persistencia.
process.env.DB_MODE = process.env.SMOKE_DB_MODE || 'memory';

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');

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
  if (options.headers) {
    Object.assign(headers, options.headers);
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${base}${endpoint}`, { method, headers, body });
  if (options.binary) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return { status: response.status, ok: response.ok, body: null, buffer, headers: response.headers };
  }
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (error) {
    parsed = text;
  }
  return { status: response.status, ok: response.ok, body: parsed, headers: response.headers };
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

    // ---- Login por alias (`usuarios.usuario`), no por correo ----
    const loginAlias = await request(base, 'POST', '/auth/login', {
      body: { usuario: 'maick', password: 'demo123' },
    });
    const loginAliasOk =
      loginAlias.ok &&
      Boolean(loginAlias.body.token) &&
      loginAlias.body.usuario &&
      loginAlias.body.usuario.usuario === 'maick' &&
      loginAlias.body.usuario.email === 'maick@fratellis.pe';
    results.push({
      name: 'POST /api/auth/login (por usuario)',
      status: loginAliasOk ? 200 : 500,
      detail: loginAliasOk
        ? `usuario=${loginAlias.body.usuario.usuario} · roles=${(loginAlias.body.roles || []).join('+')}`
        : JSON.stringify(loginAlias.body),
    });
    if (!loginAliasOk) {
      throw new Error(`El login por alias no devolvió el usuario real: ${JSON.stringify(loginAlias.body)}`);
    }


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

    // ---- Configuración persistente: tarifa y flags de canales/pagos ----
    const configInicial = await request(base, 'GET', '/configuracion', { token });
    const rawInicial = configInicial.body && configInicial.body.raw ? configInicial.body.raw : null;
    const configGetOk =
      configInicial.status === 200 &&
      rawInicial !== null &&
      Object.prototype.hasOwnProperty.call(rawInicial, 'tarifa_delivery');
    results.push({
      name: 'GET /api/configuracion (raw.tarifa_delivery)',
      status: configGetOk ? 200 : 500,
      detail: configGetOk
        ? `tarifa_delivery=${rawInicial.tarifa_delivery} · redondeo=${rawInicial.redondeo_activo} · aviso_mozo=${rawInicial.aviso_mozo_activo}`
        : JSON.stringify(configInicial.body),
    });
    if (!configGetOk) {
      throw new Error(`GET /api/configuracion no devolvió raw.tarifa_delivery: ${JSON.stringify(configInicial.body)}`);
    }

    const configEsperada = (raw) =>
      Boolean(raw) &&
      Number(raw.tarifa_delivery) === 7 &&
      String(raw.redondeo_activo) === '1' &&
      String(raw.canal_local) === '0' &&
      String(raw.pago_yape) === '0';
    const configPut = await request(base, 'PUT', '/configuracion', {
      token,
      body: { tarifa_delivery: 7, redondeo_activo: '1', canal_local: '0', pago_yape: '0' },
    });
    const configPutOk =
      configPut.status === 200 && configEsperada(configPut.body && configPut.body.raw);
    results.push({
      name: 'PUT /api/configuracion (tarifa + flags)',
      status: configPutOk ? 200 : 500,
      detail: configPutOk
        ? `tarifa=${configPut.body.raw.tarifa_delivery} · redondeo=${configPut.body.raw.redondeo_activo} · canal_local=${configPut.body.raw.canal_local} · pago_yape=${configPut.body.raw.pago_yape}`
        : JSON.stringify(configPut.body),
    });
    if (!configPutOk) {
      throw new Error(`PUT /api/configuracion no devolvió los valores normalizados: ${JSON.stringify(configPut.body)}`);
    }

    const configReleida = await request(base, 'GET', '/configuracion', { token });
    const configReleidaOk =
      configReleida.status === 200
      && configEsperada(configReleida.body && configReleida.body.raw);
    results.push({
      name: 'GET /api/configuracion (relectura tras PUT)',
      status: configReleidaOk ? 200 : 500,
      detail: configReleidaOk
        ? `tarifa=${configReleida.body.raw.tarifa_delivery} · redondeo=${configReleida.body.raw.redondeo_activo} · canal_local=${configReleida.body.raw.canal_local} · pago_yape=${configReleida.body.raw.pago_yape}`
        : JSON.stringify(configReleida.body),
    });
    if (!configReleidaOk) {
      throw new Error(`La configuración no se mantuvo tras releerla: ${JSON.stringify(configReleida.body)}`);
    }

    // Restaurar los valores originales para no contaminar el resto del smoke.
    const restauracion = {};
    if (rawInicial) {
      if (rawInicial.tarifa_delivery !== undefined) {
        restauracion.tarifa_delivery = rawInicial.tarifa_delivery;
      }
      for (const clave of ['redondeo_activo', 'canal_local', 'pago_yape']) {
        if (rawInicial[clave] !== undefined) {
          restauracion[clave] = rawInicial[clave];
        }
      }
    }
    if (Object.keys(restauracion).length > 0) {
      const configRestaurada = await request(base, 'PUT', '/configuracion', {
        token,
        body: restauracion,
      });
      const restauracionOk = configRestaurada.status === 200;
      results.push({
        name: 'PUT /api/configuracion (restaurar originales)',
        status: restauracionOk ? 200 : 500,
        detail: restauracionOk
          ? `tarifa=${configRestaurada.body.raw.tarifa_delivery} · redondeo=${configRestaurada.body.raw.redondeo_activo} · canal_local=${configRestaurada.body.raw.canal_local} · pago_yape=${configRestaurada.body.raw.pago_yape}`
          : JSON.stringify(configRestaurada.body),
      });
      if (!restauracionOk) {
        throw new Error(`No se pudieron restaurar los valores originales de configuración: ${JSON.stringify(configRestaurada.body)}`);
      }
    }

    // ---- Fase 3: ETag/304 en tablero y resumen agregado ----
    const tablero1 = await request(base, 'GET', '/venta-local/tablero', { token });
    const tableroEtag = tablero1.headers.get('etag');
    const tablero2 = tableroEtag
      ? await request(base, 'GET', '/venta-local/tablero', {
        token,
        headers: { 'If-None-Match': tableroEtag },
      })
      : { status: 0, body: null };
    const resumenTablero = tablero1.body && tablero1.body.meta ? tablero1.body.meta.resumen : null;
    const tableroEtagOk =
      tablero1.status === 200 &&
      typeof tableroEtag === 'string' &&
      tableroEtag.startsWith('W/"') &&
      tablero2.status === 304 &&
      resumenTablero &&
      typeof resumenTablero.mesas_total === 'number' &&
      typeof resumenTablero.mesas_ocupadas === 'number' &&
      typeof resumenTablero.mesas_libres === 'number' &&
      typeof resumenTablero.cuentas_abiertas === 'number' &&
      typeof resumenTablero.total_abierto === 'number' &&
      resumenTablero.mesas_total === resumenTablero.mesas_ocupadas + resumenTablero.mesas_libres;
    results.push({
      name: 'GET /api/venta-local/tablero (ETag/304 + resumen)',
      status: tableroEtagOk ? 304 : 500,
      detail: tableroEtagOk
        ? `${tableroEtag.slice(0, 14)}… · 1ª=${tablero1.status}, 2ª=${tablero2.status} · mesas ${resumenTablero.mesas_ocupadas}/${resumenTablero.mesas_total}`
        : `1ª=${tablero1.status}, etag=${tableroEtag}, 2ª=${tablero2.status}, resumenTablero=${JSON.stringify(resumenTablero)}`,
    });
    if (!tableroEtagOk) {
      throw new Error(
        `El tablero no respondió con ETag/304 ni meta.resumen: ${JSON.stringify({ status1: tablero1.status, etag: tableroEtag, status2: tablero2.status, resumen: resumenTablero })}`,
      );
    }

    // ---- Dashboard DB-aware: KPIs numéricos + ETag/304 ----
    const dashboard1 = await request(base, 'GET', '/dashboard', { token });
    const dashboardEtag = dashboard1.headers.get('etag');
    const dashboard2 = dashboardEtag
      ? await request(base, 'GET', '/dashboard', {
        token,
        headers: { 'If-None-Match': dashboardEtag },
      })
      : { status: 0, body: null };
    const dashboardOk =
      dashboard1.status === 200 &&
      dashboard1.body &&
      dashboard1.body.kpis &&
      typeof dashboard1.body.kpis.ventas === 'number' &&
      typeof dashboard1.body.kpis.pedidos === 'number' &&
      typeof dashboard1.body.ventas_ayer === 'number' &&
      Array.isArray(dashboard1.body.serie_semana) &&
      dashboard1.body.serie_semana.length === 7 &&
      typeof dashboardEtag === 'string' &&
      dashboardEtag.startsWith('W/"') &&
      dashboard2.status === 304 &&
      Array.isArray(dashboard1.body.top_platillos);
    results.push({
      name: 'GET /api/dashboard (ETag/304 + KPIs)',
      status: dashboardOk ? 304 : 500,
      detail: dashboardOk
        ? `${dashboardEtag.slice(0, 14)}… · 1ª=${dashboard1.status}, 2ª=${dashboard2.status} · ventas=S/ ${dashboard1.body.kpis.ventas} · ayer=S/ ${dashboard1.body.ventas_ayer} · serie=${dashboard1.body.serie_semana.length}d`
        : `1ª=${dashboard1.status}, etag=${dashboardEtag}, 2ª=${dashboard2.status}, body=${JSON.stringify(dashboard1.body)}`,
    });
    if (!dashboardOk) {
      throw new Error(
        `El dashboard no respondió con KPIs numéricos y ETag/304: ${JSON.stringify({ status1: dashboard1.status, etag: dashboardEtag, status2: dashboard2.status, body: dashboard1.body })}`,
      );
    }

    // ---- Pagos del día (caja/comandas): lista + totales por método ----
    const pagosDia = await request(base, 'GET', '/pagos', { token });
    const pagosDiaOk =
      pagosDia.status === 200 &&
      pagosDia.body &&
      Array.isArray(pagosDia.body.data) &&
      typeof pagosDia.body.total === 'number' &&
      typeof pagosDia.body.cantidad === 'number' &&
      Array.isArray(pagosDia.body.por_metodo) &&
      pagosDia.body.data.every(
        (pago) =>
          typeof pago.monto === 'number' &&
          typeof pago.metodo === 'string' &&
          typeof pago.fecha === 'string',
      );
    results.push({
      name: 'GET /api/pagos (pagos del día)',
      status: pagosDiaOk ? 200 : 500,
      detail: pagosDiaOk
        ? `fecha=${pagosDia.body.fecha} · cantidad=${pagosDia.body.cantidad} · total=S/ ${pagosDia.body.total} · métodos=${pagosDia.body.por_metodo.length}`
        : JSON.stringify(pagosDia.body),
    });
    if (!pagosDiaOk) {
      throw new Error(
        `GET /api/pagos no devolvió data/total/por_metodo válidos: ${JSON.stringify(pagosDia.body)}`,
      );
    }

    const inventarioPagina = await request(base, 'GET', '/inventario?page=1&limit=5', { token });
    const inventarioMetaOk =
      inventarioPagina.ok &&
      Array.isArray(inventarioPagina.body.data) &&
      inventarioPagina.body.data.length <= 5 &&
      typeof inventarioPagina.body.meta?.total_insumos === 'number' &&
      typeof inventarioPagina.body.meta?.valor_inventario === 'number';
    results.push({
      name: 'GET /api/inventario (paginado + meta)',
      status: inventarioMetaOk ? 200 : 500,
      detail: inventarioMetaOk
        ? `${inventarioPagina.body.data.length}/${inventarioPagina.body.meta.total_insumos} · alertas ${inventarioPagina.body.meta.total_alertas}`
        : JSON.stringify(inventarioPagina.body),
    });
    if (!inventarioMetaOk) {
      throw new Error('El inventario no devolvió paginación/meta completos.');
    }

    const consumoInventario = await request(base, 'GET', '/inventario/consumo?dias=7', { token });
    const consumoOk =
      consumoInventario.ok &&
      Array.isArray(consumoInventario.body.data) &&
      consumoInventario.body.dias === 7 &&
      typeof consumoInventario.body.desde === 'string' &&
      typeof consumoInventario.body.hasta === 'string' &&
      consumoInventario.body.data.every(
        (fila) =>
          typeof fila.insumo_id === 'number' &&
          typeof fila.consumo === 'number' &&
          typeof fila.promedio_diario === 'number',
      );
    results.push({
      name: 'GET /api/inventario/consumo?dias=7',
      status: consumoOk ? 200 : 500,
      detail: consumoOk
        ? `${consumoInventario.body.data.length} insumos · ${consumoInventario.body.desde} -> ${consumoInventario.body.hasta}`
        : JSON.stringify(consumoInventario.body),
    });
    if (!consumoOk) {
      throw new Error(
        `El consumo de inventario no devolvió data/dias válidos: ${JSON.stringify(consumoInventario.body)}`,
      );
    }

    // ---- Fichas y platillos: escrituras (PATCH /platillos, PUT /ficha) ----
    const platillosPagina = await request(base, 'GET', '/platillos?limit=50', { token });
    const platilloSmoke = (platillosPagina.body.data || []).find(
      (platillo) => platillo.ficha && Array.isArray(platillo.ingredientes) && platillo.ingredientes.length > 0,
    );
    if (!platilloSmoke) {
      throw new Error('No hay un platillo con ficha para la prueba de escritura.');
    }
    const precioOriginal = Number(platilloSmoke.precio_venta);
    const precioNuevo = Number((precioOriginal + 1).toFixed(2));
    const platilloActualizado = await request(base, 'PATCH', `/platillos/${platilloSmoke.id}`, {
      token,
      body: { precio_venta: precioNuevo, descripcion: 'Descripción smoke' },
    });
    const platilloActualizadoOk =
      platilloActualizado.ok &&
      platilloActualizado.body.id === platilloSmoke.id &&
      Number(platilloActualizado.body.precio_venta) === precioNuevo &&
      platilloActualizado.body.descripcion === 'Descripción smoke' &&
      typeof platilloActualizado.body.categoria === 'string' &&
      Array.isArray(platilloActualizado.body.ingredientes);
    results.push({
      name: 'PATCH /api/platillos/:id',
      status: platilloActualizadoOk ? 200 : 500,
      detail: platilloActualizadoOk
        ? `id=${platilloSmoke.id} · precio ${precioOriginal} -> ${platilloActualizado.body.precio_venta}`
        : JSON.stringify(platilloActualizado.body),
    });
    if (!platilloActualizadoOk) {
      throw new Error(`No se actualizó el platillo: ${JSON.stringify(platilloActualizado.body)}`);
    }

    const insumoFichaA = inventarioPagina.body.data[0].id;
    const insumoFichaB = inventarioPagina.body.data[1].id;
    const fichaGuardada = await request(base, 'PUT', `/platillos/${platilloSmoke.id}/ficha`, {
      token,
      body: {
        porciones_rendimiento: 2,
        notas: 'Ficha smoke',
        ingredientes: [
          { insumo_id: insumoFichaA, cantidad: 1.5 },
          { insumo_id: insumoFichaB, cantidad: 0.5 },
        ],
      },
    });
    const fichaGuardadaOk =
      fichaGuardada.ok &&
      fichaGuardada.body.ficha &&
      Number(fichaGuardada.body.ficha.porciones_rendimiento) === 2 &&
      fichaGuardada.body.ficha.notas === 'Ficha smoke' &&
      Number(fichaGuardada.body.ficha.costo_total) > 0 &&
      Array.isArray(fichaGuardada.body.ingredientes) &&
      fichaGuardada.body.ingredientes.length === 2 &&
      fichaGuardada.body.ingredientes.every(
        (item) => typeof item.insumo === 'string' && typeof item.costo_linea === 'number',
      );
    results.push({
      name: 'PUT /api/platillos/:id/ficha',
      status: fichaGuardadaOk ? 200 : 500,
      detail: fichaGuardadaOk
        ? `id=${platilloSmoke.id} · ${fichaGuardada.body.ingredientes.length} ingredientes · costo=${fichaGuardada.body.ficha.costo_total}`
        : JSON.stringify(fichaGuardada.body),
    });
    if (!fichaGuardadaOk) {
      throw new Error(`No se guardó la ficha técnica: ${JSON.stringify(fichaGuardada.body)}`);
    }

    // Restaura el estado del seed (el smoke en memoria no debe dejar residuos).
    await request(base, 'PATCH', `/platillos/${platilloSmoke.id}`, {
      token,
      body: { precio_venta: precioOriginal, descripcion: platilloSmoke.descripcion },
    });
    await request(base, 'PUT', `/platillos/${platilloSmoke.id}/ficha`, {
      token,
      body: {
        porciones_rendimiento: platilloSmoke.ficha.porciones_rendimiento,
        notas: platilloSmoke.ficha.notas,
        ingredientes: platilloSmoke.ingredientes.map((item) => ({
          insumo_id: item.insumo_id,
          cantidad: item.cantidad,
        })),
      },
    });

    // ---- Catálogos de fichas: categorías e ingredientes (DB-aware) ----
    const categoriasPlatillo = await request(base, 'GET', '/categorias-platillo', { token });
    const categoriasOk =
      categoriasPlatillo.ok &&
      Array.isArray(categoriasPlatillo.body.data) &&
      categoriasPlatillo.body.data.length > 0 &&
      categoriasPlatillo.body.data.every(
        (categoria) => typeof categoria.id === 'number' && typeof categoria.nombre === 'string',
      ) &&
      typeof categoriasPlatillo.body.meta?.total === 'number';
    results.push({
      name: 'GET /api/categorias-platillo',
      status: categoriasOk ? 200 : 500,
      detail: categoriasOk
        ? `${categoriasPlatillo.body.data.length} categorías · ${categoriasPlatillo.body.data[0].nombre}`
        : JSON.stringify(categoriasPlatillo.body),
    });
    if (!categoriasOk) {
      throw new Error(
        `Las categorías de platillo no devolvieron [{id, nombre}]: ${JSON.stringify(categoriasPlatillo.body)}`,
      );
    }

    const ingredientesFicha = await request(base, 'GET', '/ingredientes?limit=10', { token });
    const ingredientesOk =
      ingredientesFicha.ok &&
      Array.isArray(ingredientesFicha.body.data) &&
      ingredientesFicha.body.data.length > 0 &&
      ingredientesFicha.body.data.every(
        (item) =>
          typeof item.id === 'number' &&
          typeof item.nombre === 'string' &&
          typeof item.stock_actual === 'number' &&
          typeof item.costo_promedio === 'number',
      ) &&
      typeof ingredientesFicha.body.meta?.total === 'number';
    results.push({
      name: 'GET /api/ingredientes (stock/costo)',
      status: ingredientesOk ? 200 : 500,
      detail: ingredientesOk
        ? `${ingredientesFicha.body.data.length}/${ingredientesFicha.body.meta.total} insumos · stock/costo numéricos`
        : JSON.stringify(ingredientesFicha.body),
    });
    if (!ingredientesOk) {
      throw new Error(
        `Los ingredientes no devolvieron stock_actual/costo_promedio numéricos: ${JSON.stringify(ingredientesFicha.body)}`,
      );
    }

    const listosPagina = await request(
      base,
      'GET',
      '/pedidos-listos?page=1&limit=5&desde=2026-01-01',
      { token },
    );
    const listosMetaOk =
      listosPagina.ok &&
      Array.isArray(listosPagina.body.data) &&
      listosPagina.body.data.length <= 5 &&
      typeof listosPagina.body.meta?.total === 'number' &&
      typeof listosPagina.body.meta?.pages === 'number';
    results.push({
      name: 'GET /api/pedidos-listos (paginado)',
      status: listosMetaOk ? 200 : 500,
      detail: listosMetaOk
        ? `${listosPagina.body.data.length}/${listosPagina.body.meta.total} · páginas ${listosPagina.body.meta.pages}`
        : JSON.stringify(listosPagina.body),
    });
    if (!listosMetaOk) {
      throw new Error('Pedidos listos no respetó page/limit/desde.');
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

    // ---- KDS v2: estaciones, cursos, all-day y entrega por línea ----
    const cartaKds = await request(base, 'GET', '/platillos?limit=100', { token });
    const platillosKds = Array.isArray(cartaKds.body && cartaKds.body.data)
      ? cartaKds.body.data
      : [];
    const porNombreKds = new Map(platillosKds.map((item) => [item.nombre, item]));
    const polloKds = porNombreKds.get('1/4 Pollo a la brasa');
    const bebidaKds = porNombreKds.get('Inca Kola 1.5 L');
    if (!cartaKds.ok || !polloKds || !bebidaKds) {
      throw new Error('El menú no expone los platillos necesarios para el smoke del KDS v2.');
    }

    const rondaKds = await request(base, 'POST', `/cuentas/${cuentaId}/pedidos`, {
      token,
      body: {
        items: [
          { platillo_id: polloKds.id, cantidad: 1 },
          { platillo_id: bebidaKds.id, cantidad: 1 },
        ],
        idempotency_key: `smoke-${Date.now()}-kds-mixto`,
        enviar_cocina: true,
      },
    });
    const kds1 = await request(base, 'GET', '/kds/pedidos', { token });
    const pedidoKds1 = (kds1.body.data || []).find((pedido) => pedido.id === rondaKds.body.id);
    const lineaBebida = pedidoKds1
      ? pedidoKds1.detalles.find((detalle) => detalle.platillo_id === bebidaKds.id)
      : null;
    const lineaPollo = pedidoKds1
      ? pedidoKds1.detalles.find((detalle) => detalle.platillo_id === polloKds.id)
      : null;
    const bandeja1 = await request(base, 'GET', '/pedidos-listos?page=1&limit=100&desde=2026-01-01', {
      token,
    });
    const enBandeja1 = (bandeja1.body.data || []).some((pedido) => pedido.id === rondaKds.body.id);
    const bebidaNaceListaOk =
      rondaKds.status === 201 &&
      Boolean(pedidoKds1) &&
      Boolean(lineaBebida) &&
      Boolean(lineaPollo) &&
      lineaBebida.estado_preparacion === 'listo' &&
      lineaBebida.estacion === 'bar' &&
      lineaBebida.curso === 'fondo' &&
      lineaPollo.estado_preparacion !== 'listo' &&
      lineaPollo.estacion === 'parrilla' &&
      pedidoKds1.listo === false &&
      pedidoKds1.todos_entregados === false &&
      pedidoKds1.estado_entrega === 'pendiente' &&
      !enBandeja1;
    results.push({
      name: 'KDS v2: bebida nace lista y no bloquea',
      status: bebidaNaceListaOk ? 200 : 500,
      detail: bebidaNaceListaOk
        ? `pedido=${rondaKds.body.id} · bebida=${lineaBebida.estado_preparacion}/bar · pollo=${lineaPollo.estado_preparacion}`
        : JSON.stringify({ ronda: rondaKds.body, pedidoKds: pedidoKds1, enBandeja: enBandeja1 }),
    });
    if (!bebidaNaceListaOk) {
      throw new Error(
        `La bebida no nació lista ni quedó fuera de la bandeja: ${JSON.stringify({ pedidoKds: pedidoKds1, enBandeja: enBandeja1 })}`,
      );
    }

    const allDayKds1 = kds1.body.meta && kds1.body.meta.all_day;
    const sumaAllDayKds1 = (kds1.body.data || [])
      .filter((pedido) => pedido.estado_pago !== 'pagado' && !pedido.entregado_en)
      .reduce(
        (total, pedido) => total + pedido.detalles
          .filter((detalle) => !detalle.entregado_en)
          .reduce((suma, detalle) => suma + Number(detalle.cantidad), 0),
        0,
      );
    const allDayOk =
      Array.isArray(allDayKds1) &&
      typeof kds1.body.meta.all_day_total === 'number' &&
      kds1.body.meta.all_day_total === sumaAllDayKds1 &&
      allDayKds1.every(
        (fila) =>
          typeof fila.platillo_id === 'number' &&
          typeof fila.estacion === 'string' &&
          typeof fila.cantidad === 'number' &&
          typeof fila.en_fuego === 'number',
      );
    results.push({
      name: 'GET /api/kds/pedidos (all-day coherente)',
      status: allDayOk ? 200 : 500,
      detail: allDayOk
        ? `${allDayKds1.length} platos · total=${kds1.body.meta.all_day_total}`
        : JSON.stringify({ allDay: allDayKds1, total: kds1.body.meta && kds1.body.meta.all_day_total, suma: sumaAllDayKds1 }),
    });
    if (!allDayOk) {
      throw new Error('El all-day del KDS no coincide con las líneas activas no entregadas.');
    }

    const rondaIncompleta = await request(base, 'PATCH', `/kds/pedidos/${rondaKds.body.id}/entregar`, {
      token,
      body: {},
    });
    const detallesPendientes = rondaIncompleta.body?.error?.details;
    const rondaIncompletaOk =
      rondaIncompleta.status === 409 &&
      rondaIncompleta.body?.error?.code === 'PLATOS_PENDIENTES' &&
      Array.isArray(detallesPendientes) &&
      detallesPendientes.some((detalle) => typeof detalle.pendientes === 'number' && detalle.pendientes > 0);
    results.push({
      name: 'PATCH /api/kds/pedidos/:id/entregar (409 PLATOS_PENDIENTES)',
      status: rondaIncompletaOk ? 409 : 500,
      detail: rondaIncompletaOk
        ? `code=${rondaIncompleta.body.error.code} · pendientes=${detallesPendientes[0].pendientes}`
        : JSON.stringify(rondaIncompleta.body),
    });
    if (!rondaIncompletaOk) {
      throw new Error(
        `Entregar una ronda incompleta debía devolver 409 PLATOS_PENDIENTES: ${JSON.stringify(rondaIncompleta.body)}`,
      );
    }

    const entregaLineaKds = await request(
      base,
      'PATCH',
      `/kds/pedidos/${rondaKds.body.id}/platos/${lineaBebida.id}/entregar`,
      { token, body: {} },
    );
    const kds2 = await request(base, 'GET', '/kds/pedidos', { token });
    const pedidoKds2 = (kds2.body.data || []).find((pedido) => pedido.id === rondaKds.body.id);
    const lineaBebida2 = pedidoKds2
      ? pedidoKds2.detalles.find((detalle) => detalle.id === lineaBebida.id)
      : null;
    const entregaLineaOk =
      entregaLineaKds.status === 200 &&
      entregaLineaKds.body?.pedido_estado_entrega === 'pendiente' &&
      entregaLineaKds.body?.todos_entregados === false &&
      Boolean(entregaLineaKds.body?.detalle?.entregado_en) &&
      Boolean(lineaBebida2) &&
      Boolean(lineaBebida2.entregado_en) &&
      pedidoKds2.todos_entregados === false;
    results.push({
      name: 'PATCH /api/kds/.../platos/:detalleId/entregar (línea)',
      status: entregaLineaOk ? 200 : 500,
      detail: entregaLineaOk
        ? `detalle=${lineaBebida.id} · entregado_en=${entregaLineaKds.body.detalle.entregado_en}`
        : JSON.stringify({ respuesta: entregaLineaKds.body, pedidoKds: pedidoKds2 }),
    });
    if (!entregaLineaOk) {
      throw new Error('La entrega de una línea no persistió en el KDS.');
    }

    const todoListoKds = await request(base, 'PATCH', `/kds/pedidos/${rondaKds.body.id}/listo`, {
      token,
      body: {},
    });
    const bandeja2 = await request(base, 'GET', '/pedidos-listos?page=1&limit=100&desde=2026-01-01', {
      token,
    });
    const pedidoBandeja2 = (bandeja2.body.data || []).find((pedido) => pedido.id === rondaKds.body.id);
    const todoListoOk =
      todoListoKds.status === 200 &&
      todoListoKds.body?.estado === 'servido' &&
      todoListoKds.body?.todas_listas === true &&
      Boolean(pedidoBandeja2) &&
      pedidoBandeja2.todos_entregados === false;
    results.push({
      name: 'PATCH /api/kds/pedidos/:id/listo (pedido servido)',
      status: todoListoOk ? 200 : 500,
      detail: todoListoOk
        ? `pedido=${rondaKds.body.id} · estado=${todoListoKds.body.estado} · en bandeja`
        : JSON.stringify({ todoListo: todoListoKds.body, bandeja: pedidoBandeja2 }),
    });
    if (!todoListoOk) {
      throw new Error('El atajo "todo listo" no dejó el pedido servido en la bandeja.');
    }

    const entregaRestoKds = await request(
      base,
      'PATCH',
      `/kds/pedidos/${rondaKds.body.id}/platos/${lineaPollo.id}/entregar`,
      { token, body: {} },
    );
    const kds3 = await request(base, 'GET', '/kds/pedidos', { token });
    const pedidoKds3 = (kds3.body.data || []).find((pedido) => pedido.id === rondaKds.body.id);
    const bandeja3 = await request(base, 'GET', '/pedidos-listos?page=1&limit=100&desde=2026-01-01', {
      token,
    });
    const enBandeja3 = (bandeja3.body.data || []).some((pedido) => pedido.id === rondaKds.body.id);
    const entregaTotalOk =
      entregaRestoKds.status === 200 &&
      entregaRestoKds.body?.todos_entregados === true &&
      entregaRestoKds.body?.pedido_estado_entrega === 'entregado' &&
      Boolean(pedidoKds3) &&
      pedidoKds3.todos_entregados === true &&
      pedidoKds3.estado_entrega === 'entregado' &&
      !enBandeja3;
    results.push({
      name: 'Entrega completa: sale de /pedidos-listos',
      status: entregaTotalOk ? 200 : 500,
      detail: entregaTotalOk
        ? `pedido=${rondaKds.body.id} · estado_entrega=entregado · fuera de la bandeja`
        : JSON.stringify({ respuesta: entregaRestoKds.body, pedidoKds: pedidoKds3, enBandeja: enBandeja3 }),
    });
    if (!entregaTotalOk) {
      throw new Error('El pedido totalmente entregado siguió apareciendo en /pedidos-listos.');
    }

    const rondaBebidas = await request(base, 'POST', `/cuentas/${cuentaId}/pedidos`, {
      token,
      body: {
        items: [{ platillo_id: bebidaKds.id, cantidad: 2 }],
        idempotency_key: `smoke-${Date.now()}-kds-bebidas`,
        enviar_cocina: true,
      },
    });
    const kdsBebidas = await request(base, 'GET', '/kds/pedidos', { token });
    const pedidoBebidas = (kdsBebidas.body.data || [])
      .find((pedido) => pedido.id === rondaBebidas.body.id);
    const bandejaBebidas = await request(
      base,
      'GET',
      '/pedidos-listos?page=1&limit=100&desde=2026-01-01',
      { token },
    );
    const pedidoBebidasBandeja = (bandejaBebidas.body.data || [])
      .find((pedido) => pedido.id === rondaBebidas.body.id);
    const soloBebidasOk =
      rondaBebidas.status === 201 &&
      Boolean(pedidoBebidas) &&
      pedidoBebidas.estado === 'servido' &&
      pedidoBebidas.listo === true &&
      pedidoBebidas.todos_entregados === false &&
      Boolean(pedidoBebidasBandeja);
    results.push({
      name: 'KDS v2: pedido solo de bebidas nace servido',
      status: soloBebidasOk ? 200 : 500,
      detail: soloBebidasOk
        ? `pedido=${rondaBebidas.body.id} · estado=servido · bandeja OK`
        : JSON.stringify({ creado: rondaBebidas.body, pedidoKds: pedidoBebidas, bandeja: pedidoBebidasBandeja }),
    });
    if (!soloBebidasOk) {
      throw new Error('Un pedido solo de bebidas no quedó servido ni apareció en la bandeja.');
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

    // ---- Compras y gastos (paginación, filtros, sort y DTO) ----------
    const proveedores = await request(base, 'GET', '/compras/proveedores?page=1&limit=5', { token });
    const proveedoresOk =
      proveedores.ok &&
      Array.isArray(proveedores.body.data) &&
      typeof proveedores.body.meta?.total === 'number' &&
      proveedores.body.data.length > 0;
    results.push({
      name: 'GET /api/compras/proveedores (paginado)',
      status: proveedoresOk ? 200 : 500,
      detail: proveedoresOk
        ? `${proveedores.body.data.length}/${proveedores.body.meta.total} · ${proveedores.body.data[0].razon_social}`
        : JSON.stringify(proveedores.body),
    });
    if (!proveedoresOk) {
      throw new Error('Los proveedores no respetaron page/limit/meta.');
    }

    // Los ids de insumo se resuelven del inventario para que el script también
    // sirva contra Supabase, donde el seed puede tener otros identificadores.
    const insumoA = inventarioPagina.body.data[0].id;
    const insumoB = inventarioPagina.body.data[1].id;
    const compraCreada = await request(base, 'POST', '/compras', {
      token,
      body: {
        proveedor_id: proveedores.body.data[0].id,
        items: [
          { insumo_id: insumoA, cantidad: 2, precio_unitario: 10 },
          { insumo_id: insumoB, cantidad: 3, precio_unitario: 4.5 },
        ],
        notas: 'Orden de prueba smoke',
      },
    });
    const compraOk =
      compraCreada.status === 201 &&
      compraCreada.body.id > 0 &&
      Number(compraCreada.body.total) === 33.5 &&
      Array.isArray(compraCreada.body.detalles) &&
      compraCreada.body.detalles.length === 2 &&
      compraCreada.body.detalles.every(
        (detalle) => typeof detalle.insumo === 'string' && typeof detalle.unidad_medida === 'string',
      ) &&
      Array.isArray(compraCreada.body.pagos);
    results.push({
      name: 'POST /api/compras',
      status: compraOk ? 201 : 500,
      detail: compraOk
        ? `id=${compraCreada.body.id} · total=${compraCreada.body.total} · ${compraCreada.body.detalles.length} líneas`
        : JSON.stringify(compraCreada.body),
    });
    if (!compraOk) {
      throw new Error(`La compra no se creó completo: ${JSON.stringify(compraCreada.body)}`);
    }
    const compraId = compraCreada.body.id;

    const compras = await request(
      base,
      'GET',
      '/compras?page=1&limit=5&estado=ordenada&sort=total:desc',
      { token },
    );
    const primeraCompra = (compras.body && compras.body.data && compras.body.data[0]) || {};
    const comprasMetaOk =
      compras.ok &&
      Array.isArray(compras.body.data) &&
      typeof compras.body.meta?.page === 'number' &&
      typeof compras.body.meta?.limit === 'number' &&
      typeof compras.body.meta?.total === 'number' &&
      typeof compras.body.meta?.pages === 'number' &&
      compras.body.data.length <= 5 &&
      compras.body.data.every(
        (compra) =>
          typeof compra.total === 'number' &&
          typeof compra.items === 'number' &&
          compra.proveedor &&
          typeof compra.proveedor.razon_social === 'string' &&
          compra.detalles === undefined,
      ) &&
      compras.body.data.every(
        (compra, indice, lista) => indice === 0 || lista[indice - 1].total >= compra.total,
      );
    results.push({
      name: 'GET /api/compras (page/limit/sort/meta)',
      status: comprasMetaOk ? 200 : 500,
      detail: comprasMetaOk
        ? `${compras.body.data.length}/${compras.body.meta.total} · páginas ${compras.body.meta.pages} · top=${primeraCompra.total}`
        : JSON.stringify(compras.body),
    });
    if (!comprasMetaOk) {
      throw new Error('El listado de compras no respetó paginación, sort o el DTO.');
    }

    const comprasTexto = await request(base, 'GET', '/compras?q=smoke&page=1&limit=5', { token });
    const comprasTextoOk =
      comprasTexto.ok &&
      Array.isArray(comprasTexto.body.data) &&
      comprasTexto.body.data.some((compra) => compra.id === compraId);
    results.push({
      name: 'GET /api/compras?q= (filtro en notas/proveedor)',
      status: comprasTextoOk ? 200 : 500,
      detail: comprasTextoOk
        ? `${comprasTexto.body.meta.total} coincidencias`
        : JSON.stringify(comprasTexto.body),
    });
    if (!comprasTextoOk) {
      throw new Error('El filtro q de compras no encontró la orden creada.');
    }

    const sortInvalido = await request(base, 'GET', '/compras?sort=inventado:desc', { token });
    const sortInvalidoOk =
      sortInvalido.status === 400 &&
      sortInvalido.body?.error?.code === 'VALIDATION_ERROR' &&
      Array.isArray(sortInvalido.body.error.details) &&
      sortInvalido.body.error.details.some((detalle) => detalle.field === 'sort');
    results.push({
      name: 'GET /api/compras?sort=inventado:desc (400)',
      status: sortInvalidoOk ? 400 : 500,
      detail: sortInvalidoOk
        ? `code=${sortInvalido.body.error.code} · field=sort`
        : JSON.stringify(sortInvalido.body),
    });
    if (!sortInvalidoOk) {
      throw new Error('Un sort inválido no devolvió 400 VALIDATION_ERROR con field=sort.');
    }

    const sugerencia = await request(base, 'GET', '/compras/sugerencia', { token });
    const sugerenciaOk =
      sugerencia.ok &&
      Array.isArray(sugerencia.body.data) &&
      typeof sugerencia.body.meta?.total === 'number' &&
      sugerencia.body.meta?.criterio === 'stock_actual <= stock_minimo';
    results.push({
      name: 'GET /api/compras/sugerencia',
      status: sugerenciaOk ? 200 : 500,
      detail: sugerenciaOk
        ? `${sugerencia.body.meta.total} insumos por reponer`
        : JSON.stringify(sugerencia.body),
    });
    if (!sugerenciaOk) {
      throw new Error('La sugerencia de compra no devolvió el meta esperado.');
    }

    const cancelada = await request(base, 'POST', `/compras/${compraId}/cancelar`, {
      token,
      body: { motivo: 'Prueba smoke' },
    });
    const canceladaOk =
      cancelada.ok && cancelada.body.estado === 'cancelada' && cancelada.body.motivo_cancelacion === 'Prueba smoke';
    results.push({
      name: 'POST /api/compras/:id/cancelar',
      status: canceladaOk ? 200 : 500,
      detail: canceladaOk ? `estado=${cancelada.body.estado}` : JSON.stringify(cancelada.body),
    });
    if (!canceladaOk) {
      throw new Error(`No se pudo cancelar la compra: ${JSON.stringify(cancelada.body)}`);
    }

    const gastoCreado = await request(base, 'POST', '/gastos', {
      token,
      body: {
        categoria: 'otros',
        descripcion: 'Gasto smoke de prueba',
        monto: 77.7,
        metodo_pago: 'efectivo',
      },
    });
    const gastoOk =
      gastoCreado.status === 201 &&
      gastoCreado.body.id > 0 &&
      Number(gastoCreado.body.monto) === 77.7 &&
      typeof gastoCreado.body.registrado_por === 'string';
    results.push({
      name: 'POST /api/gastos',
      status: gastoOk ? 201 : 500,
      detail: gastoOk
        ? `id=${gastoCreado.body.id} · registrado_por=${gastoCreado.body.registrado_por}`
        : JSON.stringify(gastoCreado.body),
    });
    if (!gastoOk) {
      throw new Error(`El gasto no se creó completo: ${JSON.stringify(gastoCreado.body)}`);
    }

    const gastos = await request(
      base,
      'GET',
      '/gastos?page=1&limit=5&q=smoke&sort=monto:desc',
      { token },
    );
    const gastosMetaOk =
      gastos.ok &&
      Array.isArray(gastos.body.data) &&
      typeof gastos.body.meta?.page === 'number' &&
      typeof gastos.body.meta?.limit === 'number' &&
      typeof gastos.body.meta?.total === 'number' &&
      typeof gastos.body.meta?.pages === 'number' &&
      gastos.body.data.length === 1 &&
      Number(gastos.body.data[0].monto) === 77.7 &&
      typeof gastos.body.data[0].registrado_por === 'string';
    results.push({
      name: 'GET /api/gastos (page/limit/q/sort/meta)',
      status: gastosMetaOk ? 200 : 500,
      detail: gastosMetaOk
        ? `${gastos.body.data.length}/${gastos.body.meta.total} · páginas ${gastos.body.meta.pages} · monto=${gastos.body.data[0].monto}`
        : JSON.stringify(gastos.body),
    });
    if (!gastosMetaOk) {
      throw new Error('El listado de gastos no respetó paginación, filtro o DTO.');
    }

    const resumenGastos = await request(base, 'GET', '/gastos/resumen', { token });
    const resumenOk =
      resumenGastos.ok &&
      typeof resumenGastos.body.total === 'number' &&
      typeof resumenGastos.body.registros === 'number' &&
      Array.isArray(resumenGastos.body.por_categoria) &&
      resumenGastos.body.por_categoria.some((item) => item.categoria === 'otros');
    results.push({
      name: 'GET /api/gastos/resumen',
      status: resumenOk ? 200 : 500,
      detail: resumenOk
        ? `S/ ${resumenGastos.body.total} en ${resumenGastos.body.registros} registros`
        : JSON.stringify(resumenGastos.body),
    });
    if (!resumenOk) {
      throw new Error('El resumen de gastos no devolvió totales reales.');
    }

    // ---- Merma, devoluciones, activos, usuarios e historial global ----
    const tiposMerma = await request(base, 'GET', '/tipos-merma', { token });
    const tipoMermaId = tiposMerma.body.data[0].id;
    const mermaCreada = await request(base, 'POST', '/mermas', {
      token,
      body: {
        tipo_merma_id: tipoMermaId,
        insumo_id: insumoA,
        cantidad: 0.5,
        clasificacion: 'evitable',
        causa_raiz: 'Prueba smoke',
        motivo: 'Merma smoke de verificación',
      },
    });
    const mermas = await request(base, 'GET', '/merma/mermas?page=1&limit=5&sort=id:desc', { token });
    const mermasMetaOk =
      mermaCreada.status === 201 &&
      mermas.ok &&
      Array.isArray(mermas.body.data) &&
      mermas.body.data.length <= 5 &&
      typeof mermas.body.meta?.page === 'number' &&
      typeof mermas.body.meta?.limit === 'number' &&
      typeof mermas.body.meta?.total === 'number' &&
      typeof mermas.body.meta?.pages === 'number' &&
      mermas.body.data.some((merma) => merma.id === mermaCreada.body.id) &&
      mermas.body.data.every(
        (merma) =>
          typeof merma.cantidad === 'number' &&
          typeof merma.costo_estimado === 'number' &&
          typeof merma.tipo_merma === 'string' &&
          typeof merma.registrado_por === 'string',
      );
    results.push({
      name: 'GET /api/merma/mermas (page/sort/meta/DTO)',
      status: mermasMetaOk ? 200 : 500,
      detail: mermasMetaOk
        ? `${mermas.body.data.length}/${mermas.body.meta.total} · páginas ${mermas.body.meta.pages} · tipo=${mermas.body.data[0].tipo_merma}`
        : JSON.stringify(mermas.body),
    });
    if (!mermasMetaOk) {
      throw new Error(`El listado de mermas no respetó paginación/meta/DTO: ${JSON.stringify({ creada: mermaCreada.body, lista: mermas.body })}`);
    }

    const devolucionCreada = await request(base, 'POST', '/devoluciones', {
      token,
      body: {
        pedido_id: ronda1.body.id,
        motivo: 'Devolución smoke de verificación',
        detalle: 'Creada por scripts/smoke.js',
      },
    });
    const devoluciones = await request(
      base,
      'GET',
      '/devoluciones?page=1&limit=5&q=smoke&sort=fecha_reporte:desc',
      { token },
    );
    const devolucionesMetaOk =
      devolucionCreada.status === 201 &&
      devoluciones.ok &&
      Array.isArray(devoluciones.body.data) &&
      devoluciones.body.data.length <= 5 &&
      typeof devoluciones.body.meta?.page === 'number' &&
      typeof devoluciones.body.meta?.total === 'number' &&
      typeof devoluciones.body.meta?.pages === 'number' &&
      devoluciones.body.data.some((item) => item.id === devolucionCreada.body.id) &&
      devoluciones.body.data.every(
        (item) =>
          typeof item.monto_reembolsado === 'number' &&
          Array.isArray(item.reembolsos) &&
          (item.pedido_numero === null || typeof item.pedido_numero === 'string'),
      );
    results.push({
      name: 'GET /api/devoluciones (q/sort/meta/DTO)',
      status: devolucionesMetaOk ? 200 : 500,
      detail: devolucionesMetaOk
        ? `${devoluciones.body.data.length}/${devoluciones.body.meta.total} · páginas ${devoluciones.body.meta.pages}`
        : JSON.stringify(devoluciones.body),
    });
    if (!devolucionesMetaOk) {
      throw new Error(`El listado de devoluciones no respetó q/meta/DTO: ${JSON.stringify({ creada: devolucionCreada.body, lista: devoluciones.body })}`);
    }

    const devolucionResuelta = await request(
      base,
      'POST',
      `/devoluciones/${devolucionCreada.body.id}/resolver`,
      { token, body: { estado: 'aceptada', resolucion: 're_preparar' } },
    );
    const devolucionResueltaOk =
      devolucionResuelta.ok &&
      devolucionResuelta.body.estado === 'aceptada' &&
      devolucionResuelta.body.resolucion === 're_preparar' &&
      devolucionResuelta.body.merma &&
      typeof devolucionResuelta.body.merma.id === 'number';
    results.push({
      name: 'POST /api/devoluciones/:id/resolver',
      status: devolucionResueltaOk ? 200 : 500,
      detail: devolucionResueltaOk
        ? `estado=${devolucionResuelta.body.estado} · merma=${devolucionResuelta.body.merma.id}`
        : JSON.stringify(devolucionResuelta.body),
    });
    if (!devolucionResueltaOk) {
      throw new Error(`La devolución no se resolvió con merma: ${JSON.stringify(devolucionResuelta.body)}`);
    }

    // ---- Devolución con reembolso: histórico en devolucion_reembolsos ----
    const devolucionReembolso = await request(base, 'POST', '/devoluciones', {
      token,
      body: {
        pedido_id: ronda1.body.id,
        motivo: 'Devolución smoke con reembolso',
        detalle: 'Creada para verificar el histórico de reembolsos',
      },
    });
    const resolucionReembolso = await request(
      base,
      'POST',
      `/devoluciones/${devolucionReembolso.body.id}/resolver`,
      {
        token,
        body: {
          estado: 'aceptada',
          resolucion: 'reembolso_parcial',
          monto_reembolsado: 0,
          detalle_resolucion: 'Se devuelve parte del monto al cliente',
        },
      },
    );
    const reembolsoCreado = await request(
      base,
      'POST',
      `/devoluciones/${devolucionReembolso.body.id}/reembolso`,
      { token, body: { metodo: 'efectivo', monto: 5, observacion: 'Reembolso smoke' } },
    );
    const devolucionDetalle = await request(
      base,
      'GET',
      `/devoluciones/${devolucionReembolso.body.id}`,
      { token },
    );
    const reembolsosDetalle = Array.isArray(devolucionDetalle.body?.reembolsos)
      ? devolucionDetalle.body.reembolsos
      : [];
    const reembolsoOk =
      devolucionReembolso.status === 201 &&
      resolucionReembolso.ok &&
      resolucionReembolso.body.detalle_resolucion === 'Se devuelve parte del monto al cliente' &&
      reembolsoCreado.ok &&
      reembolsoCreado.body.reembolso &&
      Number(reembolsoCreado.body.reembolso.monto) === 5 &&
      reembolsoCreado.body.reembolso.observacion === 'Reembolso smoke' &&
      devolucionDetalle.ok &&
      reembolsosDetalle.some(
        (item) => Number(item.monto) === 5 && item.observacion === 'Reembolso smoke',
      );
    results.push({
      name: 'POST /api/devoluciones/:id/reembolso (histórico)',
      status: reembolsoOk ? 200 : 500,
      detail: reembolsoOk
        ? `devolucion=${devolucionReembolso.body.id} · reembolsos=${reembolsosDetalle.length} · monto=${reembolsoCreado.body.reembolso.monto}`
        : JSON.stringify({
          creada: devolucionReembolso.body,
          resolucion: resolucionReembolso.body,
          reembolso: reembolsoCreado.body,
          detalle: devolucionDetalle.body,
        }),
    });
    if (!reembolsoOk) {
      throw new Error('El reembolso no quedó visible en devolucion_reembolsos (DTO).');
    }

    const activoCreado = await request(base, 'POST', '/activos', {
      token,
      body: {
        nombre: 'Activo smoke de verificación',
        categoria: 'oficina',
        cantidad: 1,
        costo_adquisicion: 150,
        vida_util_meses: 12,
        fecha_adquisicion: '2026-01-01',
      },
    });
    const activos = await request(base, 'GET', '/activos?page=1&limit=5&sort=id:desc', { token });
    const activosMetaOk =
      activoCreado.status === 201 &&
      activos.ok &&
      Array.isArray(activos.body.data) &&
      activos.body.data.length <= 5 &&
      typeof activos.body.meta?.total === 'number' &&
      typeof activos.body.meta?.pages === 'number' &&
      activos.body.data.some((activo) => activo.id === activoCreado.body.id) &&
      activos.body.data.every(
        (activo) =>
          typeof activo.antiguedad_meses === 'number' &&
          typeof activo.costo_adquisicion === 'number' &&
          typeof activo.mantenimientos === 'number',
      );
    results.push({
      name: 'GET /api/activos (page/sort/meta/DTO)',
      status: activosMetaOk ? 200 : 500,
      detail: activosMetaOk
        ? `${activos.body.data.length}/${activos.body.meta.total} · páginas ${activos.body.meta.pages}`
        : JSON.stringify(activos.body),
    });
    if (!activosMetaOk) {
      throw new Error(`El listado de activos no respetó paginación/meta/DTO: ${JSON.stringify({ creado: activoCreado.body, lista: activos.body })}`);
    }

    const mantenimientoCreado = await request(
      base,
      'POST',
      `/activos/${activoCreado.body.id}/mantenimientos`,
      {
        token,
        body: {
          tipo: 'preventivo',
          descripcion: 'Revisión smoke de verificación',
          programada_para: '2026-12-01',
        },
      },
    );
    const mantenimientosActivo = await request(
      base,
      'GET',
      `/activos/${activoCreado.body.id}/mantenimientos`,
      { token },
    );
    const mantenimientoOk =
      mantenimientoCreado.status === 201 &&
      mantenimientosActivo.ok &&
      Array.isArray(mantenimientosActivo.body.data) &&
      mantenimientosActivo.body.data.some((item) => item.id === mantenimientoCreado.body.id);
    results.push({
      name: 'POST+GET /api/activos/:id/mantenimientos',
      status: mantenimientoOk ? 201 : 500,
      detail: mantenimientoOk
        ? `${mantenimientosActivo.body.meta.total} mantenimientos`
        : JSON.stringify(mantenimientosActivo.body),
    });
    if (!mantenimientoOk) {
      throw new Error(`El mantenimiento no se registró/listó: ${JSON.stringify(mantenimientosActivo.body)}`);
    }

    // El DTO de activos expone la fecha programada más próxima (o null).
    const activoProximo = await request(base, 'GET', '/activos?page=1&limit=100&sort=id:desc', { token });
    const fichaProximo = Array.isArray(activoProximo.body && activoProximo.body.data)
      ? activoProximo.body.data.find((item) => item.id === activoCreado.body.id)
      : null;
    const proximoMantenimientoOk =
      activoProximo.ok &&
      Array.isArray(activoProximo.body.data) &&
      activoProximo.body.data.every(
        (activo) => Object.prototype.hasOwnProperty.call(activo, 'proximo_mantenimiento'),
      ) &&
      Boolean(fichaProximo) &&
      fichaProximo.proximo_mantenimiento !== null &&
      String(fichaProximo.proximo_mantenimiento).slice(0, 10) === '2026-12-01';
    results.push({
      name: 'GET /api/activos (proximo_mantenimiento)',
      status: proximoMantenimientoOk ? 200 : 500,
      detail: proximoMantenimientoOk
        ? `activo=${activoCreado.body.id} · proximo_mantenimiento=${fichaProximo.proximo_mantenimiento}`
        : JSON.stringify({
          status: activoProximo.status,
          creado: activoCreado.body.id,
          ficha: fichaProximo,
        }),
    });
    if (!proximoMantenimientoOk) {
      throw new Error(
        `GET /api/activos no expuso proximo_mantenimiento con la fecha programada: ${JSON.stringify({ creado: activoCreado.body.id, ficha: fichaProximo })}`,
      );
    }

    const sortActivoInvalido = await request(base, 'GET', '/activos?sort=inventado:desc', { token });
    const sortActivoInvalidoOk =
      sortActivoInvalido.status === 400 &&
      sortActivoInvalido.body?.error?.code === 'VALIDATION_ERROR' &&
      Array.isArray(sortActivoInvalido.body.error.details) &&
      sortActivoInvalido.body.error.details.some((detalle) => detalle.field === 'sort');
    results.push({
      name: 'GET /api/activos?sort=inventado:desc (400)',
      status: sortActivoInvalidoOk ? 400 : 500,
      detail: sortActivoInvalidoOk
        ? `code=${sortActivoInvalido.body.error.code} · field=sort`
        : JSON.stringify(sortActivoInvalido.body),
    });
    if (!sortActivoInvalidoOk) {
      throw new Error('Un sort inválido de activos no devolvió 400 VALIDATION_ERROR con field=sort.');
    }

    const usuarios = await request(
      base,
      'GET',
      '/configuracion/usuarios?page=1&limit=5&sort=id:asc',
      { token },
    );
    const usuariosMetaOk =
      usuarios.ok &&
      Array.isArray(usuarios.body.data) &&
      usuarios.body.data.length <= 5 &&
      typeof usuarios.body.meta?.total === 'number' &&
      typeof usuarios.body.meta?.pages === 'number' &&
      usuarios.body.data.every(
        (usuario) =>
          typeof usuario.usuario === 'string' &&
          Array.isArray(usuario.roles) &&
          Array.isArray(usuario.permisos),
      );
    results.push({
      name: 'GET /api/configuracion/usuarios (meta/roles/permisos)',
      status: usuariosMetaOk ? 200 : 500,
      detail: usuariosMetaOk
        ? `${usuarios.body.data.length}/${usuarios.body.meta.total} · roles=${usuarios.body.data[0].roles.join('+')}`
        : JSON.stringify(usuarios.body),
    });
    if (!usuariosMetaOk) {
      throw new Error(`El listado de usuarios no respetó meta/roles/permisos: ${JSON.stringify(usuarios.body)}`);
    }

    const sufijo = Date.now();
    const usuarioCreado = await request(base, 'POST', '/configuracion/usuarios', {
      token,
      body: {
        nombre: 'Usuario Smoke',
        email: `smoke-${sufijo}@fratellis.pe`,
        usuario: `smoke${sufijo}`,
        clave: 'demo123',
        roles: ['Mozo'],
      },
    });
    const rolesActualizados = await request(
      base,
      'PUT',
      `/configuracion/usuarios/${usuarioCreado.body.id}/roles`,
      { token, body: { roles: ['Mozo', 'Cajero'] } },
    );
    const usuarioDesactivado = await request(
      base,
      'PATCH',
      `/configuracion/usuarios/${usuarioCreado.body.id}`,
      { token, body: { activo: false } },
    );
    const usuarioOk =
      usuarioCreado.status === 201 &&
      Array.isArray(usuarioCreado.body.roles) &&
      usuarioCreado.body.roles.includes('Mozo') &&
      rolesActualizados.ok &&
      rolesActualizados.body.roles.length === 2 &&
      rolesActualizados.body.roles.includes('Cajero') &&
      usuarioDesactivado.ok &&
      usuarioDesactivado.body.activo === false;
    results.push({
      name: 'POST/PUT/PATCH /api/configuracion/usuarios',
      status: usuarioOk ? 201 : 500,
      detail: usuarioOk
        ? `id=${usuarioCreado.body.id} · roles=${rolesActualizados.body.roles.join('+')} · activo=${usuarioDesactivado.body.activo}`
        : JSON.stringify({ creado: usuarioCreado.body, roles: rolesActualizados.body, patch: usuarioDesactivado.body }),
    });
    if (!usuarioOk) {
      throw new Error('El alta/roles/baja del usuario no devolvió lo esperado.');
    }

    // ---- Alias: derivación desde el correo y actualización ----
    const usuarioSinAlias = await request(base, 'POST', '/configuracion/usuarios', {
      token,
      body: {
        nombre: 'Usuario Derivado Smoke',
        email: `derivado-${sufijo}@fratellis.pe`,
        clave: 'demo123',
        roles: ['Mozo'],
      },
    });
    const aliasEsperado = `derivado-${sufijo}`;
    const usuarioAliasEditado = await request(
      base,
      'PATCH',
      `/configuracion/usuarios/${usuarioSinAlias.body.id}`,
      { token, body: { usuario: `alias${sufijo}` } },
    );
    const aliasOk =
      usuarioSinAlias.status === 201 &&
      usuarioSinAlias.body.usuario === aliasEsperado &&
      usuarioAliasEditado.ok &&
      usuarioAliasEditado.body.usuario === `alias${sufijo}`;
    results.push({
      name: 'POST/PATCH /api/configuracion/usuarios (usuario)',
      status: aliasOk ? 201 : 500,
      detail: aliasOk
        ? `${usuarioSinAlias.body.usuario} -> ${usuarioAliasEditado.body.usuario}`
        : JSON.stringify({ creado: usuarioSinAlias.body, patch: usuarioAliasEditado.body }),
    });
    if (!aliasOk) {
      throw new Error('El alias de usuario no se derivó/actualizó como se esperaba.');
    }

    // ---- Turnos multi-valor y cambio de clave ----
    const emailTurnos = `turnos-${sufijo}@fratellis.pe`;
    const usuarioTurnos = await request(base, 'POST', '/configuracion/usuarios', {
      token,
      body: {
        nombre: 'Turnos Smoke',
        email: emailTurnos,
        clave: 'demo123',
        roles: ['Mozo'],
        turnos: ['mañana', 'noche'],
      },
    });
    const turnosEditados = await request(
      base,
      'PATCH',
      `/configuracion/usuarios/${usuarioTurnos.body.id}`,
      { token, body: { turnos: ['tarde'], clave: 'claveNueva123' } },
    );
    const loginClaveNueva = await request(base, 'POST', '/auth/login', {
      body: { email: emailTurnos, password: 'claveNueva123' },
    });
    const loginClaveVieja = await request(base, 'POST', '/auth/login', {
      body: { email: emailTurnos, password: 'demo123' },
    });
    const turnosOk =
      usuarioTurnos.status === 201 &&
      Array.isArray(usuarioTurnos.body.turnos) &&
      usuarioTurnos.body.turnos.length === 2 &&
      turnosEditados.ok &&
      Array.isArray(turnosEditados.body.turnos) &&
      turnosEditados.body.turnos.length === 1 &&
      turnosEditados.body.turnos[0] === 'tarde' &&
      loginClaveNueva.ok &&
      Boolean(loginClaveNueva.body.token) &&
      loginClaveVieja.status === 401;
    results.push({
      name: 'POST/PATCH /api/configuracion/usuarios (turnos y clave)',
      status: turnosOk ? 201 : 500,
      detail: turnosOk
        ? `turnos=${turnosEditados.body.turnos.join('+')} · clave actualizada`
        : JSON.stringify({
          creado: usuarioTurnos.body,
          patch: turnosEditados.body,
          loginNuevo: loginClaveNueva.status,
          loginViejo: loginClaveVieja.status,
        }),
    });
    if (!turnosOk) {
      throw new Error('Los turnos o el cambio de clave del usuario no funcionaron.');
    }

    // ---- Mozo (solo venta.registrar): carta y estado de caja visibles ----
    const tokenMozo = loginClaveNueva.body.token;
    const cartaMozo = await request(base, 'GET', '/platillos?limit=100', {
      token: tokenMozo,
    });
    const categoriasMozo = await request(base, 'GET', '/categorias-platillo', {
      token: tokenMozo,
    });
    const cajaMozo = await request(base, 'GET', '/cuadre-caja', { token: tokenMozo });
    const inventarioMozo = await request(base, 'GET', '/inventario', {
      token: tokenMozo,
    });
    const escribirCartaMozo = await request(base, 'POST', '/platillos', {
      token: tokenMozo,
      body: { nombre: 'Plato no permitido', categoria_id: 1, precio: 10 },
    });
    const mozoOk =
      cartaMozo.ok &&
      Array.isArray(cartaMozo.body.data) &&
      cartaMozo.body.data.length > 0 &&
      categoriasMozo.ok &&
      Array.isArray(categoriasMozo.body.data) &&
      cajaMozo.ok &&
      inventarioMozo.status === 403 &&
      escribirCartaMozo.status === 403;
    results.push({
      name: 'Mozo: carta y caja legibles, escritura denegada',
      status: mozoOk ? 200 : 500,
      detail: mozoOk
        ? `platos=${cartaMozo.body.data.length} · categorías=${categoriasMozo.body.data.length} · caja=${cajaMozo.body?.estado ?? 'sin cuadre'} · inventario=${inventarioMozo.status} · POST platillos=${escribirCartaMozo.status}`
        : JSON.stringify({
            carta: cartaMozo.status,
            categorias: categoriasMozo.status,
            caja: cajaMozo.status,
            inventario: inventarioMozo.status,
            escribir: escribirCartaMozo.status,
          }),
    });
    if (!mozoOk) {
      throw new Error('Un usuario Mozo no puede leer la carta o el estado de la caja.');
    }

    // ---- Delivery propio: estado_entrega persistido ----
    const usuariosReparto = await request(
      base,
      'GET',
      '/configuracion/usuarios?page=1&limit=50',
      { token },
    );
    const repartidor = (usuariosReparto.body.data || []).find(
      (usuario) => Array.isArray(usuario.roles) && usuario.roles.includes('Repartidor'),
    );
    if (!repartidor) {
      throw new Error('No hay un usuario con rol Repartidor para la prueba de delivery propio.');
    }

    const deliveryCreado = await request(base, 'POST', '/delivery-propio/pedidos', {
      token,
      body: {
        canal: 'whatsapp',
        cliente: {
          nombre: 'Cliente Delivery Smoke',
          telefono: '999123456',
          direccion: 'Jr. Delivery Smoke 123',
        },
        items: [{ platillo_id: 3, cantidad: 1 }],
        enviar_cocina: false,
      },
    });
    const repartidorAsignado = await request(
      base,
      'PATCH',
      `/delivery-propio/pedidos/${deliveryCreado.body.id}/repartidor`,
      { token, body: { repartidor_id: repartidor.id } },
    );
    const enCamino = await request(
      base,
      'PATCH',
      `/delivery-propio/pedidos/${deliveryCreado.body.id}/estado`,
      { token, body: { estado: 'en_camino' } },
    );
    const listadoEnCamino = await request(
      base,
      'GET',
      '/delivery-propio/pedidos?estado=en_camino&limit=50',
      { token },
    );
    const entrega = await request(
      base,
      'POST',
      `/delivery-propio/pedidos/${deliveryCreado.body.id}/entrega`,
      { token, body: { metodo: 'efectivo' } },
    );
    const listadoEntregado = await request(
      base,
      'GET',
      '/delivery-propio/pedidos?estado=entregado&limit=50',
      { token },
    );
    const deliveryOk =
      deliveryCreado.status === 201 &&
      deliveryCreado.body.estado_entrega === 'pendiente' &&
      repartidorAsignado.ok &&
      enCamino.ok &&
      enCamino.body.estado_entrega === 'en_camino' &&
      listadoEnCamino.ok &&
      listadoEnCamino.body.data.some((pedido) => pedido.id === deliveryCreado.body.id) &&
      entrega.ok &&
      entrega.body.pedido &&
      entrega.body.pedido.estado_entrega === 'entregado' &&
      listadoEntregado.ok &&
      listadoEntregado.body.data.some((pedido) => pedido.id === deliveryCreado.body.id);
    results.push({
      name: 'Delivery propio (estado_entrega pendiente→en_camino→entregado)',
      status: deliveryOk ? 200 : 500,
      detail: deliveryOk
        ? `pedido=${deliveryCreado.body.id} · pendiente -> en_camino -> entregado`
        : JSON.stringify({
          creado: deliveryCreado.body,
          repartidor: repartidorAsignado.body,
          enCamino: enCamino.body,
          listaEnCamino: listadoEnCamino.body,
          entrega: entrega.body,
          listaEntregado: listadoEntregado.body,
        }),
    });
    if (!deliveryOk) {
      throw new Error('El delivery propio no persistió el estado_entrega en la lista.');
    }

    // ---- Liquidación externa persistida ----
    const liquidacionCreada = await request(base, 'POST', '/delivery-externo/liquidaciones', {
      token,
      body: {
        plataforma: 'rappi',
        desde: '2026-11-01',
        hasta: '2026-11-07',
        monto_bruto: 100,
        comision: 25,
        observacion: 'Liquidación smoke',
      },
    });
    const liquidaciones = await request(
      base,
      'GET',
      '/delivery-externo/liquidaciones?page=1&limit=10&plataforma=rappi&desde=2026-11-01&hasta=2026-11-30&sort=creado_en:desc',
      { token },
    );
    const liquidacionFila = (liquidaciones.body.data || []).find(
      (item) => item.id === liquidacionCreada.body.id,
    );
    const liquidacionOk =
      liquidacionCreada.status === 201 &&
      liquidacionCreada.body.persistido === true &&
      typeof liquidacionCreada.body.id === 'number' &&
      Number(liquidacionCreada.body.monto_neto) === 75 &&
      liquidacionCreada.body.estado === 'registrada' &&
      liquidaciones.ok &&
      liquidaciones.body.meta &&
      liquidaciones.body.meta.origen === 'persistido' &&
      liquidaciones.body.meta.limitacion === undefined &&
      Boolean(liquidacionFila) &&
      Number(liquidacionFila.monto_neto) === 75;
    results.push({
      name: 'POST+GET /api/delivery-externo/liquidaciones (persistida)',
      status: liquidacionOk ? 201 : 500,
      detail: liquidacionOk
        ? `id=${liquidacionCreada.body.id} · neto=${liquidacionFila.monto_neto} · meta.origen=${liquidaciones.body.meta.origen}`
        : JSON.stringify({ creada: liquidacionCreada.body, lista: liquidaciones.body }),
    });
    if (!liquidacionOk) {
      throw new Error('La liquidación externa no quedó persistida/listada.');
    }

    const rolesCatalogo = await request(base, 'GET', '/configuracion/roles', { token });
    const permisosCatalogo = await request(base, 'GET', '/configuracion/permisos', { token });
    const catalogosOk =
      rolesCatalogo.ok &&
      permisosCatalogo.ok &&
      Array.isArray(rolesCatalogo.body.data) &&
      rolesCatalogo.body.data.length > 0 &&
      rolesCatalogo.body.data.every((rol) => Array.isArray(rol.permisos)) &&
      Array.isArray(permisosCatalogo.body.data) &&
      permisosCatalogo.body.data.length > 0;
    results.push({
      name: 'GET /api/configuracion/roles+permisos',
      status: catalogosOk ? 200 : 500,
      detail: catalogosOk
        ? `${rolesCatalogo.body.meta.total} roles · ${permisosCatalogo.body.meta.total} permisos`
        : JSON.stringify({ roles: rolesCatalogo.body, permisos: permisosCatalogo.body }),
    });
    if (!catalogosOk) {
      throw new Error('Los catálogos de roles/permisos no devolvieron datos.');
    }

    const movimientos = await request(
      base,
      'GET',
      '/inventario/movimientos?page=1&limit=5&sort=fecha:desc',
      { token },
    );
    const movimientosMetaOk =
      movimientos.ok &&
      Array.isArray(movimientos.body.data) &&
      movimientos.body.data.length <= 5 &&
      typeof movimientos.body.meta?.total === 'number' &&
      typeof movimientos.body.meta?.pages === 'number' &&
      movimientos.body.data.every(
        (movimiento) =>
          typeof movimiento.cantidad === 'number' &&
          Object.prototype.hasOwnProperty.call(movimiento, 'insumo') &&
          Object.prototype.hasOwnProperty.call(movimiento, 'usuario'),
      );
    results.push({
      name: 'GET /api/inventario/movimientos (meta/DTO)',
      status: movimientosMetaOk ? 200 : 500,
      detail: movimientosMetaOk
        ? `${movimientos.body.data.length}/${movimientos.body.meta.total} · páginas ${movimientos.body.meta.pages}`
        : JSON.stringify(movimientos.body),
    });
    if (!movimientosMetaOk) {
      throw new Error(`El historial global no respetó meta/DTO: ${JSON.stringify(movimientos.body)}`);
    }

    const movimientosEntrada = await request(
      base,
      'GET',
      '/inventario/movimientos?tipo=entrada&page=1&limit=5',
      { token },
    );
    const movimientosFiltroOk =
      movimientosEntrada.ok &&
      Array.isArray(movimientosEntrada.body.data) &&
      movimientosEntrada.body.data.every((movimiento) => movimiento.tipo === 'entrada');
    results.push({
      name: 'GET /api/inventario/movimientos?tipo=entrada',
      status: movimientosFiltroOk ? 200 : 500,
      detail: movimientosFiltroOk
        ? `${movimientosEntrada.body.meta.total} entradas`
        : JSON.stringify(movimientosEntrada.body),
    });
    if (!movimientosFiltroOk) {
      throw new Error('El filtro tipo del historial global no se aplicó.');
    }

    // ---- Fase 3: cursor `after` en movimientos ----
    // Se usa un cursor por debajo de la página actual para que queden filas
    // nuevas y has_more sea significativo.
    const idsMovimientos = movimientos.body.data.map((movimiento) => Number(movimiento.id));
    const cursorBase = Math.max(1, Math.min(...idsMovimientos) - 2);
    const movimientosCursor = await request(
      base,
      'GET',
      `/inventario/movimientos?limit=2&after=${cursorBase}`,
      { token },
    );
    const cursorMeta = movimientosCursor.body && movimientosCursor.body.meta;
    const movimientosCursorOk =
      movimientosCursor.ok &&
      Array.isArray(movimientosCursor.body.data) &&
      movimientosCursor.body.data.length <= 2 &&
      movimientosCursor.body.data.every((movimiento) => Number(movimiento.id) > cursorBase) &&
      cursorMeta &&
      Object.prototype.hasOwnProperty.call(cursorMeta, 'next_cursor') &&
      typeof cursorMeta.has_more === 'boolean' &&
      (cursorMeta.next_cursor === null || Number(cursorMeta.next_cursor) > cursorBase);
    results.push({
      name: 'GET /api/inventario/movimientos?after= (cursor)',
      status: movimientosCursorOk ? 200 : 500,
      detail: movimientosCursorOk
        ? `after=${cursorBase} · ${movimientosCursor.body.data.length} filas · next_cursor=${cursorMeta.next_cursor} · has_more=${cursorMeta.has_more}`
        : JSON.stringify(movimientosCursor.body),
    });
    if (!movimientosCursorOk) {
      throw new Error(`El cursor de movimientos no devolvió next_cursor/has_more: ${JSON.stringify(movimientosCursor.body)}`);
    }

    const cursorInvalido = await request(
      base,
      'GET',
      '/inventario/movimientos?after=abc',
      { token },
    );
    const cursorInvalidoOk =
      cursorInvalido.status === 400 &&
      cursorInvalido.body?.error?.code === 'VALIDATION_ERROR' &&
      Array.isArray(cursorInvalido.body.error.details) &&
      cursorInvalido.body.error.details.some((detalle) => detalle.field === 'after');
    results.push({
      name: 'GET /api/inventario/movimientos?after=abc (400)',
      status: cursorInvalidoOk ? 400 : 500,
      detail: cursorInvalidoOk
        ? `code=${cursorInvalido.body.error.code} · field=after`
        : JSON.stringify(cursorInvalido.body),
    });
    if (!cursorInvalidoOk) {
      throw new Error('Un after inválido no devolvió 400 VALIDATION_ERROR con field=after.');
    }

    // ---- Fase 2: reportes con rango, clientes paginados y cuadre histórico ----
    const ventasRango = await request(
      base,
      'GET',
      '/reportes/ventas?desde=2020-01-01&hasta=2030-12-31',
      { token },
    );
    const ventasRangoOk =
      ventasRango.ok &&
      typeof ventasRango.body.total === 'number' &&
      typeof ventasRango.body.cantidad_pagos === 'number' &&
      typeof ventasRango.body.cantidad_tickets === 'number' &&
      typeof ventasRango.body.ticket_promedio === 'number' &&
      Array.isArray(ventasRango.body.por_canal) &&
      Array.isArray(ventasRango.body.por_metodo) &&
      Array.isArray(ventasRango.body.por_dia) &&
      Array.isArray(ventasRango.body.top_platillos) &&
      ventasRango.body.meta &&
      ventasRango.body.meta.rango &&
      ventasRango.body.meta.rango.desde === '2020-01-01' &&
      ventasRango.body.meta.rango.hasta === '2030-12-31';
    results.push({
      name: 'GET /api/reportes/ventas?desde&hasta',
      status: ventasRangoOk ? 200 : 500,
      detail: ventasRangoOk
        ? `total=${ventasRango.body.total} · pagos=${ventasRango.body.cantidad_pagos} · días=${ventasRango.body.por_dia.length} · top=${ventasRango.body.top_platillos.length}`
        : JSON.stringify(ventasRango.body),
    });
    if (!ventasRangoOk) {
      throw new Error(`El reporte de ventas no devolvió los campos esperados: ${JSON.stringify(ventasRango.body)}`);
    }

    const costosRango = await request(
      base,
      'GET',
      '/reportes/costos?desde=2020-01-01&hasta=2030-12-31',
      { token },
    );
    const costosRangoOk =
      costosRango.ok &&
      typeof costosRango.body.total_costos === 'number' &&
      costosRango.body.compras &&
      typeof costosRango.body.compras.total === 'number' &&
      Array.isArray(costosRango.body.compras.por_proveedor) &&
      costosRango.body.gastos &&
      typeof costosRango.body.gastos.total === 'number' &&
      Array.isArray(costosRango.body.gastos.por_categoria) &&
      costosRango.body.mermas &&
      typeof costosRango.body.mermas.total === 'number' &&
      Array.isArray(costosRango.body.mermas.por_tipo) &&
      costosRango.body.meta;
    results.push({
      name: 'GET /api/reportes/costos?desde&hasta',
      status: costosRangoOk ? 200 : 500,
      detail: costosRangoOk
        ? `total=${costosRango.body.total_costos} · compras=${costosRango.body.compras.total} · gastos=${costosRango.body.gastos.total} · mermas=${costosRango.body.mermas.total}`
        : JSON.stringify(costosRango.body),
    });
    if (!costosRangoOk) {
      throw new Error(`El reporte de costos no devolvió los campos esperados: ${JSON.stringify(costosRango.body)}`);
    }

    const clientesPagina = await request(base, 'GET', '/clientes?page=1&limit=2', { token });
    const clientesPaginaOk =
      clientesPagina.ok &&
      Array.isArray(clientesPagina.body.data) &&
      clientesPagina.body.data.length <= 2 &&
      typeof clientesPagina.body.meta?.page === 'number' &&
      typeof clientesPagina.body.meta?.limit === 'number' &&
      typeof clientesPagina.body.meta?.total === 'number' &&
      typeof clientesPagina.body.meta?.pages === 'number' &&
      clientesPagina.body.data.every(
        (cliente) =>
          typeof cliente.id === 'number' &&
          typeof cliente.nombre === 'string' &&
          Object.prototype.hasOwnProperty.call(cliente, 'creado_en') &&
          Object.prototype.hasOwnProperty.call(cliente, 'numero_documento'),
      );
    results.push({
      name: 'GET /api/clientes (page/limit/meta)',
      status: clientesPaginaOk ? 200 : 500,
      detail: clientesPaginaOk
        ? `${clientesPagina.body.data.length}/${clientesPagina.body.meta.total} · páginas ${clientesPagina.body.meta.pages}`
        : JSON.stringify(clientesPagina.body),
    });
    if (!clientesPaginaOk) {
      throw new Error(`El listado de clientes no respetó paginación/meta: ${JSON.stringify(clientesPagina.body)}`);
    }

    const clientesBusqueda = await request(base, 'GET', '/clientes?q=Juan&page=1&limit=10', {
      token,
    });
    const clientesBusquedaOk =
      clientesBusqueda.ok &&
      Array.isArray(clientesBusqueda.body.data) &&
      clientesBusqueda.body.data.length > 0 &&
      clientesBusqueda.body.data.some((cliente) =>
        String(cliente.nombre || '').toLowerCase().includes('juan'),
      );
    results.push({
      name: 'GET /api/clientes?q=Juan',
      status: clientesBusquedaOk ? 200 : 500,
      detail: clientesBusquedaOk
        ? `${clientesBusqueda.body.meta.total} coincidencias`
        : JSON.stringify(clientesBusqueda.body),
    });
    if (!clientesBusquedaOk) {
      throw new Error(`El filtro q de clientes no encontró coincidencias: ${JSON.stringify(clientesBusqueda.body)}`);
    }

    const historialCuadres = await request(
      base,
      'GET',
      '/cuadre-caja/historial?page=1&limit=5&sort=fecha:desc',
      { token },
    );
    const historialCuadresOk =
      historialCuadres.ok &&
      Array.isArray(historialCuadres.body.data) &&
      historialCuadres.body.data.length <= 5 &&
      typeof historialCuadres.body.meta?.page === 'number' &&
      typeof historialCuadres.body.meta?.limit === 'number' &&
      typeof historialCuadres.body.meta?.total === 'number' &&
      typeof historialCuadres.body.meta?.pages === 'number' &&
      historialCuadres.body.meta?.sort === 'fecha:desc' &&
      historialCuadres.body.data.every(
        (cuadre) =>
          typeof cuadre.fondo_inicial === 'number' &&
          typeof cuadre.total_ventas === 'number' &&
          typeof cuadre.monto_esperado === 'number' &&
          (cuadre.diferencia === null || typeof cuadre.diferencia === 'number'),
      );
    results.push({
      name: 'GET /api/cuadre-caja/historial (meta/sort)',
      status: historialCuadresOk ? 200 : 500,
      detail: historialCuadresOk
        ? `${historialCuadres.body.data.length}/${historialCuadres.body.meta.total} · páginas ${historialCuadres.body.meta.pages} · sort=${historialCuadres.body.meta.sort}`
        : JSON.stringify(historialCuadres.body),
    });
    if (!historialCuadresOk) {
      throw new Error(`El historial de cuadres no respetó meta/sort: ${JSON.stringify(historialCuadres.body)}`);
    }

    const historialSortInvalido = await request(
      base,
      'GET',
      '/cuadre-caja/historial?sort=inventado:desc',
      { token },
    );
    const historialSortInvalidoOk =
      historialSortInvalido.status === 400 &&
      historialSortInvalido.body?.error?.code === 'VALIDATION_ERROR' &&
      Array.isArray(historialSortInvalido.body.error.details) &&
      historialSortInvalido.body.error.details.some((detalle) => detalle.field === 'sort');
    results.push({
      name: 'GET /api/cuadre-caja/historial?sort=inventado (400)',
      status: historialSortInvalidoOk ? 400 : 500,
      detail: historialSortInvalidoOk
        ? `code=${historialSortInvalido.body.error.code} · field=sort`
        : JSON.stringify(historialSortInvalido.body),
    });
    if (!historialSortInvalidoOk) {
      throw new Error('Un sort inválido del historial no devolvió 400 VALIDATION_ERROR con field=sort.');
    }

    // ---- Fase 5: exportaciones reales (XLSX/PDF) ----
    const TIPO_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    const exportXlsx = await request(
      base,
      'GET',
      '/reportes/ventas/export?formato=xlsx&desde=2020-01-01&hasta=2030-12-31',
      { token, binary: true },
    );
    let libroExport = null;
    let hojasExport = [];
    if (exportXlsx.ok && exportXlsx.buffer) {
      libroExport = new ExcelJS.Workbook();
      try {
        await libroExport.xlsx.load(exportXlsx.buffer);
        hojasExport = libroExport.worksheets.map((hoja) => hoja.name);
      } catch (error) {
        libroExport = null;
      }
    }
    const exportXlsxOk =
      exportXlsx.status === 200 &&
      String(exportXlsx.headers.get('content-type') || '').includes(TIPO_XLSX) &&
      Number(exportXlsx.headers.get('content-length')) > 1000 &&
      libroExport !== null &&
      hojasExport.includes('RESUMEN') &&
      hojasExport.includes('POR_DIA');
    results.push({
      name: 'GET /api/reportes/ventas/export?formato=xlsx',
      status: exportXlsxOk ? 200 : 500,
      detail: exportXlsxOk
        ? `${exportXlsx.headers.get('content-type')} · ${exportXlsx.headers.get('content-length')} bytes · hojas=${hojasExport.join('+')}`
        : JSON.stringify({
          status: exportXlsx.status,
          type: exportXlsx.headers.get('content-type'),
          length: exportXlsx.headers.get('content-length'),
          hojas: hojasExport,
        }),
    });
    if (!exportXlsxOk) {
      throw new Error('La exportación XLSX no devolvió un libro releíble con RESUMEN/POR_DIA.');
    }

    const exportPdf = await request(
      base,
      'GET',
      '/reportes/ventas/export?formato=pdf&desde=2020-01-01&hasta=2030-12-31',
      { token, binary: true },
    );
    const firmaPdf = exportPdf.buffer && exportPdf.buffer.subarray(0, 5).toString('latin1');
    const exportPdfOk =
      exportPdf.status === 200 &&
      String(exportPdf.headers.get('content-type') || '').includes('application/pdf') &&
      Number(exportPdf.headers.get('content-length')) > 1000 &&
      firmaPdf === '%PDF-';
    results.push({
      name: 'GET /api/reportes/ventas/export?formato=pdf',
      status: exportPdfOk ? 200 : 500,
      detail: exportPdfOk
        ? `${exportPdf.headers.get('content-type')} · ${exportPdf.headers.get('content-length')} bytes · firma=${firmaPdf}`
        : JSON.stringify({
          status: exportPdf.status,
          type: exportPdf.headers.get('content-type'),
          length: exportPdf.headers.get('content-length'),
          firma: firmaPdf,
        }),
    });
    if (!exportPdfOk) {
      throw new Error('La exportación PDF no devolvió un archivo PDF válido.');
    }

    const exportInvalido = await request(base, 'GET', '/reportes/ventas/export?formato=docx', {
      token,
    });
    const exportInvalidoOk =
      exportInvalido.status === 400 &&
      exportInvalido.body?.error?.code === 'VALIDATION_ERROR' &&
      Array.isArray(exportInvalido.body.error.details) &&
      exportInvalido.body.error.details.some((detalle) => detalle.field === 'formato');
    results.push({
      name: 'GET /api/reportes/ventas/export?formato=docx (400)',
      status: exportInvalidoOk ? 400 : 500,
      detail: exportInvalidoOk
        ? `code=${exportInvalido.body.error.code} · field=formato`
        : JSON.stringify(exportInvalido.body),
    });
    if (!exportInvalidoOk) {
      throw new Error('Un formato de exportación inválido no devolvió 400 VALIDATION_ERROR con field=formato.');
    }

    const cuadreAbierto = await request(base, 'GET', '/cuadre-caja', { token });
    const cuadreId = cuadreAbierto.body && cuadreAbierto.body.id;
    const cuadrePdf = cuadreId
      ? await request(base, 'GET', `/cuadre-caja/${cuadreId}/pdf`, { token, binary: true })
      : { status: 0, headers: new Headers(), buffer: null };
    const firmaCuadre = cuadrePdf.buffer && cuadrePdf.buffer.subarray(0, 5).toString('latin1');
    const cuadrePdfOk =
      Boolean(cuadreId) &&
      cuadrePdf.status === 200 &&
      String(cuadrePdf.headers.get('content-type') || '').includes('application/pdf') &&
      Number(cuadrePdf.headers.get('content-length')) > 1000 &&
      firmaCuadre === '%PDF-';
    results.push({
      name: 'GET /api/cuadre-caja/:id/pdf',
      status: cuadrePdfOk ? 200 : 500,
      detail: cuadrePdfOk
        ? `cuadre=${cuadreId} · ${cuadrePdf.headers.get('content-length')} bytes · firma=${firmaCuadre}`
        : JSON.stringify({
          cuadreId: cuadreId || null,
          status: cuadrePdf.status,
          type: cuadrePdf.headers.get('content-type'),
          length: cuadrePdf.headers.get('content-length'),
          firma: firmaCuadre,
        }),
    });
    if (!cuadrePdfOk) {
      throw new Error('El PDF del cuadre de caja no se generó correctamente.');
    }

    // ---- Opción A: una caja por día (pendientes y bloqueos) ----
    const enMemoria = process.env.DB_MODE === 'memory';
    const limaDate = (offsetDias = 0) =>
      new Date(Date.now() - 5 * 3600000 + offsetDias * 86400000).toISOString().slice(0, 10);
    const hoyFecha = limaDate(0);
    const ayerFecha = limaDate(-1);

    const pendientesInicial = await request(base, 'GET', '/cuadre-caja/pendientes', { token });
    const pendientesInicialOk =
      pendientesInicial.ok && Array.isArray(pendientesInicial.body.data);
    results.push({
      name: 'GET /api/cuadre-caja/pendientes',
      status: pendientesInicialOk ? 200 : 500,
      detail: pendientesInicialOk
        ? `${pendientesInicial.body.data.length} pendientes`
        : JSON.stringify(pendientesInicial.body),
    });
    if (!pendientesInicialOk) {
      throw new Error(
        `/cuadre-caja/pendientes no devolvió data array: ${JSON.stringify(pendientesInicial.body)}`,
      );
    }

    const cuentasAbiertasInicial = await request(base, 'GET', '/cuentas?estado=abierta&limit=100', {
      token,
    });
    const cuentasAbiertasLista =
      (cuentasAbiertasInicial.body && cuentasAbiertasInicial.body.data) || [];

    const cuadreParaCierre = cuadreAbierto.body && cuadreAbierto.body.estado === 'abierta'
      ? cuadreAbierto.body
      : (pendientesInicial.body.data || [])[0];

    if (cuadreParaCierre && cuadreParaCierre.id && cuentasAbiertasLista.length > 0) {
      const cierreConCuentas = await request(
        base,
        'POST',
        `/cuadre-caja/${cuadreParaCierre.id}/cierre`,
        { token, body: { efectivo_contado: 0, pagos_digitales: 0 } },
      );
      const detallesCierre = cierreConCuentas.body?.error?.details;
      const cierreConCuentasOk =
        cierreConCuentas.status === 409 &&
        cierreConCuentas.body?.error?.code === 'CUENTAS_ABIERTAS' &&
        Array.isArray(detallesCierre) &&
        detallesCierre.some((detalle) => typeof detalle.cantidad === 'number');
      results.push({
        name: 'POST /api/cuadre-caja/:id/cierre (cuentas abiertas 409)',
        status: cierreConCuentasOk ? 409 : 500,
        detail: cierreConCuentasOk
          ? `code=${cierreConCuentas.body.error.code} · cantidad=${detallesCierre[0].cantidad}`
          : JSON.stringify(cierreConCuentas.body),
      });
      if (!cierreConCuentasOk) {
        throw new Error(
          `El cierre con cuentas abiertas debía devolver 409 CUENTAS_ABIERTAS: ${JSON.stringify(cierreConCuentas.body)}`,
        );
      }
    }

    const aperturaAyer = await request(base, 'POST', '/cuadre-caja/apertura', {
      token,
      body: { fecha: ayerFecha, fondo_inicial: 0 },
    });
    const aperturaAyerOk = aperturaAyer.status === 201 || aperturaAyer.status === 409;
    results.push({
      name: 'POST /api/cuadre-caja/apertura (día anterior)',
      status: aperturaAyerOk ? aperturaAyer.status : 500,
      detail: `${aperturaAyer.status} · fecha=${ayerFecha}`,
    });
    if (!aperturaAyerOk) {
      throw new Error(
        `No se pudo preparar la caja de ayer de prueba: ${JSON.stringify(aperturaAyer.body)}`,
      );
    }

    const aperturaBloqueada = await request(base, 'POST', '/cuadre-caja/apertura', {
      token,
      body: { fecha: hoyFecha, fondo_inicial: 0 },
    });
    const detallesApertura = aperturaBloqueada.body?.error?.details;
    const aperturaBloqueadaOk =
      aperturaBloqueada.status === 409 &&
      aperturaBloqueada.body?.error?.code === 'CAJA_ANTERIOR_ABIERTA' &&
      Array.isArray(detallesApertura) &&
      detallesApertura.some((detalle) => detalle.id && detalle.fecha);
    results.push({
      name: 'POST /api/cuadre-caja/apertura (caja anterior abierta 409)',
      status: aperturaBloqueadaOk ? 409 : 500,
      detail: aperturaBloqueadaOk
        ? `code=${aperturaBloqueada.body.error.code} · fecha=${detallesApertura[0].fecha}`
        : JSON.stringify(aperturaBloqueada.body),
    });
    if (!aperturaBloqueadaOk) {
      throw new Error(
        `Abrir la caja con una caja anterior abierta debía devolver 409 CAJA_ANTERIOR_ABIERTA: ${JSON.stringify(aperturaBloqueada.body)}`,
      );
    }

    const pendientesConCaja = await request(base, 'GET', '/cuadre-caja/pendientes', { token });
    const pendientesConCajaOk =
      pendientesConCaja.ok &&
      Array.isArray(pendientesConCaja.body.data) &&
      pendientesConCaja.body.data.length > 0 &&
      pendientesConCaja.body.data.some(
        (cuadre) => String(cuadre.fecha).slice(0, 10) === ayerFecha,
      ) &&
      pendientesConCaja.body.data.every(
        (cuadre) => cuadre.resumen && typeof cuadre.resumen.monto_esperado === 'number',
      );
    results.push({
      name: 'GET /api/cuadre-caja/pendientes (resumen)',
      status: pendientesConCajaOk ? 200 : 500,
      detail: pendientesConCajaOk
        ? `${pendientesConCaja.body.data.length} pendientes · ayer=${ayerFecha}`
        : JSON.stringify(pendientesConCaja.body),
    });
    if (!pendientesConCajaOk) {
      throw new Error(
        `Los pendientes no incluyeron la caja de ayer con resumen: ${JSON.stringify(pendientesConCaja.body)}`,
      );
    }

    const cajeroLogin = await request(base, 'POST', '/auth/login', {
      body: { email: 'cajero@fratellis.pe', password: 'demo123' },
    });
    if (cajeroLogin.ok && cajeroLogin.body.token) {
      const cajaPendienteId = (pendientesConCaja.body.data[0] || {}).id;
      const reabrirCajero = cajaPendienteId
        ? await request(base, 'POST', `/cuadre-caja/${cajaPendienteId}/reabrir`, {
          token: cajeroLogin.body.token,
          body: { motivo: 'Intento de cajero' },
        })
        : { status: 0, body: null };
      const reabrirCajeroOk = reabrirCajero.status === 403;
      results.push({
        name: 'POST /api/cuadre-caja/:id/reabrir (cajero 403)',
        status: reabrirCajeroOk ? 403 : 500,
        detail: reabrirCajeroOk
          ? `code=${reabrirCajero.body.error.code}`
          : JSON.stringify(reabrirCajero.body),
      });
      if (!reabrirCajeroOk) {
        throw new Error(
          `Reabrir con un usuario sin rol Dueño/Admin debía devolver 403: ${JSON.stringify(reabrirCajero.body)}`,
        );
      }
    }

    // Solo en memoria: cancelar las cuentas de prueba y cerrar la caja de ayer
    // creada arriba, para poder probar el cierre/reapertura de hoy sin tocar
    // datos reales cuando el smoke corre contra Supabase.
    if (enMemoria) {
      for (const cuenta of cuentasAbiertasLista) {
        await request(base, 'POST', `/cuentas/${cuenta.id}/cancelar`, {
          token,
          body: { motivo: 'Limpieza smoke Opción A' },
        });
      }

      if (aperturaAyer.status === 201 && aperturaAyer.body && aperturaAyer.body.id) {
        const detalleAyer = await request(base, 'GET', `/cuadre-caja/${aperturaAyer.body.id}`, {
          token,
        });
        const esperadoAyer = Number(
          detalleAyer.body && detalleAyer.body.resumen
            ? detalleAyer.body.resumen.monto_esperado
            : 0,
        );
        const cierreAyer = await request(base, 'POST', `/cuadre-caja/${aperturaAyer.body.id}/cierre`, {
          token,
          body: { efectivo_contado: esperadoAyer, pagos_digitales: 0 },
        });
        if (!cierreAyer.ok) {
          throw new Error(
            `No se pudo cerrar la caja de ayer de prueba: ${JSON.stringify(cierreAyer.body)}`,
          );
        }
      }
    }

    const cuentasRestantes = await request(base, 'GET', '/cuentas?estado=abierta&limit=1', { token });
    const hayCuentasRestantes =
      (cuentasRestantes.body && cuentasRestantes.body.data || []).length > 0;

    if (!hayCuentasRestantes) {
      // ---- Reapertura del cuadre del día (fecha UNIQUE + POST /reabrir) ----
      let cuadrePrueba = await request(base, 'GET', '/cuadre-caja', { token });
      let cuadrePruebaId = cuadrePrueba.body && cuadrePrueba.body.id;

      if (!cuadrePruebaId) {
        const abierto = await request(base, 'POST', '/cuadre-caja/apertura', {
          token,
          body: { fondo_inicial: 0 },
        });
        cuadrePruebaId = abierto.body && abierto.body.id;
        cuadrePrueba = abierto;
      }

      if (cuadrePrueba.body && cuadrePrueba.body.estado !== 'cerrada' && cuadrePruebaId) {
        const esperado = Number(
          cuadrePrueba.body.resumen ? cuadrePrueba.body.resumen.monto_esperado : 0,
        );
        const cierrePrevio = await request(base, 'POST', `/cuadre-caja/${cuadrePruebaId}/cierre`, {
          token,
          body: {
            efectivo_contado: esperado,
            pagos_digitales: 0,
            observaciones: 'Cierre previo a la prueba de reapertura',
          },
        });
        if (!cierrePrevio.ok) {
          throw new Error(`No se pudo cerrar el cuadre para probar la reapertura: ${JSON.stringify(cierrePrevio.body)}`);
        }
      }

      const reapertura = await request(base, 'POST', `/cuadre-caja/${cuadrePruebaId}/reabrir`, {
        token,
        body: { motivo: 'Prueba de reapertura' },
      });
      const reaperturaOk =
        reapertura.status === 200 &&
        reapertura.body &&
        reapertura.body.estado === 'abierta' &&
        reapertura.body.motivo_reapertura === 'Prueba de reapertura' &&
        Boolean(reapertura.body.reabierto_en) &&
        reapertura.body.fecha_cierre === null &&
        reapertura.body.diferencia === null;
      results.push({
        name: 'POST /api/cuadre-caja/:id/reabrir',
        status: reaperturaOk ? 200 : 500,
        detail: reaperturaOk
          ? `cuadre=${reapertura.body.id} · estado=${reapertura.body.estado} · motivo=${reapertura.body.motivo_reapertura}`
          : JSON.stringify(reapertura.body),
      });
      if (!reaperturaOk) {
        throw new Error(
          `La reapertura del cuadre no devolvió estado 'abierta' con motivo_reapertura: ${JSON.stringify(reapertura.body)}`,
        );
      }

      const reaperturaDoble = await request(base, 'POST', `/cuadre-caja/${cuadrePruebaId}/reabrir`, {
        token,
        body: { motivo: 'Prueba de reapertura' },
      });
      const reaperturaDobleOk =
        reaperturaDoble.status === 409 && reaperturaDoble.body.error.code === 'CUADRE_NO_CERRADO';
      results.push({
        name: 'POST /api/cuadre-caja/:id/reabrir (409)',
        status: reaperturaDobleOk ? 409 : 500,
        detail: reaperturaDobleOk
          ? `code=${reaperturaDoble.body.error.code}`
          : JSON.stringify(reaperturaDoble.body),
      });
      if (!reaperturaDobleOk) {
        throw new Error(
          `Reabrir un cuadre ya abierto debía devolver 409 CUADRE_NO_CERRADO: ${JSON.stringify(reaperturaDoble.body)}`,
        );
      }

      const reaperturaMotivoCorto = await request(base, 'POST', `/cuadre-caja/${cuadrePruebaId}/reabrir`, {
        token,
        body: { motivo: 'abc' },
      });
      const reaperturaMotivoCortoOk =
        reaperturaMotivoCorto.status === 422 &&
        reaperturaMotivoCorto.body.error.code === 'VALIDATION_ERROR' &&
        Array.isArray(reaperturaMotivoCorto.body.error.details) &&
        reaperturaMotivoCorto.body.error.details.some((detalle) => detalle.field === 'motivo');
      results.push({
        name: 'POST /api/cuadre-caja/:id/reabrir (motivo corto 422)',
        status: reaperturaMotivoCortoOk ? 422 : 500,
        detail: reaperturaMotivoCortoOk
          ? `code=${reaperturaMotivoCorto.body.error.code} · field=motivo`
          : JSON.stringify(reaperturaMotivoCorto.body),
      });
      if (!reaperturaMotivoCortoOk) {
        throw new Error(
          `Un motivo de reapertura demasiado corto debía devolver 422 VALIDATION_ERROR: ${JSON.stringify(reaperturaMotivoCorto.body)}`,
        );
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

