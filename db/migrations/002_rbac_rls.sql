-- =====================================================================
-- 002_rbac_rls.sql — RBAC multi-rol + Row Level Security (Supabase)
-- Requiere: 001_schema.sql aplicado.
-- Requiere: proyecto Supabase (schema `auth` y roles `anon`, `authenticated`, `service_role`).
--
-- MODELO RBAC
--   usuarios ──< usuario_rol >── roles ──< rol_permiso >── permisos
--   Un usuario puede tener 1..N roles; los permisos se derivan de sus roles.
--
-- ESTRATEGIA DE SEGURIDAD (defensa en profundidad)
--   1. Express es el único cliente de negocio y DEBE usar la service_role
--      key en el backend (bypassa RLS). La service_role NUNCA va al frontend.
--   2. RLS queda habilitado en las 29 tablas y deniega por defecto a
--      `anon` y a `authenticated` sin política.
--   3. Se incluyen políticas de LECTURA para `authenticated` como plantilla
--      por si el frontend migra a Supabase Auth directo. Las escrituras
--      quedan denegadas salvo que se activen las plantillas comentadas.
--   4. Las políticas se apoyan en app_tiene_permiso(codigo), que resuelve
--      el usuario de negocio desde auth.uid() vía usuarios.auth_uid.
--
-- NOTA: este script NO toca tablas ajenas al modelo (p. ej. `mensajes`).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. HABILITAR RLS EN LAS 29 TABLAS DEL MODELO
-- ---------------------------------------------------------------------
DO $do$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'roles','usuarios','usuario_rol','permisos','rol_permiso','configuracion',
    'categorias_platillo','platillos','fichas_tecnicas','insumos','fichas_tecnicas_detalle',
    'movimientos_inventario','proveedores','compras','compra_detalles','pagos_compras',
    'clientes','mesas','cuentas','pedidos','pedido_detalles','pagos',
    'cuadres_caja','gastos','tipos_merma','mermas','devoluciones','activos','mantenimientos'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$do$;

-- ---------------------------------------------------------------------
-- 2. FUNCIONES DE CONTEXTO (SECURITY DEFINER)
--    auth.uid() solo existe en Supabase; se desactiva la validación del
--    cuerpo para permitir ejecutar el script en un PostgreSQL local.
-- ---------------------------------------------------------------------
SET check_function_bodies = off;

CREATE OR REPLACE FUNCTION app_current_usuario_id()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT u.id
  FROM usuarios u
  WHERE u.auth_uid = auth.uid()
    AND u.activo
  LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION app_roles()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE(array_agg(r.nombre ORDER BY r.nombre), ARRAY[]::text[])
  FROM usuario_rol ur
  JOIN roles r ON r.id = ur.rol_id
  WHERE ur.usuario_id = app_current_usuario_id()
    AND r.activo;
$fn$;

CREATE OR REPLACE FUNCTION app_tiene_permiso(p_codigo text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM usuario_rol ur
    JOIN rol_permiso rp ON rp.rol_id = ur.rol_id
    JOIN permisos p     ON p.id = rp.permiso_id
    WHERE ur.usuario_id = app_current_usuario_id()
      AND p.codigo = p_codigo
      AND p.activo
  );
$fn$;

CREATE OR REPLACE FUNCTION app_tiene_rol(p_rol text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM usuario_rol ur
    JOIN roles r ON r.id = ur.rol_id
    WHERE ur.usuario_id = app_current_usuario_id()
      AND r.nombre = p_rol
      AND r.activo
  );
$fn$;

REVOKE ALL ON FUNCTION app_current_usuario_id()      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app_roles()                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app_tiene_permiso(text)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app_tiene_rol(text)           FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION app_current_usuario_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_roles()              TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_tiene_permiso(text)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_tiene_rol(text)      TO authenticated, service_role;

RESET check_function_bodies;

-- ---------------------------------------------------------------------
-- 3. POLÍTICAS ACTIVAS DE LECTURA (rol `authenticated`)
--    Catálogos no sensibles: cualquier usuario autenticado puede leerlos.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS roles_select_authenticated ON roles;
CREATE POLICY roles_select_authenticated
  ON roles FOR SELECT TO authenticated
  USING (activo);

DROP POLICY IF EXISTS permisos_select_authenticated ON permisos;
CREATE POLICY permisos_select_authenticated
  ON permisos FOR SELECT TO authenticated
  USING (activo);

DROP POLICY IF EXISTS rol_permiso_select_authenticated ON rol_permiso;
CREATE POLICY rol_permiso_select_authenticated
  ON rol_permiso FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS configuracion_select_authenticated ON configuracion;
CREATE POLICY configuracion_select_authenticated
  ON configuracion FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS categorias_platillo_select_authenticated ON categorias_platillo;
CREATE POLICY categorias_platillo_select_authenticated
  ON categorias_platillo FOR SELECT TO authenticated
  USING (activo);

DROP POLICY IF EXISTS platillos_select_authenticated ON platillos;
CREATE POLICY platillos_select_authenticated
  ON platillos FOR SELECT TO authenticated
  USING (activo);

DROP POLICY IF EXISTS mesas_select_authenticated ON mesas;
CREATE POLICY mesas_select_authenticated
  ON mesas FOR SELECT TO authenticated
  USING (activa);

-- Un usuario solo ve su propio perfil.
DROP POLICY IF EXISTS usuarios_select_self ON usuarios;
CREATE POLICY usuarios_select_self
  ON usuarios FOR SELECT TO authenticated
  USING (auth_uid = auth.uid());

DROP POLICY IF EXISTS usuario_rol_select_self ON usuario_rol;
CREATE POLICY usuario_rol_select_self
  ON usuario_rol FOR SELECT TO authenticated
  USING (usuario_id = app_current_usuario_id());

-- ---------------------------------------------------------------------
-- 4. POLÍTICAS ACTIVAS POR PERMISO (lectura)
--    Demuestran el patrón; Express sigue siendo la autoridad principal.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS insumos_select_permission ON insumos;
CREATE POLICY insumos_select_permission
  ON insumos FOR SELECT TO authenticated
  USING (app_tiene_permiso('inventario.gestionar') OR app_tiene_permiso('menu.gestionar'));

DROP POLICY IF EXISTS fichas_select_permission ON fichas_tecnicas;
CREATE POLICY fichas_select_permission
  ON fichas_tecnicas FOR SELECT TO authenticated
  USING (app_tiene_permiso('menu.gestionar') OR app_tiene_permiso('inventario.gestionar'));

DROP POLICY IF EXISTS ftd_select_permission ON fichas_tecnicas_detalle;
CREATE POLICY ftd_select_permission
  ON fichas_tecnicas_detalle FOR SELECT TO authenticated
  USING (app_tiene_permiso('menu.gestionar') OR app_tiene_permiso('inventario.gestionar'));

DROP POLICY IF EXISTS mov_inv_select_permission ON movimientos_inventario;
CREATE POLICY mov_inv_select_permission
  ON movimientos_inventario FOR SELECT TO authenticated
  USING (app_tiene_permiso('inventario.gestionar'));

DROP POLICY IF EXISTS clientes_select_permission ON clientes;
CREATE POLICY clientes_select_permission
  ON clientes FOR SELECT TO authenticated
  USING (app_tiene_permiso('venta.registrar') OR app_tiene_permiso('delivery.propio'));

DROP POLICY IF EXISTS cuentas_select_permission ON cuentas;
CREATE POLICY cuentas_select_permission
  ON cuentas FOR SELECT TO authenticated
  USING (app_tiene_permiso('venta.registrar') OR app_tiene_permiso('caja.cobrar'));

DROP POLICY IF EXISTS pedidos_select_permission ON pedidos;
CREATE POLICY pedidos_select_permission
  ON pedidos FOR SELECT TO authenticated
  USING (
    app_tiene_permiso('venta.registrar')
    OR app_tiene_permiso('caja.cobrar')
    OR app_tiene_permiso('cocina.kds')
    OR app_tiene_permiso('delivery.propio')
    OR app_tiene_permiso('delivery.externo')
    OR app_tiene_permiso('devoluciones.gestionar')
  );

DROP POLICY IF EXISTS pedido_detalles_select_permission ON pedido_detalles;
CREATE POLICY pedido_detalles_select_permission
  ON pedido_detalles FOR SELECT TO authenticated
  USING (
    app_tiene_permiso('venta.registrar')
    OR app_tiene_permiso('cocina.kds')
    OR app_tiene_permiso('delivery.propio')
    OR app_tiene_permiso('delivery.externo')
  );

DROP POLICY IF EXISTS pagos_select_permission ON pagos;
CREATE POLICY pagos_select_permission
  ON pagos FOR SELECT TO authenticated
  USING (app_tiene_permiso('caja.cobrar') OR app_tiene_permiso('caja.cuadrar'));

DROP POLICY IF EXISTS proveedores_select_permission ON proveedores;
CREATE POLICY proveedores_select_permission
  ON proveedores FOR SELECT TO authenticated
  USING (app_tiene_permiso('compras.gestionar'));

DROP POLICY IF EXISTS compras_select_permission ON compras;
CREATE POLICY compras_select_permission
  ON compras FOR SELECT TO authenticated
  USING (app_tiene_permiso('compras.gestionar'));

DROP POLICY IF EXISTS compra_detalles_select_permission ON compra_detalles;
CREATE POLICY compra_detalles_select_permission
  ON compra_detalles FOR SELECT TO authenticated
  USING (app_tiene_permiso('compras.gestionar'));

DROP POLICY IF EXISTS pagos_compras_select_permission ON pagos_compras;
CREATE POLICY pagos_compras_select_permission
  ON pagos_compras FOR SELECT TO authenticated
  USING (app_tiene_permiso('compras.gestionar'));

DROP POLICY IF EXISTS cuadres_select_permission ON cuadres_caja;
CREATE POLICY cuadres_select_permission
  ON cuadres_caja FOR SELECT TO authenticated
  USING (app_tiene_permiso('caja.cuadrar'));

DROP POLICY IF EXISTS gastos_select_permission ON gastos;
CREATE POLICY gastos_select_permission
  ON gastos FOR SELECT TO authenticated
  USING (app_tiene_permiso('gastos.registrar'));

DROP POLICY IF EXISTS tipos_merma_select_permission ON tipos_merma;
CREATE POLICY tipos_merma_select_permission
  ON tipos_merma FOR SELECT TO authenticated
  USING (app_tiene_permiso('merma.gestionar'));

DROP POLICY IF EXISTS mermas_select_permission ON mermas;
CREATE POLICY mermas_select_permission
  ON mermas FOR SELECT TO authenticated
  USING (app_tiene_permiso('merma.gestionar'));

DROP POLICY IF EXISTS devoluciones_select_permission ON devoluciones;
CREATE POLICY devoluciones_select_permission
  ON devoluciones FOR SELECT TO authenticated
  USING (app_tiene_permiso('devoluciones.gestionar'));

DROP POLICY IF EXISTS activos_select_permission ON activos;
CREATE POLICY activos_select_permission
  ON activos FOR SELECT TO authenticated
  USING (app_tiene_permiso('activos.gestionar'));

DROP POLICY IF EXISTS mantenimientos_select_permission ON mantenimientos;
CREATE POLICY mantenimientos_select_permission
  ON mantenimientos FOR SELECT TO authenticated
  USING (app_tiene_permiso('activos.gestionar'));

-- ---------------------------------------------------------------------
-- 4.1 PRIVILEGIOS DE LECTURA
--     RLS decide qué filas se ven; GRANT decide si el rol puede consultar
--     la tabla. Supabase suele otorgar estos privilegios por defecto, pero
--     se declaran explícitamente para que las políticas activas funcionen.
-- ---------------------------------------------------------------------
DO $do$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'roles','usuarios','usuario_rol','permisos','rol_permiso','configuracion',
    'categorias_platillo','platillos','fichas_tecnicas','insumos','fichas_tecnicas_detalle',
    'movimientos_inventario','proveedores','compras','compra_detalles','pagos_compras',
    'clientes','mesas','cuentas','pedidos','pedido_detalles','pagos',
    'cuadres_caja','gastos','tipos_merma','mermas','devoluciones','activos','mantenimientos'
  ] LOOP
    EXECUTE format('GRANT SELECT ON TABLE %I TO authenticated', t);
  END LOOP;
END
$do$;

-- ---------------------------------------------------------------------
-- 5. PLANTILLAS DE ESCRITURA (comentadas — activar solo si el frontend
--    deja de usar Express y pasa a escribir directo en Supabase)
-- ---------------------------------------------------------------------
-- Al activarlas, otorgar también los privilegios de tabla y secuencia:
--   GRANT INSERT, UPDATE, DELETE ON pedidos, pagos, mermas, configuracion TO authenticated;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
--
-- CREATE POLICY venta_insert ON pedidos FOR INSERT TO authenticated
--   WITH CHECK (app_tiene_permiso('venta.registrar'));
--
-- CREATE POLICY venta_update ON pedidos FOR UPDATE TO authenticated
--   USING (app_tiene_permiso('venta.registrar'))
--   WITH CHECK (app_tiene_permiso('venta.registrar'));
--
-- CREATE POLICY cobro_insert ON pagos FOR INSERT TO authenticated
--   WITH CHECK (app_tiene_permiso('caja.cobrar'));
--
-- CREATE POLICY merma_insert ON mermas FOR INSERT TO authenticated
--   WITH CHECK (app_tiene_permiso('merma.gestionar'));
--
-- CREATE POLICY merma_update ON mermas FOR UPDATE TO authenticated
--   USING (app_tiene_permiso('merma.gestionar'))
--   WITH CHECK (app_tiene_permiso('merma.gestionar'));
--
-- CREATE POLICY config_all ON configuracion FOR ALL TO authenticated
--   USING (app_tiene_permiso('config.gestionar'))
--   WITH CHECK (app_tiene_permiso('config.gestionar'));

-- ---------------------------------------------------------------------
-- 6. ENDURECIMIENTO OPCIONAL (comentado)
--    Revoca privilegios directos de `anon` sobre las 29 tablas. No se
--    activa por defecto para no afectar otras tablas del mismo proyecto.
-- ---------------------------------------------------------------------
-- DO $do$
-- DECLARE t TEXT;
-- BEGIN
--   FOREACH t IN ARRAY ARRAY[
--     'roles','usuarios','usuario_rol','permisos','rol_permiso','configuracion',
--     'categorias_platillo','platillos','fichas_tecnicas','insumos','fichas_tecnicas_detalle',
--     'movimientos_inventario','proveedores','compras','compra_detalles','pagos_compras',
--     'clientes','mesas','cuentas','pedidos','pedido_detalles','pagos',
--     'cuadres_caja','gastos','tipos_merma','mermas','devoluciones','activos','mantenimientos'
--   ] LOOP
--     EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', t);
--   END LOOP;
-- END
-- $do$;

-- =====================================================================
-- FIN — Resumen de acceso esperado:
--   anon            → sin acceso (sin políticas)
--   authenticated   → lectura según permisos; escritura denegada
--   service_role    → acceso total (bypassa RLS) — solo backend Express
-- =====================================================================
COMMIT;
