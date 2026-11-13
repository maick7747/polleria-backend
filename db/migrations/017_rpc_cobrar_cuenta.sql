-- =====================================================================
-- 017_rpc_cobrar_cuenta.sql
-- Cobro transaccional de una cuenta de mesa (P1-1 de la auditoría 2026-11-13).
--
-- Sustituye la secuencia del backend:
--   UPDATE pedidos (N) -> UPDATE cuentas -> UPDATE mesas -> INSERT pagos
-- por una sola transacción PostgreSQL. El UPDATE condicional por
-- `estado = 'abierta'` es el candado: si dos cajeros cobran a la vez, solo
-- uno obtiene la fila; el otro recibe CUENTA_NO_ABIERTA y el backend lo
-- mapea a 409. Nunca se insertan dos pagos para la misma cuenta.
--
-- No destructivo e idempotente: solo CREATE OR REPLACE FUNCTION.
-- El backend cae al camino JS si esta función no existe (PGRST202/42883).
--
-- Contrato de respuesta (jsonb):
-- {
--   "cuenta_id": int,
--   "pago": { ...fila de pagos... },
--   "total": numeric,
--   "fecha": timestamptz
-- }
--
-- Errores esperados: CUENTA_NO_ABIERTA (mapear a 409 en el servicio).
-- =====================================================================

CREATE OR REPLACE FUNCTION fn_cobrar_cuenta(
  p_cuenta_id integer,
  p_metodo text,
  p_total numeric,
  p_usuario_id integer,
  p_numero varchar,
  p_sunat_modo varchar DEFAULT NULL,
  p_sunat_estado varchar DEFAULT NULL,
  p_sunat_mensaje text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cuenta cuentas%ROWTYPE;
  v_pago   pagos%ROWTYPE;
  v_ahora  timestamptz := now();
BEGIN
  -- Candado atómico: solo una transacción puede pasar de 'abierta' a 'cobrada'.
  UPDATE cuentas
     SET estado              = 'cobrada',
         total               = p_total,
         fecha_cierre        = v_ahora,
         usuario_cierre_id   = p_usuario_id,
         comprobante_numero  = p_numero,
         sunat_modo          = p_sunat_modo,
         sunat_estado        = p_sunat_estado,
         sunat_codigo        = NULL,
         sunat_mensaje       = p_sunat_mensaje,
         sunat_ticket        = NULL,
         sunat_fecha_envio   = NULL
   WHERE id = p_cuenta_id
     AND estado = 'abierta'
   RETURNING * INTO v_cuenta;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUENTA_NO_ABIERTA: %', p_cuenta_id;
  END IF;

  -- Rondas de la cuenta: cobradas/pagadas. Las canceladas no se tocan.
  UPDATE pedidos
     SET estado             = 'cobrado',
         estado_pago        = 'pagado',
         metodo_pago        = p_metodo::enum_metodo_pago,
         comprobante_numero = p_numero
   WHERE cuenta_id = p_cuenta_id
     AND estado <> 'cancelado';

  INSERT INTO pagos (cuenta_id, metodo, monto, usuario_id, fecha)
  VALUES (p_cuenta_id, p_metodo::enum_metodo_pago, p_total, p_usuario_id, v_ahora)
  RETURNING * INTO v_pago;

  UPDATE mesas
     SET estado = 'libre'
   WHERE id = v_cuenta.mesa_id;

  RETURN jsonb_build_object(
    'cuenta_id', v_cuenta.id,
    'pago', to_jsonb(v_pago),
    'total', p_total,
    'fecha', v_ahora
  );
END;
$$;

COMMENT ON FUNCTION fn_cobrar_cuenta(
  integer, text, numeric, integer, varchar, varchar, varchar, text
) IS 'Cobra una cuenta abierta en una transacción (idempotente por estado).';
