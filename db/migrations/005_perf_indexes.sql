-- 005_perf_indexes.sql
-- Índices de rendimiento para las consultas agregadas del tablero.
-- Aplicar con: npm run db:apply (solo en Supabase/PostgreSQL).

CREATE INDEX IF NOT EXISTS idx_mov_inv_referencia
  ON movimientos_inventario(referencia_tipo, referencia_id);

CREATE INDEX IF NOT EXISTS idx_pedido_detalles_pedido_platillo
  ON pedido_detalles(pedido_id, platillo_id);

CREATE INDEX IF NOT EXISTS idx_fichas_detalle_ficha
  ON fichas_tecnicas_detalle(ficha_id, insumo_id);
