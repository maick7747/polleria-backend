-- =====================================================================
-- 013_kds_v2_estaciones_entrega.sql
-- KDS v2: estaciones, cursos, tiempos de preparación y entrega por línea.
--
--   * enum_estacion (parrilla, frituras, frios, bar)
--   * enum_curso (entrada, fondo, postre)
--   * platillos.estacion / curso / tiempo_prep_min
--   * pedido_detalles.estacion / curso / entregado_en / entregado_por_id
--   * mapeo de los 12 platillos del menú y backfill de líneas
--   * bar nace listo (trigger BEFORE INSERT)
--   * pedido solo-bebidas nace servido (trigger AFTER INSERT; cubre al RPC
--     fn_crear_ronda_y_enviar sin redeclarar su firma ni su retorno)
--   * backfill de entregas históricas y estado_entrega='pendiente'
--
-- Reglas: aditiva e idempotente (IF NOT EXISTS / guardas de catálogo).
-- No destructiva. No se pegó la función fn_crear_ronda_y_enviar completa:
-- el trigger AFTER INSERT cumple el ajuste solicitado para el caso
-- solo-bebidas y también aplica al camino JS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE enum_estacion AS ENUM ('parrilla', 'frituras', 'frios', 'bar');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE enum_curso AS ENUM ('entrada', 'fondo', 'postre');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- 2. COLUMNAS
-- ---------------------------------------------------------------------
ALTER TABLE platillos
  ADD COLUMN IF NOT EXISTS estacion enum_estacion NOT NULL DEFAULT 'parrilla',
  ADD COLUMN IF NOT EXISTS curso enum_curso NOT NULL DEFAULT 'fondo',
  ADD COLUMN IF NOT EXISTS tiempo_prep_min INTEGER;

ALTER TABLE pedido_detalles
  ADD COLUMN IF NOT EXISTS estacion enum_estacion NOT NULL DEFAULT 'parrilla',
  ADD COLUMN IF NOT EXISTS curso enum_curso NOT NULL DEFAULT 'fondo',
  ADD COLUMN IF NOT EXISTS entregado_en TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS entregado_por_id INTEGER REFERENCES usuarios(id);

-- ---------------------------------------------------------------------
-- 3. MAPEO DE LOS 12 PLATILLOS (por nombre, no por id)
-- ---------------------------------------------------------------------
UPDATE platillos p
   SET estacion = v.estacion::enum_estacion,
       curso = v.curso::enum_curso,
       tiempo_prep_min = v.tiempo_prep_min,
       actualizado_en = now()
  FROM (VALUES
    ('Pollo entero a la brasa', 'parrilla', 'fondo',  25),
    ('1/2 Pollo a la brasa',    'parrilla', 'fondo',  20),
    ('1/4 Pollo a la brasa',    'parrilla', 'fondo',  18),
    ('Papa a la huancaína',     'frios',    'entrada', 5),
    ('Arroz chaufa',            'parrilla', 'fondo',   8),
    ('Papas fritas',            'frituras', 'fondo',   6),
    ('Ensalada fresca',         'frios',    'fondo',   3),
    ('Inca Kola 1.5 L',         'bar',      'fondo',   0),
    ('Chicha morada 1 L',       'bar',      'fondo',   0),
    ('Cerveza Cusqueña',        'bar',      'fondo',   0),
    ('Mousse de maracuyá',      'frios',    'postre',  2),
    ('Anticuchos',              'parrilla', 'entrada', 8)
  ) AS v(nombre, estacion, curso, tiempo_prep_min)
 WHERE p.nombre = v.nombre;

-- ---------------------------------------------------------------------
-- 4. BACKFILL DE LÍNEAS
-- ---------------------------------------------------------------------
UPDATE pedido_detalles d
   SET estacion = p.estacion,
       curso = p.curso
  FROM platillos p
 WHERE d.platillo_id = p.id
   AND (d.estacion IS DISTINCT FROM p.estacion OR d.curso IS DISTINCT FROM p.curso);

-- Las bebidas activas que sigan pendientes nacen listas.
UPDATE pedido_detalles
   SET estado_preparacion = 'listo',
       fecha_listo = COALESCE(fecha_listo, now())
 WHERE estacion = 'bar'
   AND estado_preparacion = 'pendiente';

-- Entregas históricas: una línea se considera entregada cuando su pedido
-- ya estaba marcado como entregado y tiene fecha de entrega.
UPDATE pedido_detalles d
   SET entregado_en = p.fecha_entrega
  FROM pedidos p
 WHERE d.pedido_id = p.id
   AND p.estado_entrega = 'entregado'
   AND p.fecha_entrega IS NOT NULL
   AND d.entregado_en IS NULL;

-- Todos los canales usan estado_entrega: los pedidos activos pendientes
-- dejan de tener NULL.
UPDATE pedidos
   SET estado_entrega = 'pendiente'
 WHERE estado_entrega IS NULL
   AND estado IN ('en_cocina', 'servido');

-- ---------------------------------------------------------------------
-- 5. ÍNDICES
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_pedido_detalles_pedido_entrega
  ON pedido_detalles (pedido_id, entregado_en);

CREATE INDEX IF NOT EXISTS idx_pedido_detalles_estacion_estado
  ON pedido_detalles (estacion, estado_preparacion);

CREATE INDEX IF NOT EXISTS idx_platillos_estacion
  ON platillos (estacion);

-- ---------------------------------------------------------------------
-- 6. TRIGGER DE DEFAULTS (BEFORE INSERT)
-- Snapshot de estación/curso desde el platillo y bebidas listas de origen.
-- Es la pieza que mantiene funcionando al RPC fn_crear_ronda_y_enviar.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_pedido_detalle_defaults() RETURNS trigger AS $$
DECLARE
  v_estacion enum_estacion;
  v_curso    enum_curso;
BEGIN
  SELECT estacion, curso INTO v_estacion, v_curso
    FROM platillos
   WHERE id = NEW.platillo_id;

  IF v_estacion IS NOT NULL THEN
    NEW.estacion := v_estacion;
    NEW.curso := v_curso;
  END IF;

  IF NEW.estacion = 'bar' AND NEW.estado_preparacion = 'pendiente' THEN
    NEW.estado_preparacion := 'listo';
    NEW.fecha_listo := COALESCE(NEW.fecha_listo, now());
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pedido_detalle_defaults ON pedido_detalles;
CREATE TRIGGER trg_pedido_detalle_defaults
  BEFORE INSERT ON pedido_detalles
  FOR EACH ROW EXECUTE FUNCTION fn_pedido_detalle_defaults();

-- ---------------------------------------------------------------------
-- 7. TRIGGER DE ESTADO DEL PEDIDO (AFTER INSERT)
-- Si al insertarse una línea todas las líneas del pedido quedan listas
-- (caso solo-bebidas), el pedido pasa a 'servido'. Si luego entra una
-- línea no lista, vuelve a 'en_cocina'. Solo aplica a pedidos activos:
-- borrador, cobrado y cancelado no se tocan.
--
-- Este trigger sustituye al UPDATE que se pedía añadir al RPC: evita
-- redeclarar fn_crear_ronda_y_enviar y también cubre el camino JS.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_pedido_detalles_recalcular_estado() RETURNS trigger AS $$
DECLARE
  v_pedido     pedidos%ROWTYPE;
  v_pendientes integer;
  v_ahora      timestamptz := now();
BEGIN
  SELECT * INTO v_pedido FROM pedidos WHERE id = NEW.pedido_id;
  IF NOT FOUND OR v_pedido.estado NOT IN ('en_cocina', 'servido') THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) FILTER (WHERE estado_preparacion <> 'listo')
    INTO v_pendientes
    FROM pedido_detalles
   WHERE pedido_id = NEW.pedido_id;

  IF v_pendientes = 0 THEN
    IF v_pedido.estado <> 'servido' OR v_pedido.fecha_listo IS NULL THEN
      UPDATE pedidos
         SET estado = 'servido',
             fecha_listo = COALESCE(fecha_listo, v_ahora)
       WHERE id = v_pedido.id;
    END IF;
  ELSIF v_pedido.estado = 'servido' THEN
    UPDATE pedidos
       SET estado = 'en_cocina',
           fecha_listo = NULL
     WHERE id = v_pedido.id;
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pedido_detalles_recalcular_estado ON pedido_detalles;
CREATE TRIGGER trg_pedido_detalles_recalcular_estado
  AFTER INSERT ON pedido_detalles
  FOR EACH ROW EXECUTE FUNCTION fn_pedido_detalles_recalcular_estado();

COMMENT ON COLUMN platillos.estacion IS 'Estación de cocina que prepara el platillo (KDS v2).';
COMMENT ON COLUMN platillos.curso IS 'Curso del menú: entrada, fondo o postre.';
COMMENT ON COLUMN platillos.tiempo_prep_min IS 'Tiempo objetivo de preparación en minutos.';
COMMENT ON COLUMN pedido_detalles.entregado_en IS 'Momento en que la línea se entregó al cliente (KDS v2).';
COMMENT ON COLUMN pedido_detalles.entregado_por_id IS 'Usuario que marcó la línea como entregada.';
