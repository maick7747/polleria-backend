'use strict';

/**
 * Aplica las migraciones y el seed a PostgreSQL/Supabase.
 *
 * Uso:
 *   1. Copia la cadena de conexión en backend/.env como DATABASE_URL
 *   2. npm run db:apply
 *
 * No se ejecuta automáticamente. No imprime credenciales.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const env = require('../src/config/env');

const FILES_BASE = [
  'migrations/001_schema.sql',
  'migrations/002_rbac_rls.sql',
  'migrations/003_sunat_envio.sql',
  'migrations/004_cliente_cuenta_idempotencia.sql',
  'migrations/005_perf_indexes.sql',
  'migrations/006_rpc_stock_total.sql',
  'migrations/007_rpc_ronda_envio.sql',
  'migrations/008_perf_listas_admin.sql',
  'migrations/009_cierre_limitaciones.sql',
  'migrations/010_realtime.sql',
  'migrations/011_realtime_anon_policy.sql',
  'migrations/012_cuadre_reapertura.sql',
  'migrations/013_kds_v2_estaciones_entrega.sql',
  'migrations/014_turnos_usuario.sql',
  'migrations/015_cliente_correo.sql',
  'migrations/016_rls_cierre_y_realtime.sql',
  'migrations/017_rpc_cobrar_cuenta.sql',
  'seed.sql',
];

// El seed crea cuentas/pedidos demo con clave `demo123`: NUNCA debe correr
// por defecto sobre una base con datos reales. Solo con `-- --seed`.
const incluirSeed = process.argv.includes('--seed');
const FILES = FILES_BASE.filter((file) => incluirSeed || file !== 'seed.sql');

const BASE = path.resolve(__dirname, '../db');

function ayuda() {
  console.log(
    [
      'Uso: node scripts/db-apply.js [--seed]',
      '',
      '  (sin flags)  Aplica solo migraciones (esquema). No siembra demo.',
      '  --seed       Aplica migraciones + db/seed.sql (SOLO para una BD de prueba).',
      '  --help, -h   Muestra esta ayuda.',
      '',
      'Requiere DATABASE_URL (o SUPABASE_DB_URL) en backend/.env.',
      'No imprime credenciales.',
    ].join('\n'),
  );
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  ayuda();
  process.exit(0);
}

function fail(message) {
  console.error(`\n[db:apply] ${message}\n`);
  process.exit(1);
}

function readSql(relative) {
  const file = path.join(BASE, relative);
  if (!fs.existsSync(file)) {
    fail(`No existe el archivo: ${file}`);
  }
  return fs.readFileSync(file, 'utf8');
}

async function applyFile(client, relative) {
  const sql = readSql(relative);
  process.stdout.write(`→ ${relative} ... `);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
    console.log('OK');
  } catch (error) {
    await client.query('ROLLBACK');
    console.log('ERROR');
    throw error;
  }
}

async function verificar(client) {
  const consultas = {
    tablas: `select count(*)::int as n
             from information_schema.tables
             where table_schema = 'public' and table_type = 'BASE TABLE'`,
    enums: `select count(*)::int as n
            from pg_type t
            join pg_namespace n on n.oid = t.typnamespace
            where t.typtype = 'e' and n.nspname = 'public'`,
    fks: `select count(*)::int as n
          from information_schema.table_constraints
          where constraint_schema = 'public' and constraint_type = 'FOREIGN KEY'`,
  };

  const resultado = {};
  for (const [nombre, sql] of Object.entries(consultas)) {
    const { rows } = await client.query(sql);
    resultado[nombre] = rows[0].n;
  }

  // Referencia calculada desde las migraciones (001–016):
  //   29 tablas del modelo
  //   +1 `liquidaciones` y +1 `devolucion_reembolsos` (009) = 31
  //   27 ENUM (001) + enum_estacion/enum_curso (013) ya incluidos
  //   51 FK (001: 45, 004: 1, 009: 4, 013: 1)
  // Puede haber tablas extra fuera del modelo (p. ej. `mensajes`): no es error.
  const REFERENCIA = { tablas: 31, enums: 27, fks: 51 };

  console.log('\n[db:apply] Verificación (referencia de las migraciones):');
  console.log(`  Tablas: ${resultado.tablas} (referencia ${REFERENCIA.tablas})`);
  console.log(`  ENUM:   ${resultado.enums} (referencia ${REFERENCIA.enums})`);
  console.log(`  FK:     ${resultado.fks} (referencia ${REFERENCIA.fks})`);

  const faltantes = Object.entries(REFERENCIA).filter(
    ([nombre, esperado]) => resultado[nombre] < esperado,
  );
  if (faltantes.length > 0) {
    console.warn(
      '\n[db:apply] ADVERTENCIA: faltan objetos respecto de las migraciones. ' +
        'Revisa si el esquema se aplicó parcialmente.',
    );
  } else if (Object.entries(REFERENCIA).some(([nombre, esperado]) => resultado[nombre] > esperado)) {
    console.log(
      '\n[db:apply] Nota: hay objetos adicionales (tablas/ENUM/FK fuera de las ' +
        'migraciones, p. ej. `mensajes`). No es un error.',
    );
  }
  return resultado;
}

async function main() {
  const url = env.databaseUrl;
  if (!url) {
    fail(
      'Falta DATABASE_URL (o SUPABASE_DB_URL) en backend/.env.\n' +
        'Cópiala desde Supabase → Settings → Database → Connection string.\n' +
        'No uses la publishable key: no puede ejecutar DDL.',
    );
  }

  console.log('[db:apply] Conectando a PostgreSQL...');
  const client = new Client({
    connectionString: url,
    ssl: url.includes('supabase.co') || url.includes('pooler.supabase.com')
      ? { rejectUnauthorized: false }
      : undefined,
    application_name: 'fratellis-db-apply',
  });

  try {
    await client.connect();
    console.log(
      `[db:apply] Modo: ${
        incluirSeed ? 'INCLUYE seed (DEMO)' : 'solo esquema/migraciones (sin seed)'
      }`,
    );
    console.log('[db:apply] Conexión OK. Aplicando archivos...\n');

    for (const file of FILES) {
      await applyFile(client, file);
    }

    await verificar(client);
    console.log('\n[db:apply] Listo. Reinicia el backend con DB_MODE=supabase cuando corresponda.\n');
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    await client.end().catch(() => {});
  }
}

main();
