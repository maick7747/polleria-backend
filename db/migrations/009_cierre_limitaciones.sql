-- =====================================================================
-- 009_cierre_limitaciones.sql
-- Cierra las limitaciones declaradas en las fases 1–3:
--   * usuarios.usuario (login por alias)
--   * pedidos.estado_entrega, motivo/fecha de cancelación
--   * compras.motivo/fecha de cancelación
--   * gastos.actualizado_en (trigger)
--   * devoluciones.registrado_por_id y detalle_resolucion
--   * mantenimientos.fecha_autorizacion
--   * liquidaciones de delivery externo (tabla real)
--   * devolucion_reembolsos (histórico de reembolsos por devolución)
--
-- Reglas: aditiva e idempotente (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF
-- NOT EXISTS / guardas de catálogo). No destructiva.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Usuarios: alias de acceso (hoy derivado del email)
-- ---------------------------------------------------------------------
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS usuario VARCHAR(50);

UPDATE usuarios
SET usuario = split_part(email, '@', 1)
WHERE usuario IS NULL OR btrim(usuario) = '';

CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_usuario
  ON usuarios (usuario);

-- ---------------------------------------------------------------------
-- Pedidos: estado de entrega y anulación con motivo
-- ---------------------------------------------------------------------
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS estado_entrega VARCHAR(20);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS motivo_cancelacion VARCHAR(300);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS fecha_cancelacion TIMESTAMPTZ;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_pedido_estado_entrega'
      AND conrelid = 'pedidos'::regclass
  ) THEN
    ALTER TABLE pedidos
      ADD CONSTRAINT chk_pedido_estado_entrega
      CHECK (estado_entrega IS NULL OR estado_entrega IN ('pendiente', 'en_camino', 'entregado'));
  END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS idx_pedidos_estado_entrega
  ON pedidos (estado_entrega, fecha_pedido DESC);

-- ---------------------------------------------------------------------
-- Compras: anulación con motivo (hoy solo se devuelve en la respuesta)
-- ---------------------------------------------------------------------
ALTER TABLE compras ADD COLUMN IF NOT EXISTS motivo_cancelacion VARCHAR(300);
ALTER TABLE compras ADD COLUMN IF NOT EXISTS fecha_cancelacion TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- Gastos: actualizado_en automático
-- ---------------------------------------------------------------------
ALTER TABLE gastos ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now();

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_gastos_updated_at'
      AND tgrelid = 'gastos'::regclass
  ) THEN
    CREATE TRIGGER trg_gastos_updated_at
      BEFORE UPDATE ON gastos
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END
$do$;

-- ---------------------------------------------------------------------
-- Devoluciones: quién la registró y detalle de la resolución
-- ---------------------------------------------------------------------
ALTER TABLE devoluciones ADD COLUMN IF NOT EXISTS registrado_por_id INTEGER REFERENCES usuarios(id);
ALTER TABLE devoluciones ADD COLUMN IF NOT EXISTS detalle_resolucion TEXT;

-- ---------------------------------------------------------------------
-- Mantenimientos: fecha de autorización
-- ---------------------------------------------------------------------
ALTER TABLE mantenimientos ADD COLUMN IF NOT EXISTS fecha_autorizacion TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- Liquidaciones de delivery externo (hoy derivadas, sin persistencia)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS liquidaciones (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plataforma   VARCHAR(20) NOT NULL CHECK (plataforma IN ('rappi', 'llamafood')),
  desde        DATE,
  hasta        DATE,
  monto_bruto  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (monto_bruto >= 0),
  comision     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (comision >= 0),
  monto_neto   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (monto_neto >= 0),
  estado       VARCHAR(20) NOT NULL DEFAULT 'registrada'
                 CHECK (estado IN ('registrada', 'conciliada', 'anulada')),
  observacion  VARCHAR(300),
  usuario_id   INTEGER REFERENCES usuarios(id),
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_liquidaciones_plataforma_fecha
  ON liquidaciones (plataforma, creado_en DESC);

-- ---------------------------------------------------------------------
-- Reembolsos por devolución (histórico reconstruible)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devolucion_reembolsos (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  devolucion_id  INTEGER NOT NULL REFERENCES devoluciones(id) ON DELETE CASCADE,
  metodo         VARCHAR(20) NOT NULL,
  monto          NUMERIC(10,2) NOT NULL CHECK (monto > 0),
  observacion    VARCHAR(200),
  usuario_id     INTEGER NOT NULL REFERENCES usuarios(id),
  fecha          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_devolucion_reembolsos_devolucion
  ON devolucion_reembolsos (devolucion_id, fecha DESC);

COMMENT ON TABLE liquidaciones IS 'Liquidaciones de delivery externo (Rappi/LlamaFood) con comisión y neto.';
COMMENT ON TABLE devolucion_reembolsos IS 'Reembolsos por devolución (puede haber varios por devolución).';
