'use strict';

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const compression = require('compression');

const env = require('./config/env');
const authMiddleware = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const { metricsMiddleware, snapshot } = require('./middleware/metrics');

const authRoutes = require('./modules/auth/auth.routes');
const dashboardRoutes = require('./modules/dashboard/dashboard.routes');
const ventaLocalRoutes = require('./modules/venta-local/venta-local.routes');
const cocinaRoutes = require('./modules/cocina/cocina.routes');
const comandasRoutes = require('./modules/comandas/comandas.routes');
const cerrarCuentaRoutes = require('./modules/cerrar-cuenta/cerrar-cuenta.routes');
const deliveryPropioRoutes = require('./modules/delivery-propio/delivery-propio.routes');
const deliveryExternoRoutes = require('./modules/delivery-externo/delivery-externo.routes');
const comprasRoutes = require('./modules/compras/compras.routes');
const inventarioRoutes = require('./modules/inventario/inventario.routes');
const fichasRoutes = require('./modules/fichas/fichas.routes');
const mermaRoutes = require('./modules/merma/merma.routes');
const devolucionesRoutes = require('./modules/devoluciones/devoluciones.routes');
const gastosRoutes = require('./modules/gastos/gastos.routes');
const pagosRoutes = require('./modules/pagos/pagos.routes');
const cuadreCajaRoutes = require('./modules/cuadre-caja/cuadre-caja.routes');
const reportesRoutes = require('./modules/reportes/reportes.routes');
const activosRoutes = require('./modules/activos/activos.routes');
const configuracionRoutes = require('./modules/configuracion/configuracion.routes');
const integracionesRoutes = require('./modules/integraciones/integraciones.routes');

const app = express();

app.disable('x-powered-by');

app.use(compression());

app.use(
  cors({
    origin: env.corsOrigin === '*' ? '*' : env.corsOrigin.split(',').map((item) => item.trim()),
    exposedHeaders: ['ETag', 'X-Request-Id', 'Retry-After'],
  }),
);
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  req.id = req.get('X-Request-Id') || `req_${crypto.randomUUID()}`;
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Métricas por ruta normalizada (ignora /api/health y /api/metrics).
app.use(metricsMiddleware);

if (env.logRequests && env.nodeEnv !== 'test') {
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      console.log(
        `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - startedAt} ms) [${req.id}]`,
      );
    });
    next();
  });
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'fratellis-backend',
    version: '1.0.0',
    environment: env.nodeEnv,
    supabase: Boolean(require('./lib/supabase')),
    timestamp: new Date().toISOString(),
    uptime_sec: Math.round(process.uptime()),
    requestId: req.id,
  });
});

// GET /api/metrics — diagnóstico operativo del proceso.
// No forma parte del contrato de la API ni se consume desde el frontend.
// Solo devuelve agregados en memoria (método, patrón de ruta, duraciones y
// errores 5xx): nunca cuerpos, parámetros, cabeceras ni datos de clientes.
app.get('/api/metrics', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    nota:
      'Diagnóstico operativo. Agregados en memoria del proceso; se reinician ' +
      'con el dyno/servidor. No es parte del contrato de la API.',
    ...snapshot(),
  });
});

app.use('/api/auth', authRoutes);

const protectedApi = express.Router();
protectedApi.use(authMiddleware);

protectedApi.use('/dashboard', dashboardRoutes);
protectedApi.use('/venta-local', ventaLocalRoutes);
protectedApi.use('/clientes', ventaLocalRoutes.clientesRouter);
protectedApi.use('/', ventaLocalRoutes);
protectedApi.use('/kds', cocinaRoutes);
protectedApi.use('/cocina', cocinaRoutes);
protectedApi.use('/comandas', comandasRoutes);
protectedApi.use('/', cocinaRoutes.listosRouter);
protectedApi.use('/', cerrarCuentaRoutes);
protectedApi.use('/cerrar-cuenta', cerrarCuentaRoutes.aliasRouter);
protectedApi.use('/delivery-propio', deliveryPropioRoutes);
protectedApi.use('/delivery-externo', deliveryExternoRoutes);
protectedApi.use('/compras', comprasRoutes);
protectedApi.use('/proveedores', comprasRoutes.proveedoresRouter);
protectedApi.use('/inventario', inventarioRoutes);
protectedApi.use('/', fichasRoutes);
protectedApi.use('/fichas', fichasRoutes.fichasRouter);
protectedApi.use('/', mermaRoutes);
protectedApi.use('/merma', mermaRoutes);
protectedApi.use('/devoluciones', devolucionesRoutes);
protectedApi.use('/gastos', gastosRoutes);
protectedApi.use('/pagos', pagosRoutes);
protectedApi.use('/cuadre-caja', cuadreCajaRoutes);
protectedApi.use('/reportes', reportesRoutes);
protectedApi.use('/activos', activosRoutes);
protectedApi.use('/mantenimientos', activosRoutes.mantenimientosRouter);
protectedApi.use('/', configuracionRoutes);
protectedApi.use('/configuracion', configuracionRoutes);
protectedApi.use('/integraciones', integracionesRoutes);

app.use('/api', protectedApi);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
