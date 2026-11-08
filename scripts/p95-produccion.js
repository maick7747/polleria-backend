'use strict';

// Mide p50/p95/p99 de produccion (lectura de tablero y comando RPC de ronda).
// Uso:
//   npm run p95:prod
//   set P95_BASE_URL=https://.../api&& set P95_TABLERO_N=30&& set P95_RONDA_N=15&& npm run p95:prod
//
// Crea una cuenta de prueba, envia N rondas con enviar_cocina=true y la cancela
// al final (revierte stock y libera la mesa). No imprime token ni secretos.

const BASE = (process.env.P95_BASE_URL || 'https://polleria-backend-useast.onrender.com/api')
  .replace(/\/+$/, '');
const EMAIL = process.env.P95_EMAIL || 'maick@fratellis.pe';
const PASSWORD = process.env.P95_PASSWORD || 'demo123';
const N_TABLERO = Math.max(1, Number(process.env.P95_TABLERO_N) || 20);
const N_RONDA = Math.max(1, Number(process.env.P95_RONDA_N) || 10);

async function request(method, endpoint, options = {}) {
  const headers = {};
  let body;
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const inicio = Date.now();
  const response = await fetch(`${BASE}${endpoint}`, { method, headers, body });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (error) {
    parsed = text;
  }
  return { status: response.status, ok: response.ok, body: parsed, ms: Date.now() - inicio };
}

function percentil(valores, q) {
  if (valores.length === 0) {
    return null;
  }
  const orden = [...valores].sort((a, b) => a - b);
  const posicion = (orden.length - 1) * q;
  const base = Math.floor(posicion);
  const resto = posicion - base;
  const siguiente = orden[base + 1];
  if (siguiente === undefined) {
    return orden[base];
  }
  return orden[base] + resto * (siguiente - orden[base]);
}

function resumen(valores) {
  const redondear = (valor) => (valor === null ? null : Math.round(valor * 10) / 10);
  return {
    n: valores.length,
    min: redondear(Math.min(...valores)),
    p50: redondear(percentil(valores, 0.5)),
    p95: redondear(percentil(valores, 0.95)),
    p99: redondear(percentil(valores, 0.99)),
    max: redondear(Math.max(...valores)),
    media: redondear(valores.reduce((total, valor) => total + valor, 0) / valores.length),
  };
}

async function elegirPlatillo(token, rondas) {
  const [platillos, inventario] = await Promise.all([
    request('GET', '/platillos?limit=100', { token }),
    request('GET', '/inventario?limit=100', { token }),
  ]);
  if (!platillos.ok || !inventario.ok) {
    throw new Error(`No se pudieron leer catálogos (${platillos.status}/${inventario.status}).`);
  }

  const stock = new Map(
    (inventario.body.data || []).map((insumo) => [insumo.id, Number(insumo.stock_actual)]),
  );
  let sinFicha = null;

  for (const platillo of platillos.body.data || []) {
    if (!platillo.activo) {
      continue;
    }
    if (!platillo.ficha) {
      sinFicha = sinFicha || platillo;
      continue;
    }
    const porciones = Number(platillo.ficha.porciones_rendimiento) || 1;
    const alcanza = (platillo.ingredientes || []).every((ingrediente) => {
      const requerido = (Number(ingrediente.cantidad) / porciones) * rondas;
      return (stock.get(ingrediente.insumo_id) || 0) >= requerido * 1.1 + 0.5;
    });
    if (alcanza) {
      return { platillo, conFicha: true };
    }
  }

  if (sinFicha) {
    return { platillo: sinFicha, conFicha: false };
  }
  throw new Error('No hay platillos activos para la prueba.');
}

async function main() {
  const login = await request('POST', '/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
  });
  if (!login.ok || !login.body.token) {
    throw new Error(`Login falló: HTTP ${login.status}`);
  }
  const token = login.body.token;

  const calentamiento = await request('GET', '/venta-local/tablero', { token });
  if (!calentamiento.ok) {
    throw new Error(`Tablero falló en calentamiento: HTTP ${calentamiento.status}`);
  }

  const tablero = [];
  for (let i = 0; i < N_TABLERO; i += 1) {
    const respuesta = await request('GET', '/venta-local/tablero', { token });
    if (!respuesta.ok) {
      throw new Error(`Tablero falló en la muestra ${i + 1}: HTTP ${respuesta.status}`);
    }
    tablero.push(respuesta.ms);
  }

  const mesas = await request('GET', '/mesas?limit=100', { token });
  const libre = (mesas.body.data || []).find((mesa) => mesa.estado === 'libre');
  if (!libre) {
    throw new Error('No hay mesas libres para medir la RPC.');
  }

  const cuenta = await request('POST', '/cuentas', {
    token,
    body: { mesa_id: libre.id },
  });
  if (!cuenta.ok) {
    throw new Error(`Abrir cuenta falló: HTTP ${cuenta.status}`);
  }
  const cuentaId = cuenta.body.id;

  try {
    const { platillo, conFicha } = await elegirPlatillo(token, N_RONDA + 1);
    const cuerpo = (clave) => ({
      items: [{ platillo_id: platillo.id, cantidad: 1 }],
      idempotency_key: clave,
      enviar_cocina: true,
    });

    const calentamientoRonda = await request('POST', `/cuentas/${cuentaId}/pedidos`, {
      token,
      body: cuerpo(`p95-warm-${Date.now()}`),
    });
    if (!calentamientoRonda.ok) {
      throw new Error(`Ronda de calentamiento falló: ${JSON.stringify(calentamientoRonda.body)}`);
    }

    const rondas = [];
    for (let i = 0; i < N_RONDA; i += 1) {
      const respuesta = await request('POST', `/cuentas/${cuentaId}/pedidos`, {
        token,
        body: cuerpo(`p95-${Date.now()}-${i}`),
      });
      if (!respuesta.ok) {
        throw new Error(`Ronda ${i + 1} falló: ${JSON.stringify(respuesta.body)}`);
      }
      if (respuesta.body.origen !== 'rpc') {
        throw new Error(`La ronda ${i + 1} no usó la RPC (origen=${respuesta.body.origen}).`);
      }
      rondas.push(respuesta.ms);
    }

    const cancelacion = await request('POST', `/cuentas/${cuentaId}/cancelar`, {
      token,
      body: { motivo: 'Medición p95 producción' },
    });
    const mesaFinal = await request('GET', `/mesas/${libre.id}`, { token });

    const salida = {
      base: BASE,
      fecha: new Date().toISOString(),
      muestra: {
        tablero: N_TABLERO,
        ronda: N_RONDA,
        platillo: `${platillo.nombre} (id ${platillo.id})`,
        con_ficha: conFicha,
      },
      cold_start_ms: {
        tablero: calentamiento.ms,
        ronda: calentamientoRonda.ms,
      },
      tablero: resumen(tablero),
      ronda_rpc: resumen(rondas),
      limpieza: {
        cuenta: cuentaId,
        cancelada: cancelacion.ok && cancelacion.body.estado === 'cancelada',
        mesa_libre: mesaFinal.ok && mesaFinal.body.estado === 'libre',
      },
    };

    console.log(JSON.stringify(salida, null, 2));
    if (!salida.limpieza.cancelada || !salida.limpieza.mesa_libre) {
      throw new Error('La limpieza de la cuenta de prueba no quedó completa.');
    }
  } catch (error) {
    await request('POST', `/cuentas/${cuentaId}/cancelar`, {
      token,
      body: { motivo: 'Limpieza tras fallo p95' },
    }).catch(() => null);
    throw error;
  }
}

main().catch((error) => {
  console.error('P95 FAIL:', error.message);
  process.exitCode = 1;
});
