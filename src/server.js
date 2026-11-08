'use strict';

const app = require('./app');
const env = require('./config/env');
const supabase = require('./lib/supabase');

const server = app.listen(env.port, () => {
  console.log(`Fratelli's API escuchando en http://localhost:${env.port}/api`);
  console.log(`Entorno: ${env.nodeEnv}`);
  console.log(`Supabase: ${supabase ? 'configurado' : 'no configurado (store en memoria)'}`);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

function shutdown(signal) {
  console.log(`\nSeñal ${signal} recibida. Cerrando servidor...`);
  const forceExit = setTimeout(() => {
    console.error('Cierre forzado por tiempo de espera.');
    process.exit(1);
  }, 10000);
  forceExit.unref();

  server.close((error) => {
    clearTimeout(forceExit);
    if (error) {
      console.error('Error al cerrar el servidor:', error);
      process.exit(1);
    }
    console.log('Servidor cerrado correctamente.');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = server;
