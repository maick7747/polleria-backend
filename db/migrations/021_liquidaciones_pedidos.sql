-- =====================================================================
-- 021_liquidaciones_pedidos.sql
-- Liquidación de delivery externo POR PEDIDOS (conciliación con depósito):
--   * liquidaciones: pedidos, monto_depositado, referencia y diferencia
--   * pedidos: liquidacion_id y liquidado_en (un pedido se liquida una vez)
--   * índices para listar pendientes y armar el detalle de una liquidación
--
-- Reglas: aditiva e idempotente (ADD COLUMN IF NOT EXISTS / CREATE INDEX
-- IF NOT EXISTS). No destructiva y sin datos.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Liquidaciones: alcance por pedidos y conciliación del depósito
-- ---------------------------------------------------------------------
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS pedidos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS monto_depositado NUMERIC(12,2);
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS referencia VARCHAR(60);
ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS diferencia NUMERIC(12,2);

-- ---------------------------------------------------------------------
-- Pedidos: vínculo con la liquidación que los incluye
-- ---------------------------------------------------------------------
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS liquidacion_id INTEGER REFERENCES liquidaciones(id);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS liquidado_en TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- Índices: pendientes por liquidar (parcial) y detalle por liquidación
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_pedidos_por_liquidar
  ON pedidos (canal, id)
  WHERE liquidacion_id IS NULL AND estado <> 'cancelado';

CREATE INDEX IF NOT EXISTS idx_pedidos_liquidacion
  ON pedidos (liquidacion_id);

-- ---------------------------------------------------------------------
-- Documentación de las columnas nuevas
-- ---------------------------------------------------------------------
COMMENT ON COLUMN liquidaciones.pedidos IS
  'Cantidad de pedidos incluidos en la liquidación (0 = liquidación por monto manual).';
COMMENT ON COLUMN liquidaciones.monto_depositado IS
  'Monto que depositó la plataforma; NULL cuando aún no se concilia.';
COMMENT ON COLUMN liquidaciones.referencia IS
  'Referencia del depósito de la plataforma (operación o constancia).';
COMMENT ON COLUMN liquidaciones.diferencia IS
  'monto_depositado - monto_neto (0 = liquidación cuadrada).';
COMMENT ON COLUMN pedidos.liquidacion_id IS
  'Liquidación de delivery externo que incluye el pedido.';
COMMENT ON COLUMN pedidos.liquidado_en IS
  'Momento en que el pedido entró a una liquidación.';
