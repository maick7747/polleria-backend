-- Estado del envío del comprobante a SUNAT.
-- Ver docs/INTEGRACIONES.md.
-- Idempotente: se puede aplicar varias veces sin error.

ALTER TABLE cuentas
  ADD COLUMN IF NOT EXISTS sunat_modo        VARCHAR(12),
  ADD COLUMN IF NOT EXISTS sunat_estado      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS sunat_codigo      VARCHAR(10),
  ADD COLUMN IF NOT EXISTS sunat_mensaje     TEXT,
  ADD COLUMN IF NOT EXISTS sunat_ticket      VARCHAR(40),
  ADD COLUMN IF NOT EXISTS sunat_fecha_envio TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_cuentas_sunat_estado ON cuentas(sunat_estado);
