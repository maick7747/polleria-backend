-- 006_rpc_stock_total.sql
-- Funciones RPC para reducir round trips y volver atomicas dos operaciones
-- que hoy se hacen con read-modify-write:
--   1) fn_sumar_total_cuenta    -> cuentas.total (evita lost updates)
--   2) fn_aplicar_movimientos_stock -> stock + bitacora en una sola llamada
--
-- No destructivo e idempotente: solo CREATE OR REPLACE FUNCTION.
-- Se ejecuta con la service_role (no requiere GRANT adicional).

-- ---------------------------------------------------------------------
-- Suma (o resta, con p_delta negativo) el total de una cuenta de forma
-- atomica. Nunca deja el total por debajo de cero.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_sumar_total_cuenta(p_cuenta_id integer, p_delta numeric)
RETURNS numeric
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  UPDATE cuentas
     SET total = GREATEST(0, total + COALESCE(p_delta, 0))
   WHERE id = p_cuenta_id
  RETURNING total;
$$;

-- ---------------------------------------------------------------------
-- Aplica N movimientos de inventario en una sola transaccion.
--
-- p_movimientos: [
--   { insumo_id, tipo, cantidad, stock_resultante?, referencia_tipo?,
--     referencia_id?, usuario_id, observacion? }, ...
-- ]
--
-- Reglas (mismas que src/data/db.js applyMovement):
--   * cantidad > 0
--   * stock_resultante explicito manda
--   * tipo 'entrada'/'devolucion' suma; el resto resta
--   * resultado < -0.0005 -> STOCK_INSUFICIENTE: <nombre>
--   * el stock final se acota a >= 0
--
-- Devuelve un jsonb con las filas insertadas en movimientos_inventario.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_aplicar_movimientos_stock(p_movimientos jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item             jsonb;
  v_insumo           insumos%ROWTYPE;
  v_mov              movimientos_inventario%ROWTYPE;
  v_insumo_id        integer;
  v_tipo             text;
  v_cantidad         numeric;
  v_stock_resultante numeric;
  v_nuevo_stock      numeric;
  v_referencia_tipo  varchar(15);
  v_referencia_id    integer;
  v_usuario_id       integer;
  v_observacion      varchar(300);
  v_resultado        jsonb := '[]'::jsonb;
BEGIN
  IF p_movimientos IS NULL OR jsonb_typeof(p_movimientos) <> 'array' THEN
    RETURN v_resultado;
  END IF;

  FOR v_item IN SELECT elem FROM jsonb_array_elements(p_movimientos) AS t(elem)
  LOOP
    v_insumo_id        := NULLIF(v_item->>'insumo_id', '')::integer;
    v_tipo             := NULLIF(v_item->>'tipo', '');
    v_cantidad         := NULLIF(v_item->>'cantidad', '')::numeric;
    v_stock_resultante := NULLIF(v_item->>'stock_resultante', '')::numeric;
    v_referencia_tipo  := NULLIF(v_item->>'referencia_tipo', '');
    v_referencia_id    := NULLIF(v_item->>'referencia_id', '')::integer;
    v_usuario_id       := NULLIF(v_item->>'usuario_id', '')::integer;
    v_observacion      := NULLIF(v_item->>'observacion', '');

    IF v_insumo_id IS NULL THEN
      RAISE EXCEPTION 'MOVIMIENTO_INVALIDO: insumo_id requerido';
    END IF;
    IF v_tipo IS NULL THEN
      RAISE EXCEPTION 'MOVIMIENTO_INVALIDO: tipo requerido (insumo %)', v_insumo_id;
    END IF;
    IF v_cantidad IS NULL OR v_cantidad <= 0 THEN
      RAISE EXCEPTION 'MOVIMIENTO_INVALIDO: cantidad debe ser mayor a cero (insumo %)', v_insumo_id;
    END IF;
    IF v_usuario_id IS NULL THEN
      RAISE EXCEPTION 'MOVIMIENTO_INVALIDO: usuario_id requerido (insumo %)', v_insumo_id;
    END IF;

    SELECT * INTO v_insumo FROM insumos WHERE id = v_insumo_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO: %', v_insumo_id;
    END IF;

    IF v_stock_resultante IS NOT NULL THEN
      v_nuevo_stock := v_stock_resultante;
    ELSIF v_tipo IN ('entrada', 'devolucion') THEN
      v_nuevo_stock := v_insumo.stock_actual + v_cantidad;
    ELSE
      v_nuevo_stock := v_insumo.stock_actual - v_cantidad;
    END IF;

    IF v_nuevo_stock < -0.0005 THEN
      RAISE EXCEPTION 'STOCK_INSUFICIENTE: %', v_insumo.nombre;
    END IF;

    v_nuevo_stock := GREATEST(0, ROUND(v_nuevo_stock, 3));

    UPDATE insumos
       SET stock_actual = v_nuevo_stock,
           actualizado_en = now()
     WHERE id = v_insumo_id;

    INSERT INTO movimientos_inventario (
      insumo_id, tipo, cantidad, stock_resultante,
      referencia_tipo, referencia_id, usuario_id, observacion
    ) VALUES (
      v_insumo_id,
      v_tipo::enum_tipo_movimiento,
      v_cantidad,
      v_nuevo_stock,
      v_referencia_tipo,
      v_referencia_id,
      v_usuario_id,
      v_observacion
    )
    RETURNING * INTO v_mov;

    v_resultado := v_resultado || jsonb_build_array(to_jsonb(v_mov));
  END LOOP;

  RETURN v_resultado;
END;
$$;
