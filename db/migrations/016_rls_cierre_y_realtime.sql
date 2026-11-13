-- =====================================================================
-- 016_rls_cierre_y_realtime.sql
-- Cierra dos huecos de seguridad detectados en la auditoría 2026-11-13:
--
--   1. `liquidaciones` y `devolucion_reembolsos` se crearon en
--      009_cierre_limitaciones.sql, DESPUÉS de que 002_rbac_rls.sql
--      habilitara RLS en las 29 tablas fijas. Quedaron sin RLS: con la
--      clave publishable (pública en el repo) se podían leer montos de
--      comisiones y reembolsos.
--
--   2. 011_realtime_anon_policy.sql abre una ventana móvil de 2 días para
--      que `anon` lea pedidos/pedido_detalles y Realtime entregue eventos.
--      Esa ventana nunca caduca (dirección, referencia y totales quedan
--      expuestos). Realtime ya funciona con el token del usuario, así que
--      la política anon se retira.
--
-- Estrategia (igual que 002): Express es el único cliente de negocio y
-- usa la service_role (bypassa RLS). Para `authenticated` solo se deja
-- LECTURA como plantilla; las escrituras quedan denegadas.
--
-- Idempotente: segura de re-ejecutar (ALTER IF EXISTS + DROP POLICY IF EXISTS).
-- No toca la tabla `mensajes` (fuera del modelo, según 002).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. RLS en las tablas creadas por 009
-- ---------------------------------------------------------------------
ALTER TABLE IF EXISTS liquidaciones          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS devolucion_reembolsos  ENABLE ROW LEVEL SECURITY;

-- RLS decide qué filas se ven; GRANT decide si el rol puede consultar.
-- 002 solo otorgó SELECT a las 29 tablas originales.
GRANT SELECT ON TABLE liquidaciones         TO authenticated;
GRANT SELECT ON TABLE devolucion_reembolsos TO authenticated;

DROP POLICY IF EXISTS liquidaciones_select_authenticated ON liquidaciones;
CREATE POLICY liquidaciones_select_authenticated
  ON liquidaciones FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS devolucion_reembolsos_select_authenticated ON devolucion_reembolsos;
CREATE POLICY devolucion_reembolsos_select_authenticated
  ON devolucion_reembolsos FOR SELECT TO authenticated
  USING (true);

-- ---------------------------------------------------------------------
-- 2. Cerrar la ventana anon de Realtime (nombres exactos de 011)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS pedidos_select_anon_realtime          ON public.pedidos;
DROP POLICY IF EXISTS pedido_detalles_select_anon_realtime  ON public.pedido_detalles;

-- ---------------------------------------------------------------------
-- 3. Realtime sin exponer filas: aviso por BROADCAST público
--    El frontend solo necesita saber "algo cambió" para refrescar por la
--    API autenticada. El payload NO lleva datos de la fila (ni dirección,
--    ni totales, ni platos): solo tabla y operación.
--
--    `realtime.send(..., private => false)` publica en el canal público
--    `fratelli-cambios`, que el navegador escucha con la clave publishable.
--    La función atrapa cualquier error: un fallo de Realtime nunca debe
--    bloquear una venta.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_avisar_cambio_pedido()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object('tabla', TG_TABLE_NAME, 'operacion', TG_OP),
    'cambio',
    'fratelli-cambios',
    false
  );
  RETURN NULL;
EXCEPTION
  WHEN undefined_function THEN
    RETURN NULL;  -- entorno sin Realtime: el polling sigue cubriendo
  WHEN OTHERS THEN
    RETURN NULL;  -- nunca romper el INSERT/UPDATE por el aviso
END;
$$;

DROP TRIGGER IF EXISTS trg_pedidos_aviso_realtime ON public.pedidos;
CREATE TRIGGER trg_pedidos_aviso_realtime
  AFTER INSERT OR UPDATE OR DELETE ON public.pedidos
  FOR EACH ROW EXECUTE FUNCTION public.fn_avisar_cambio_pedido();

DROP TRIGGER IF EXISTS trg_pedido_detalles_aviso_realtime ON public.pedido_detalles;
CREATE TRIGGER trg_pedido_detalles_aviso_realtime
  AFTER INSERT OR UPDATE OR DELETE ON public.pedido_detalles
  FOR EACH ROW EXECUTE FUNCTION public.fn_avisar_cambio_pedido();

COMMENT ON FUNCTION public.fn_avisar_cambio_pedido() IS
  'Emite un broadcast sin datos cuando cambia pedidos/pedido_detalles (Realtime KDS-mozo).';

-- ---------------------------------------------------------------------
-- 4. Verificación rápida (se muestra en el resultado del SQL Editor)
--    Esperado: 2 filas para liquidaciones/devolucion_reembolsos
--    (roles {authenticated}) y 0 filas con rol {anon}.
-- ---------------------------------------------------------------------
SELECT tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'liquidaciones',
    'devolucion_reembolsos',
    'pedidos',
    'pedido_detalles'
  )
ORDER BY tablename, policyname;

COMMIT;
