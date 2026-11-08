-- 007_rpc_ronda_envio.sql
-- RPC transaccional para la operacion de negocio "agregar ronda" (y,
-- opcionalmente, enviarla a cocina) en una sola llamada.
--
-- Sustituye la secuencia actual:
--   SELECT cuenta -> SELECT caja -> SELECT config -> SELECT platillos
--   -> INSERT pedido -> INSERT lineas -> UPDATE total
--   -> SELECT fichas -> SELECT ingredientes -> SELECT insumos
--   -> RPC stock -> UPDATE pedido -> UPDATE lineas
-- por una sola transaccion PostgreSQL.
--
-- No destructivo e idempotente: solo CREATE OR REPLACE FUNCTION.
-- El backend cae al camino JS si esta funcion no existe (PGRST202/42883).
--
-- Contrato de respuesta (jsonb):
-- {
--   "idempotente": bool,
--   "pedido": { ...fila de pedidos... },
--   "mesa_numero": int | null,
--   "detalles": [ { ...fila de pedido_detalles..., "platillo_nombre": text } ],
--   "movimientos": int
-- }
--
-- Errores esperados (se propagan como mensajes con prefijo):
--   CUENTA_NO_ENCONTRADA, CUENTA_NO_ABIERTA, CAJA_CERRADA,
--   ITEMS_REQUERIDOS, ITEM_INVALIDO, PLATILLO_NO_ENCONTRADO,
--   PLATILLO_INACTIVO, STOCK_INSUFICIENTE: <nombre>, INSUMO_NO_ENCONTRADO
--
-- Reglas replicadas de src/lib/pedidos-db.js:
--   * items: 1..100, cantidad 1..999, notas <= 200
--   * subtotal = SUM(round(cantidad * precio_venta, 2))
--   * IGV = round(subtotal * igv_pct / 100, 2) solo si subtotal >= igv_min_soles
--   * total = subtotal + IGV (sin delivery para venta local)
--   * correlativo PED-YYYY-NNNNNN con advisory lock (evita carreras)
--   * p_enviar=false -> pedido en 'borrador' y sin descuento de stock
--   * p_enviar=true  -> descuenta stock por ficha tecnica, marca 'en_cocina'
--     y las lineas con fecha_inicio_prep; si falta stock, hace ROLLBACK total

CREATE OR REPLACE FUNCTION fn_crear_ronda_y_enviar(
  p_cuenta_id integer,
  p_usuario_id integer,
  p_items jsonb,
  p_observaciones text DEFAULT NULL,
  p_idempotency_key varchar DEFAULT NULL,
  p_enviar boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cuenta           cuentas%ROWTYPE;
  v_cuenta_id        integer := p_cuenta_id;
  v_usuario_id       integer := p_usuario_id;
  v_enviar           boolean := COALESCE(p_enviar, true);
  v_observaciones    varchar(300);
  v_idem_key         varchar(64);
  v_item             jsonb;
  v_items            jsonb := '[]'::jsonb;
  v_platillo         platillos%ROWTYPE;
  v_cantidad         integer;
  v_notas            varchar(200);
  v_subtotal         numeric(10,2) := 0;
  v_igv              numeric(10,2) := 0;
  v_total            numeric(10,2) := 0;
  v_igv_pct          numeric := 0;
  v_igv_min          numeric := 0;
  v_anio             text;
  v_correlativo      integer := 0;
  v_numero           varchar(20);
  v_pedido           pedidos%ROWTYPE;
  v_pedido_previo    pedidos%ROWTYPE;
  v_detalle          pedido_detalles%ROWTYPE;
  v_ahora            timestamptz := now();
  v_movimientos      integer := 0;
  v_req              record;
  v_insumo           insumos%ROWTYPE;
  v_nuevo_stock      numeric(12,3);
  v_mesa_numero      integer;
BEGIN
  IF v_cuenta_id IS NULL OR v_cuenta_id <= 0 THEN
    RAISE EXCEPTION 'CUENTA_NO_ENCONTRADA: %', v_cuenta_id;
  END IF;
  IF v_usuario_id IS NULL OR v_usuario_id <= 0 THEN
    RAISE EXCEPTION 'ITEM_INVALIDO: usuario_id requerido';
  END IF;

  IF p_observaciones IS NOT NULL AND length(p_observaciones) > 300 THEN
    RAISE EXCEPTION 'ITEM_INVALIDO: observaciones supera 300 caracteres';
  END IF;
  v_observaciones := NULLIF(btrim(COALESCE(p_observaciones, '')), '');

  IF p_idempotency_key IS NOT NULL AND length(p_idempotency_key) > 64 THEN
    RAISE EXCEPTION 'ITEM_INVALIDO: idempotency_key supera 64 caracteres';
  END IF;
  v_idem_key := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');

  -- Idempotencia: serializa peticiones con la misma clave y devuelve el
  -- pedido ya creado sin volver a sumar total ni descontar stock.
  IF v_idem_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('fratellis:idem:' || v_idem_key)::bigint);

    SELECT * INTO v_pedido_previo
      FROM pedidos
     WHERE idempotency_key = v_idem_key
     LIMIT 1;

    IF FOUND THEN
      SELECT numero INTO v_mesa_numero
        FROM mesas
       WHERE id = v_pedido_previo.mesa_id;

      RETURN jsonb_build_object(
        'idempotente', true,
        'pedido', to_jsonb(v_pedido_previo),
        'mesa_numero', v_mesa_numero,
        'detalles', COALESCE((
          SELECT jsonb_agg(
                   to_jsonb(d) || jsonb_build_object('platillo_nombre', pl.nombre)
                   ORDER BY d.id
                 )
            FROM pedido_detalles d
            JOIN platillos pl ON pl.id = d.platillo_id
           WHERE d.pedido_id = v_pedido_previo.id
        ), '[]'::jsonb),
        'movimientos', 0
      );
    END IF;
  END IF;

  SELECT * INTO v_cuenta FROM cuentas WHERE id = v_cuenta_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUENTA_NO_ENCONTRADA: %', v_cuenta_id;
  END IF;
  IF v_cuenta.estado <> 'abierta' THEN
    RAISE EXCEPTION 'CUENTA_NO_ABIERTA: %', v_cuenta.estado;
  END IF;

  -- Regla transversal: caja abierta. Misma tolerancia que db.cajaAbierta():
  -- primero el cuadre de la fecha Lima; si el seed uso CURRENT_DATE (UTC),
  -- acepta cualquier cuadre abierto para no bloquear ventas.
  IF NOT EXISTS (
    SELECT 1
      FROM cuadres_caja
     WHERE fecha = (v_ahora AT TIME ZONE 'America/Lima')::date
       AND estado = 'abierta'
  ) AND NOT EXISTS (
    SELECT 1 FROM cuadres_caja WHERE estado = 'abierta'
  ) THEN
    RAISE EXCEPTION 'CAJA_CERRADA';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'ITEMS_REQUERIDOS';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'ITEMS_REQUERIDOS';
  END IF;
  IF jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'ITEM_INVALIDO: maximo 100 items';
  END IF;

  -- Validar items y calcular subtotal con una sola pasada.
  FOR v_item IN SELECT elem FROM jsonb_array_elements(p_items) AS t(elem)
  LOOP
    v_cantidad := NULLIF(v_item->>'cantidad', '')::integer;
    IF v_cantidad IS NULL OR v_cantidad <= 0 OR v_cantidad > 999 THEN
      RAISE EXCEPTION 'ITEM_INVALIDO: cantidad fuera de rango';
    END IF;

    v_notas := NULLIF(v_item->>'notas', '');
    IF v_notas IS NOT NULL AND length(v_notas) > 200 THEN
      RAISE EXCEPTION 'ITEM_INVALIDO: notas supera 200 caracteres';
    END IF;

    SELECT * INTO v_platillo
      FROM platillos
     WHERE id = NULLIF(v_item->>'platillo_id', '')::integer;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PLATILLO_NO_ENCONTRADO: %', v_item->>'platillo_id';
    END IF;
    IF NOT v_platillo.activo THEN
      RAISE EXCEPTION 'PLATILLO_INACTIVO: %', v_platillo.nombre;
    END IF;

    v_subtotal := v_subtotal + ROUND(v_cantidad * v_platillo.precio_venta, 2);
    v_items := v_items || jsonb_build_object(
      'platillo_id', v_platillo.id,
      'platillo_nombre', v_platillo.nombre,
      'cantidad', v_cantidad,
      'precio_unitario', v_platillo.precio_venta,
      'notas', v_notas
    );
  END LOOP;

  v_subtotal := ROUND(v_subtotal, 2);

  SELECT COALESCE(MAX(CASE WHEN clave = 'igv_pct' THEN valor END), '0')::numeric,
         COALESCE(MAX(CASE WHEN clave = 'igv_min_soles' THEN valor END), '0')::numeric
    INTO v_igv_pct, v_igv_min
    FROM configuracion;

  IF v_subtotal > 0 AND v_subtotal >= v_igv_min THEN
    v_igv := ROUND((v_subtotal * v_igv_pct) / 100, 2);
  END IF;
  v_total := ROUND(v_subtotal + v_igv, 2);

  -- Correlativo PED-YYYY-NNNNNN. El advisory lock serializa la lectura del
  -- maximo para que dos rondas concurrentes no generen el mismo numero.
  PERFORM pg_advisory_xact_lock(hashtext('fratellis:pedido_numero')::bigint);
  v_anio := to_char(v_ahora AT TIME ZONE 'America/Lima', 'YYYY');

  SELECT COALESCE(MAX(NULLIF(regexp_replace(numero, '^PED-[0-9]{4}-', ''), '')::integer), 0) + 1
    INTO v_correlativo
    FROM pedidos
   WHERE numero LIKE 'PED-' || v_anio || '-%';

  v_numero := 'PED-' || v_anio || '-' || lpad(v_correlativo::text, 6, '0');

  INSERT INTO pedidos (
    numero, fecha_pedido, canal, tipo_consumo, mesa_id, cuenta_id,
    usuario_cajero_id, estado, estado_pago, subtotal, igv, total,
    comision_plataforma, costo_delivery, observaciones, comprobante_tipo,
    idempotency_key, fecha_inicio_prep, creado_en
  ) VALUES (
    v_numero,
    v_ahora,
    'local'::enum_canal_pedido,
    'sala'::enum_tipo_consumo,
    v_cuenta.mesa_id,
    v_cuenta.id,
    v_usuario_id,
    CASE WHEN v_enviar THEN 'en_cocina'::enum_estado_pedido ELSE 'borrador'::enum_estado_pedido END,
    'pendiente'::enum_estado_pago,
    v_subtotal,
    v_igv,
    v_total,
    0,
    0,
    v_observaciones,
    'boleta'::enum_comprobante_tipo,
    v_idem_key,
    CASE WHEN v_enviar THEN v_ahora ELSE NULL END,
    v_ahora
  )
  RETURNING * INTO v_pedido;

  FOR v_item IN SELECT elem FROM jsonb_array_elements(v_items) AS t(elem)
  LOOP
    INSERT INTO pedido_detalles (
      pedido_id, platillo_id, cantidad, precio_unitario, notas,
      estado_preparacion, fecha_inicio_prep
    ) VALUES (
      v_pedido.id,
      (v_item->>'platillo_id')::integer,
      (v_item->>'cantidad')::integer,
      (v_item->>'precio_unitario')::numeric,
      NULLIF(v_item->>'notas', ''),
      'pendiente'::enum_estado_prep,
      CASE WHEN v_enviar THEN v_ahora ELSE NULL END
    )
    RETURNING * INTO v_detalle;
  END LOOP;

  UPDATE cuentas
     SET total = GREATEST(0, total + v_total)
   WHERE id = v_cuenta.id;

  -- Descuento de stock por ficha tecnica (solo si se envia a cocina).
  IF v_enviar THEN
    FOR v_req IN
      SELECT ftd.insumo_id,
             ROUND(SUM((ftd.cantidad / GREATEST(ft.porciones_rendimiento, 1)) * d.cantidad), 3) AS cantidad
        FROM pedido_detalles d
        JOIN fichas_tecnicas ft
          ON ft.platillo_id = d.platillo_id
         AND ft.activa
        JOIN fichas_tecnicas_detalle ftd
          ON ftd.ficha_id = ft.id
       WHERE d.pedido_id = v_pedido.id
       GROUP BY ftd.insumo_id
       ORDER BY ftd.insumo_id
    LOOP
      IF v_req.cantidad IS NULL OR v_req.cantidad <= 0 THEN
        CONTINUE;
      END IF;

      SELECT * INTO v_insumo FROM insumos WHERE id = v_req.insumo_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO: %', v_req.insumo_id;
      END IF;

      v_nuevo_stock := ROUND(v_insumo.stock_actual - v_req.cantidad, 3);
      IF v_nuevo_stock < -0.0005 THEN
        RAISE EXCEPTION 'STOCK_INSUFICIENTE: %', v_insumo.nombre;
      END IF;
      v_nuevo_stock := GREATEST(0, v_nuevo_stock);

      UPDATE insumos
         SET stock_actual = v_nuevo_stock,
             actualizado_en = v_ahora
       WHERE id = v_insumo.id;

      INSERT INTO movimientos_inventario (
        insumo_id, tipo, cantidad, stock_resultante,
        referencia_tipo, referencia_id, usuario_id, observacion
      ) VALUES (
        v_insumo.id,
        'salida'::enum_tipo_movimiento,
        v_req.cantidad,
        v_nuevo_stock,
        'pedido',
        v_pedido.id,
        v_usuario_id,
        'Consumo del pedido ' || v_numero
      );

      v_movimientos := v_movimientos + 1;
    END LOOP;
  END IF;

  SELECT numero INTO v_mesa_numero FROM mesas WHERE id = v_cuenta.mesa_id;

  RETURN jsonb_build_object(
    'idempotente', false,
    'pedido', to_jsonb(v_pedido),
    'mesa_numero', v_mesa_numero,
    'detalles', COALESCE((
      SELECT jsonb_agg(
               to_jsonb(d) || jsonb_build_object('platillo_nombre', pl.nombre)
               ORDER BY d.id
             )
        FROM pedido_detalles d
        JOIN platillos pl ON pl.id = d.platillo_id
       WHERE d.pedido_id = v_pedido.id
    ), '[]'::jsonb),
    'movimientos', v_movimientos
  );
END;
$$;
