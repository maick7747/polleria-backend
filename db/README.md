# Base de datos — Fratelli's (PostgreSQL / Supabase)

Migraciones y datos demo del **Sistema Web de Gestión Integral para Fratelli's Restaurante**.
Fuente autoritativa del modelo: `Proyecto_Polleria/04_Diseno/Modelado_Datos/04_modelo_fisico.sql`.

| Archivo | Contenido | Cuándo ejecutar |
|---|---|---|
| `migrations/001_schema.sql` | 25 ENUM · 29 tablas · 45 FK · 38 índices · 7 vistas · triggers | Primero, en base vacía o sin estas tablas |
| `seed.sql` | Datos demo (10 mesas, 3 cuentas abiertas, 8 comandas, insumos, configuración) | Después de 001, solo en entorno de demo |
| `migrations/002_rbac_rls.sql` | RLS en las 29 tablas + funciones RBAC + políticas de lectura | Después de 001 (y del seed en demo) |

> **No hay migraciones destructivas.** `001_schema.sql` no ejecuta `DROP TABLE` ni `DROP TYPE`; usa `IF NOT EXISTS` y guardas de catálogo. Re-ejecutarlo no borra datos.

---

## 1. Requisitos

- PostgreSQL 15+ (Supabase usa 15/17).
- Rol con permisos de DDL (`postgres` o `service_role` desde el SQL Editor).
- Extensiones: `pgcrypto` (la crea `001` con `IF NOT EXISTS`; Supabase la instala en `extensions`).

---

## 2. Orden de ejecución en Supabase

1. Abrir **Supabase Dashboard → SQL Editor → New query**.
2. Pegar y ejecutar `migrations/001_schema.sql`. Debe terminar sin errores.
3. Pegar y ejecutar `seed.sql` (solo demo/desarrollo).
4. Pegar y ejecutar `migrations/002_rbac_rls.sql`.
5. Ejecutar las consultas de verificación de §6.

> En producción no se ejecuta `seed.sql`: el orden es `001` → `002`.
> Ejecutar el seed **antes** de `002` evita cualquier dependencia del rol que aplica RLS.

### 2.1 Aplicación automática con `npm run db:apply`

| Comando | Qué aplica |
|---|---|
| `npm run db:apply` | Solo migraciones (esquema). **No** ejecuta `seed.sql`. |
| `npm run db:apply -- --seed` | Migraciones + `db/seed.sql` (solo BD de demo/prueba). |

El script registra las migraciones en `backend/scripts/db-apply.js` (array `FILES_BASE`) y al final compara los conteos con la referencia de las migraciones (**31 tablas / 27 ENUM / 51 FK**). Si hay objetos extra fuera del modelo (p. ej. `mensajes`), lo informa pero no lo trata como error. `node scripts/db-apply.js --help` muestra la ayuda.

> Si el proyecto Supabase ya tiene tablas con el mismo nombre de otro sistema, **no ejecutes estos scripts en ese proyecto**. Usa un proyecto dedicado o, como mínimo, un esquema dedicado (`CREATE SCHEMA fratellis`) y ajusta `search_path`; el modelo actual asume `public`.

---

## 3. Backup antes de aplicar

### 3.1 Supabase Dashboard
- **Database → Backups**: confirmar que existe un backup automático reciente.
- Plan Free: los backups automáticos pueden ser limitados; hacer uno manual antes de cambios.

### 3.2 `pg_dump` (recomendado antes de `002` y `seed`)

```bash
pg_dump "postgresql://postgres:<PASSWORD>@db.<PROJECT_REF>.supabase.co:5432/postgres" \
  --schema=public --no-owner --no-privileges \
  -f backup_fratellis_$(date +%Y%m%d_%H%M).sql
```

En Windows (PowerShell):

```powershell
pg_dump "postgresql://postgres:<PASSWORD>@db.<PROJECT_REF>.supabase.co:5432/postgres" `
  --schema=public --no-owner --no-privileges `
  -f "backup_fratellis_$(Get-Date -Format yyyyMMdd_HHmm).sql"
```

> La contraseña de la base no está en el repositorio. Obtenerla en **Project Settings → Database**. Usar variables de entorno, nunca hardcodearla.

---

## 4. Rollback

`001_schema.sql` es no destructivo, pero si se necesita revertir por completo en un entorno de demo:

```sql
-- Solo en base de DEMO. Elimina datos y objetos del modelo.
DROP VIEW IF EXISTS vw_ventas_por_dia, vw_kpis_dashboard, vw_stock_alertas,
  vw_tiempos_kds, vw_food_cost, vw_merma_por_tipo, vw_devoluciones_tendencia;

DROP TABLE IF EXISTS mantenimientos, activos, devoluciones, mermas, tipos_merma,
  gastos, cuadres_caja, pagos, pedido_detalles, pedidos, cuentas, mesas, clientes,
  movimientos_inventario, pagos_compras, compra_detalles, compras, proveedores,
  fichas_tecnicas_detalle, fichas_tecnicas, insumos, platillos, categorias_platillo,
  configuracion, usuario_rol, rol_permiso, permisos, usuarios, roles CASCADE;

DROP TYPE IF EXISTS enum_categoria_insumo, enum_unidad_medida, enum_tipo_movimiento,
  enum_estado_compra, enum_metodo_pago, enum_canal_pedido, enum_tipo_consumo,
  enum_estado_pedido, enum_estado_pago, enum_estado_cuenta, enum_comprobante_tipo,
  enum_estado_prep, enum_estado_caja, enum_categoria_gasto, enum_clasificacion_merma,
  enum_estado_merma, enum_origen_merma, enum_estado_devolucion, enum_resolucion_devolucion,
  enum_categoria_activo, enum_estado_activo, enum_tipo_mantenimiento,
  enum_estado_mantenimiento, enum_decision_mantenimiento, enum_tipo_documento;
```

Alternativa recomendada: **restaurar el backup** de §3 en lugar de ejecutar el rollback manual.

> `seed.sql` no tiene rollback propio: si se necesita volver atrás, restaurar el backup o truncar las tablas de negocio en orden inverso (solo demo).

---

## 5. Qué hace cada script

### `001_schema.sql`
- Extensión `pgcrypto`.
- 25 tipos ENUM con guardas para re-ejecución.
- 29 tablas en orden de dependencias, con PK, FK, `UNIQUE`, `CHECK` y columnas generadas.
- Índices de FK, fecha, estado y el índice único parcial `uq_cuenta_abierta_mesa` (una cuenta abierta por mesa).
- Trigger `set_updated_at()` en `usuarios`, `configuracion`, `platillos`, `fichas_tecnicas`, `insumos`, `clientes`, `activos`.
- 7 vistas de reporte con `security_invoker = true`.
- `COMMENT ON TABLE/VIEW` con la descripción de cada objeto.

### `002_rbac_rls.sql`
- Habilita RLS en las 29 tablas.
- Crea `app_current_usuario_id()`, `app_roles()`, `app_tiene_permiso()` y `app_tiene_rol()` (`SECURITY DEFINER`).
- Políticas activas:
  - Lectura de catálogos para `authenticated`.
  - Lectura de tablas de negocio condicionada a permisos (p. ej. `caja.cobrar`, `merma.gestionar`).
  - `usuarios`: cada usuario solo ve su propio perfil.
- Escrituras: denegadas por defecto; hay plantillas comentadas para activarlas si el frontend deja de usar Express.
- `anon`: sin acceso.
- `service_role`: bypassa RLS; **solo** debe usarse en el backend.

### `seed.sql`
- Idempotente por catálogo (`ON CONFLICT`) y por bloque operativo (`NOT EXISTS`).
- Usuarios demo con contraseña `demo123` (hash scrypt `salt:hash` compatible con `src/lib/password.js`).
- 3 cuentas abiertas (mesas 3, 5 y 8) y 8 comandas con totales coherentes:
  - IGV 18% solo cuando el subtotal ≥ S/ 70 (`igv_min_soles`).
  - Cuenta 1 = S/ 117.48 · Cuenta 2 = S/ 92.04 · Cuenta 3 = S/ 30.00.
- Un pago de S/ 23.00 (pedido para llevar cobrado) para que el dashboard y el cuadre tengan actividad.
- Una merma aprobada a nivel de platillo (`insumo_id` nulo) para no alterar stock sin movimiento.

---

## 6. Verificación

### 6.1 Conteos estructurales

```sql
-- 29 tablas del modelo
SELECT count(*) AS tablas
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  AND table_name IN (
    'roles','usuarios','usuario_rol','permisos','rol_permiso','configuracion',
    'categorias_platillo','platillos','fichas_tecnicas','insumos','fichas_tecnicas_detalle',
    'movimientos_inventario','proveedores','compras','compra_detalles','pagos_compras',
    'clientes','mesas','cuentas','pedidos','pedido_detalles','pagos',
    'cuadres_caja','gastos','tipos_merma','mermas','devoluciones','activos','mantenimientos'
  );  -- esperado: 29

-- 25 ENUM
SELECT count(*) AS enums
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public' AND t.typtype = 'e'
  AND t.typname LIKE 'enum_%';  -- esperado: 25

-- 45 FK
SELECT count(*) AS fks
FROM information_schema.table_constraints
WHERE constraint_type = 'FOREIGN KEY' AND table_schema = 'public'
  AND table_name IN (
    'roles','usuarios','usuario_rol','permisos','rol_permiso','configuracion',
    'categorias_platillo','platillos','fichas_tecnicas','insumos','fichas_tecnicas_detalle',
    'movimientos_inventario','proveedores','compras','compra_detalles','pagos_compras',
    'clientes','mesas','cuentas','pedidos','pedido_detalles','pagos',
    'cuadres_caja','gastos','tipos_merma','mermas','devoluciones','activos','mantenimientos'
  );  -- esperado: 45

-- 7 vistas
SELECT count(*) AS vistas
FROM information_schema.views
WHERE table_schema = 'public' AND table_name LIKE 'vw_%';  -- esperado: 7
```

### 6.2 Verificación del seed

```sql
SELECT count(*) FROM mesas;                          -- 10
SELECT count(*) FROM cuentas WHERE estado = 'abierta'; -- 3
SELECT count(*) FROM pedidos;                        -- 8
SELECT count(*) FROM pedido_detalles;                -- 12
SELECT count(*) FROM insumos;                        -- 12
SELECT count(*) FROM configuracion;                  -- 8
SELECT count(*) FROM tipos_merma;                    -- 7
SELECT count(*) FROM usuarios;                       -- 5
SELECT count(*) FROM roles;                          -- 6
SELECT count(*) FROM permisos;                       -- 15
SELECT numero, total FROM pedidos ORDER BY numero;    -- totales coherentes
SELECT id, mesa_id, total, estado FROM cuentas ORDER BY id;
```

### 6.3 Verificación de RLS

```sql
SELECT relname, relrowsecurity
FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
  AND relname IN ('pedidos','cuentas','pagos','mermas','usuarios','configuracion')
ORDER BY relname;  -- relrowsecurity = true en todas
```

---

## 7. Uso desde el backend

El backend **no** ejecuta migraciones automáticamente. Variables relevantes:

| Variable | Uso |
|---|---|
| `SUPABASE_URL` | URL del proyecto |
| `SUPABASE_KEY` | Anon/publishable key (solo para Auth o lectura pública) |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave de servicio para tablas de negocio (nunca en frontend) |
| `DB_MODE` | `memory` (default) o `supabase` |

Con `DB_MODE=supabase`, el adaptador `src/data/repository.js` usa Supabase; con `memory`, sigue usando `src/data/store.js`. El arranque actual de la API no cambia: `store.js` continúa siendo el fallback y `npm run smoke` no se ve afectado.

> Para lectura/escritura de tablas con RLS habilitado, el backend debe usar `SUPABASE_SERVICE_ROLE_KEY`. La `SUPABASE_KEY` publishable/anon **no** bypassa RLS.

---

## 8. Riesgos y advertencias

1. **Proyecto compartido con el demo `mensajes`**: estos scripts solo tocan las 29 tablas del modelo, pero comparten `public`. Si se quiere aislamiento total, usar un proyecto Supabase dedicado.
2. **RLS y `anon`**: si alguien conecta el frontend directo a Supabase con la publishable key, no podrá leer tablas de negocio (diseño intencional). La API Express sigue siendo el canal único.
3. **`service_role`**: nunca incluirla en el frontend ni en el repositorio. Si se filtra, rotarla de inmediato en Supabase.
4. **Vistas**: se crean con `security_invoker = true` (PG 15+). En PG 14 o menor, quitar esas líneas.
5. **Datos demo**: `seed.sql` usa fechas relativas (`now() - interval ...`), por lo que los datos se ven recientes en cada ejecución nueva, pero no se actualizan solos.
6. **Identidad**: los IDs son `GENERATED ALWAYS AS IDENTITY`; no insertar IDs manualmente. El seed referencia por claves naturales (email, código, nombre).
7. **Free tier**: Supabase pausa proyectos inactivos ~7 días. Mantener el keep-alive existente o reactivar antes de una demo.
8. **`CREATE TABLE IF NOT EXISTS`**: si una tabla ya existe con otra definición, `001` no la altera. En ese caso, crear una migración incremental (`003_*.sql`) con `ALTER TABLE`.
