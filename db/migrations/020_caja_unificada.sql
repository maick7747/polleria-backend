-- =====================================================================
-- 020_caja_unificada.sql
-- Caja unificada (2026-11-19): la cuenta deja de ser exclusiva de las mesas.
--
-- Objetivo:
--   * Toda venta que se cobra en caja (mesa, mostrador y delivery propio)
--     tiene una cuenta, aunque no tenga mesa.
--   * `pagos` siempre cuelga de una cuenta. `pedido_id` queda como detalle
--     de trazabilidad (qué ronda se pagó), no como sujeto alternativo.
--   * El cobro de mostrador y el contraentrega usan la misma RPC
--     `fn_cobrar_cuenta` que la mesa.
--
-- Delivery externo (Rappi / LlamaFood) NO recibe cuenta: lo liquida la
-- plataforma y no entra a la caja física.
--
-- Idempotente: se puede volver a ejecutar sin duplicar cuentas ni pagos.
-- =====================================================================

BEGIN;

-- 1. La mesa pasa a ser opcional; el canal se guarda en la cuenta.
ALTER TABLE cuentas ALTER COLUMN mesa_id DROP NOT NULL;
ALTER TABLE cuentas
  ADD COLUMN IF NOT EXISTS tipo_servicio enum_tipo_consumo NOT NULL DEFAULT 'sala';

-- Una cuenta de sala sí exige mesa (misma regla que pedidos.chk_pedido_sala).
ALTER TABLE cuentas DROP CONSTRAINT IF EXISTS chk_cuenta_sala;
ALTER TABLE cuentas
  ADD CONSTRAINT chk_cuenta_sala
  CHECK (tipo_servicio <> 'sala' OR mesa_id IS NOT NULL);

-- 2. El pago puede apuntar a la cuenta y, además, al pedido que lo originó.
ALTER TABLE pagos DROP CONSTRAINT IF EXISTS chk_pago_sujeto;
ALTER TABLE pagos
  ADD CONSTRAINT chk_pago_sujeto
  CHECK (cuenta_id IS NOT NULL OR pedido_id IS NOT NULL);

-- 3. Backfill: pedidos históricos de mostrador y delivery propio sin cuenta.
--    Se agrupan de uno en uno: cada pedido sin cuenta genera su propia cuenta
--    (una venta = una cuenta), se enlaza el pedido y se reenganchan sus pagos.
DO $$
DECLARE
  r RECORD;
  v_cuenta_id integer;
BEGIN
  FOR r IN
    SELECT p.*
      FROM pedidos p
     WHERE p.cuenta_id IS NULL
       AND p.tipo_consumo IN ('para_llevar', 'delivery')
       AND (
         p.tipo_consumo = 'para_llevar'
         OR (p.tipo_consumo = 'delivery' AND p.canal::text IN ('whatsapp', 'telefono', 'local'))
       )
     ORDER BY p.id
  LOOP
    INSERT INTO cuentas (
      mesa_id,
      tipo_servicio,
      estado,
      total,
      fecha_apertura,
      usuario_apertura_id,
      fecha_cierre,
      usuario_cierre_id,
      comprobante_tipo,
      comprobante_numero
    )
    VALUES (
      NULL,
      r.tipo_consumo,
      CASE WHEN r.estado = 'cobrado' THEN 'cobrada'::enum_estado_cuenta ELSE 'abierta'::enum_estado_cuenta END,
      COALESCE(r.total, 0),
      COALESCE(r.fecha_pedido, now()),
      r.usuario_cajero_id,
      CASE WHEN r.estado = 'cobrado'
           THEN COALESCE(r.fecha_entrega, r.fecha_pedido, now())
           ELSE NULL END,
      CASE WHEN r.estado = 'cobrado' THEN r.usuario_cajero_id ELSE NULL END,
      COALESCE(r.comprobante_tipo, 'ticket'),
      r.comprobante_numero
    )
    RETURNING id INTO v_cuenta_id;

    UPDATE pedidos
       SET cuenta_id = v_cuenta_id
     WHERE id = r.id;

    UPDATE pagos
       SET cuenta_id = v_cuenta_id
     WHERE pedido_id = r.id
       AND cuenta_id IS NULL;
  END LOOP;
END $$;

-- 4. Índice para la Caja: cuentas abiertas por canal.
CREATE INDEX IF NOT EXISTS idx_cuentas_abiertas_tipo
  ON cuentas (tipo_servicio, id DESC)
  WHERE estado = 'abierta';

COMMIT;

-- Verificación sugerida:
--   SELECT tipo_servicio, estado, count(*) FROM cuentas GROUP BY 1, 2 ORDER BY 1, 2;
--   SELECT count(*) FROM pedidos WHERE tipo_consumo <> 'sala' AND cuenta_id IS NULL;
--   SELECT count(*) FROM pagos WHERE cuenta_id IS NULL AND pedido_id IS NOT NULL;
