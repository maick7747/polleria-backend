-- =====================================================================
-- 008_perf_listas_admin.sql
-- Índices compuestos para las listas administrativas de la Fase 1
-- (compras, gastos, mermas, devoluciones, activos, usuarios) y para
-- las listas que ya paginan (pedidos, cuentas, pagos, inventario).
--
-- Reglas del proyecto:
--   * Aditiva e idempotente: CREATE INDEX IF NOT EXISTS.
--   * No destructiva: no borra ni renombra nada.
-- =====================================================================

-- Ventas / KDS / cuentas
CREATE INDEX IF NOT EXISTS idx_pedidos_estado_fecha
  ON pedidos (estado, fecha_pedido DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_canal_fecha
  ON pedidos (canal, fecha_pedido DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_fecha_listo
  ON pedidos (fecha_listo DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_cuenta_fecha
  ON pedidos (cuenta_id, fecha_pedido DESC);
CREATE INDEX IF NOT EXISTS idx_cuentas_estado_fecha
  ON cuentas (estado, fecha_apertura DESC);
CREATE INDEX IF NOT EXISTS idx_pagos_cuenta_fecha
  ON pagos (cuenta_id, fecha DESC);

-- Compras y proveedores
CREATE INDEX IF NOT EXISTS idx_compras_estado_fecha
  ON compras (estado, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_compras_proveedor_fecha
  ON compras (proveedor_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_compras_fecha
  ON compras (fecha DESC);
CREATE INDEX IF NOT EXISTS idx_proveedores_razon_social
  ON proveedores (razon_social);

-- Gastos
CREATE INDEX IF NOT EXISTS idx_gastos_categoria_fecha
  ON gastos (categoria, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_gastos_fecha
  ON gastos (fecha DESC);

-- Merma y devoluciones
CREATE INDEX IF NOT EXISTS idx_mermas_estado_fecha
  ON mermas (estado, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_mermas_tipo_fecha
  ON mermas (tipo_merma_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_devoluciones_estado_fecha
  ON devoluciones (estado, fecha_reporte DESC);
CREATE INDEX IF NOT EXISTS idx_devoluciones_fecha
  ON devoluciones (fecha_reporte DESC);

-- Inventario
CREATE INDEX IF NOT EXISTS idx_movimientos_tipo_fecha
  ON movimientos_inventario (tipo, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_insumos_activo_nombre
  ON insumos (activo, nombre);
