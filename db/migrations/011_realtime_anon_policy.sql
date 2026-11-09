-- 011_realtime_anon_policy.sql
-- Permite que el rol `anon` (clave publicable usada por el frontend) LEA
-- únicamente los pedidos recientes, para que Supabase Realtime entregue los
-- eventos de `pedidos` y `pedido_detalles` al navegador del mozo.
--
-- Por qué una ventana de 2 días: el aviso KDS -> mozo solo necesita lo que
-- está en curso; no se expone el histórico ni clientes antiguos.
--
-- Idempotente: DROP POLICY IF EXISTS + CREATE POLICY.
-- Las políticas de 002_rbac_rls para `authenticated` no se tocan.

DROP POLICY IF EXISTS pedidos_select_anon_realtime ON public.pedidos;
CREATE POLICY pedidos_select_anon_realtime ON public.pedidos
  FOR SELECT
  TO anon
  USING (fecha_pedido >= (now() - interval '2 days'));

DROP POLICY IF EXISTS pedido_detalles_select_anon_realtime ON public.pedido_detalles;
CREATE POLICY pedido_detalles_select_anon_realtime ON public.pedido_detalles
  FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1
      FROM public.pedidos p
      WHERE p.id = pedido_detalles.pedido_id
        AND p.fecha_pedido >= (now() - interval '2 days')
    )
  );

-- Verificación: deben aparecer 2 políticas con roles {anon}.
SELECT tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('pedidos', 'pedido_detalles')
ORDER BY 1, 2;
