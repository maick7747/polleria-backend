-- =====================================================================
-- 018_cobro_requiere_entrega.sql
-- Regla de negocio (2026-11-14): una cuenta solo se cobra cuando TODOS sus
-- platos fueron entregados al cliente.
--
-- El backend ya hace la comprobación antes de llamar a la RPC, pero el
-- candado vive también aquí para que dos terminales no puedan cobrar una
-- cuenta a la que le queda una línea sin `entregado_en` (por ejemplo, si
-- otra terminal entrega/cancela en paralelo).
--
-- No destructivo e idempotente: solo CREATE OR REPLACE FUNCTION con la
-- misma firma de la migración 017.
--
-- Error esperado: PLATOS_NO_ENTREGADOS: <cantidad>
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
  v_cuenta     cuentas%ROWTYPE;
  v_pago       pagos%ROWTYPE;
  v_ahora      timestamptz := now();
  v_pendientes integer := 0;
BEGIN
  -- 1. Candado de entrega: ninguna línea de una ronda no cancelada puede
  --    quedar sin `entregado_en`.
  SELECT COUNT(*)
    INTO v_pendientes
    FROM pedido_detalles d
    JOIN pedidos p ON p.id = d.pedido_id
   WHERE p.cuenta_id = p_cuenta_id
     AND p.estado <> 'cancelado'
     AND d.entregado_en IS NULL;

  IF v_pendientes > 0 THEN
    RAISE EXCEPTION 'PLATOS_NO_ENTREGADOS: %', v_pendientes;
  END IF;

  -- 2. Candado atómico: solo una transacción puede pasar de 'abierta' a
  --    'cobrada'.
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

  -- 3. Rondas de la cuenta: cobradas/pagadas. Las canceladas no se tocan.
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
) IS 'Cobra una cuenta abierta en una transacción. Exige que todas las líneas estén entregadas (migración 018).';
