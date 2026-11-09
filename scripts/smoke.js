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

