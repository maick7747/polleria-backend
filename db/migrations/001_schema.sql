-- =====================================================================
-- 001_schema.sql — Esquema canónico Fratelli's
-- Fuente autoritativa: Proyecto_Polleria/04_Diseno/Modelado_Datos/04_modelo_fisico.sql
-- Motor: PostgreSQL 15+ (Supabase)
-- Contenido: 25 ENUM · 29 tablas · 45 FK · 7 vistas
--
-- CARACTERÍSTICAS
--   * No destructivo: NO ejecuta DROP TABLE / DROP TYPE.
--   * Re-ejecutable: usa IF NOT EXISTS / guardas de catálogo.
--   * No modifica tablas ajenas al modelo (p. ej. `mensajes` del demo).
--
-- ORDEN: 001 → seed.sql (demo) → 002 (RLS). En producción: 001 → 002.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. EXTENSIONES
-- ---------------------------------------------------------------------
-- pgcrypto: disponible en Supabase; no se usa en el esquema, pero evita
-- fallos si más adelante se agregan gen_random_uuid()/crypt().
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- 1. DOMINIOS CERRADOS (25 ENUM)
-- ---------------------------------------------------------------------
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_categoria_insumo' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_categoria_insumo AS ENUM ('alimento','bebida','limpieza','empaque','insumo_general')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_unidad_medida' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_unidad_medida AS ENUM ('kg','g','l','ml','und','docena')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_tipo_movimiento' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_tipo_movimiento AS ENUM ('entrada','salida','merma','ajuste','devolucion')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_estado_compra' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_estado_compra AS ENUM ('ordenada','recibida','cancelada')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_metodo_pago' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_metodo_pago AS ENUM ('efectivo','tarjeta','yape','plin','transferencia')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_canal_pedido' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_canal_pedido AS ENUM ('local','whatsapp','delivery_propio','rappi','llamafood')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_tipo_consumo' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_tipo_consumo AS ENUM ('sala','para_llevar','delivery')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_estado_pedido' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_estado_pedido AS ENUM ('borrador','en_cocina','servido','cobrado','cancelado')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_estado_pago' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_estado_pago AS ENUM ('pendiente','pagado','contraentrega_pendiente')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_estado_cuenta' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_estado_cuenta AS ENUM ('abierta','cobrada','cancelada')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_comprobante_tipo' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_comprobante_tipo AS ENUM ('ticket','boleta','ninguno')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_estado_prep' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_estado_prep AS ENUM ('pendiente','en_preparacion','listo')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_estado_caja' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_estado_caja AS ENUM ('abierta','cerrada')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_categoria_gasto' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_categoria_gasto AS ENUM ('servicios_basicos','alquiler','mantenimiento','personal','transporte','limpieza','impuestos','otros')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_clasificacion_merma' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_clasificacion_merma AS ENUM ('evitable','inevitable')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_estado_merma' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_estado_merma AS ENUM ('pendiente','aprobada','rechazada')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_origen_merma' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_origen_merma AS ENUM ('registro_manual','devolucion','cancelacion')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_estado_devolucion' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_estado_devolucion AS ENUM ('pendiente','aceptada','rechazada')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_resolucion_devolucion' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_resolucion_devolucion AS ENUM ('re_preparar','corregir','reembolso_total','reembolso_parcial')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_categoria_activo' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_categoria_activo AS ENUM ('cocina','salon','delivery','oficina','limpieza')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_estado_activo' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_estado_activo AS ENUM ('activo','en_reparacion','dado_de_baja')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_tipo_mantenimiento' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_tipo_mantenimiento AS ENUM ('preventivo','correctivo')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_estado_mantenimiento' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_estado_mantenimiento AS ENUM ('programado','en_proceso','completado')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_decision_mantenimiento' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_decision_mantenimiento AS ENUM ('reparar','reemplazar')$ddl$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'enum_tipo_documento' AND n.nspname = 'public') THEN
    EXECUTE $ddl$CREATE TYPE enum_tipo_documento AS ENUM ('DNI','RUC')$ddl$;
  END IF;
END
$do$;

-- ---------------------------------------------------------------------
-- 2. FUNCIÓN DE AUDITORÍA (actualizado_en)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $fn$
BEGIN
  NEW.actualizado_en = now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

-- =====================================================================
-- 3. TABLAS
-- =====================================================================

-- ---------------------------------------------------------------------
-- DOMINIO A — SEGURIDAD (RBAC) Y CONFIGURACIÓN
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre      VARCHAR(50)  NOT NULL UNIQUE,
  descripcion VARCHAR(200),
  activo      BOOLEAN      NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS usuarios (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auth_uid       UUID UNIQUE,
  nombre         VARCHAR(120) NOT NULL,
  email          VARCHAR(150) NOT NULL UNIQUE,
  password_hash  VARCHAR(255),
  telefono       VARCHAR(20),
  activo         BOOLEAN NOT NULL DEFAULT TRUE,
  ultimo_acceso  TIMESTAMPTZ,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usuario_rol (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  rol_id     INTEGER NOT NULL REFERENCES roles(id),
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, rol_id)
);

CREATE TABLE IF NOT EXISTS permisos (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo      VARCHAR(60)  NOT NULL UNIQUE,
  descripcion VARCHAR(150) NOT NULL,
  modulo      VARCHAR(40)  NOT NULL,
  activo      BOOLEAN      NOT NULL DEFAULT TRUE,
  creado_en   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rol_permiso (
  rol_id     INTEGER NOT NULL REFERENCES roles(id),
  permiso_id INTEGER NOT NULL REFERENCES permisos(id),
  PRIMARY KEY (rol_id, permiso_id)
);

CREATE TABLE IF NOT EXISTS configuracion (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clave          VARCHAR(60)  NOT NULL UNIQUE,
  valor          VARCHAR(100) NOT NULL,
  descripcion    VARCHAR(200),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- DOMINIO B — MENÚ Y FICHAS TÉCNICAS
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS categorias_platillo (
  id     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre VARCHAR(80) NOT NULL UNIQUE,
  orden  INTEGER NOT NULL DEFAULT 1,
  activo BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS platillos (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  categoria_id   INTEGER NOT NULL REFERENCES categorias_platillo(id),
  nombre         VARCHAR(120) NOT NULL,
  descripcion    VARCHAR(300),
  precio_venta   NUMERIC(10,2) NOT NULL CHECK (precio_venta >= 0),
  imagen_url     VARCHAR(255),
  activo         BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fichas_tecnicas (
  id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platillo_id           INTEGER NOT NULL UNIQUE REFERENCES platillos(id),
  porciones_rendimiento INTEGER NOT NULL DEFAULT 1 CHECK (porciones_rendimiento > 0),
  costo_total           NUMERIC(10,2) NOT NULL DEFAULT 0,
  notas                 TEXT,
  activa                BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en             TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS insumos (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo           VARCHAR(20) NOT NULL UNIQUE,
  nombre           VARCHAR(120) NOT NULL,
  categoria        enum_categoria_insumo NOT NULL,
  unidad_medida    enum_unidad_medida NOT NULL,
  stock_actual     NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (stock_actual >= 0),
  stock_minimo     NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (stock_minimo >= 0),
  umbral_merma_pct NUMERIC(5,2) DEFAULT 0,
  costo_promedio   NUMERIC(12,4) NOT NULL DEFAULT 0,
  activo           BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fichas_tecnicas_detalle (
  id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ficha_id  INTEGER NOT NULL REFERENCES fichas_tecnicas(id) ON DELETE CASCADE,
  insumo_id INTEGER NOT NULL REFERENCES insumos(id),
  cantidad  NUMERIC(12,3) NOT NULL CHECK (cantidad > 0),
  UNIQUE (ficha_id, insumo_id)
);

-- ---------------------------------------------------------------------
-- DOMINIO C — INVENTARIO Y COMPRAS
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS movimientos_inventario (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  insumo_id        INTEGER NOT NULL REFERENCES insumos(id),
  tipo             enum_tipo_movimiento NOT NULL,
  cantidad         NUMERIC(12,3) NOT NULL CHECK (cantidad > 0),
  stock_resultante NUMERIC(12,3),
  referencia_tipo  VARCHAR(15),
  referencia_id    INTEGER,
  usuario_id       INTEGER NOT NULL REFERENCES usuarios(id),
  observacion      VARCHAR(300),
  fecha            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proveedores (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ruc             CHAR(11) NOT NULL UNIQUE CHECK (ruc ~ '^[0-9]{11}$'),
  razon_social    VARCHAR(150) NOT NULL,
  contacto_nombre VARCHAR(120),
  telefono        VARCHAR(20),
  direccion       VARCHAR(200),
  email           VARCHAR(150),
  activo          BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS compras (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proveedor_id    INTEGER NOT NULL REFERENCES proveedores(id),
  fecha           DATE NOT NULL DEFAULT CURRENT_DATE,
  estado          enum_estado_compra NOT NULL DEFAULT 'ordenada',
  total           NUMERIC(10,2) NOT NULL DEFAULT 0,
  usuario_id      INTEGER NOT NULL REFERENCES usuarios(id),
  notas           TEXT,
  fecha_recepcion DATE,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS compra_detalles (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  compra_id       INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
  insumo_id       INTEGER NOT NULL REFERENCES insumos(id),
  cantidad        NUMERIC(12,3) NOT NULL CHECK (cantidad > 0),
  precio_unitario NUMERIC(12,4) NOT NULL CHECK (precio_unitario >= 0),
  subtotal        NUMERIC(12,2) GENERATED ALWAYS AS (ROUND(cantidad * precio_unitario, 2)) STORED,
  UNIQUE (compra_id, insumo_id)
);

CREATE TABLE IF NOT EXISTS pagos_compras (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  compra_id   INTEGER NOT NULL REFERENCES compras(id),
  fecha       DATE NOT NULL DEFAULT CURRENT_DATE,
  metodo      VARCHAR(12) NOT NULL CHECK (metodo IN ('efectivo','transferencia')),
  monto       NUMERIC(10,2) NOT NULL CHECK (monto > 0),
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id),
  observacion VARCHAR(200)
);

-- ---------------------------------------------------------------------
-- DOMINIO D — VENTAS Y COCINA (KDS)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS clientes (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre           VARCHAR(120) NOT NULL,
  tipo_documento   enum_tipo_documento,
  numero_documento VARCHAR(11),
  telefono         VARCHAR(20),
  direccion        VARCHAR(200),
  referencia       VARCHAR(150),
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_cliente_documento UNIQUE (tipo_documento, numero_documento)
);

CREATE TABLE IF NOT EXISTS mesas (
  id     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero INTEGER NOT NULL UNIQUE CHECK (numero BETWEEN 1 AND 50),
  estado VARCHAR(10) NOT NULL DEFAULT 'libre' CHECK (estado IN ('libre','ocupada')),
  activa BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS cuentas (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mesa_id             INTEGER NOT NULL REFERENCES mesas(id),
  estado              enum_estado_cuenta NOT NULL DEFAULT 'abierta',
  total               NUMERIC(10,2) NOT NULL DEFAULT 0,
  fecha_apertura      TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_apertura_id INTEGER NOT NULL REFERENCES usuarios(id),
  fecha_cierre        TIMESTAMPTZ,
  usuario_cierre_id   INTEGER REFERENCES usuarios(id),
  comprobante_tipo    enum_comprobante_tipo NOT NULL DEFAULT 'boleta',
  comprobante_numero  VARCHAR(20),
  CONSTRAINT chk_cuenta_cerrada CHECK (estado <> 'cobrada' OR fecha_cierre IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS pedidos (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero              VARCHAR(20) NOT NULL UNIQUE,
  fecha_pedido        TIMESTAMPTZ NOT NULL DEFAULT now(),
  canal               enum_canal_pedido NOT NULL,
  tipo_consumo        enum_tipo_consumo NOT NULL,
  mesa_id             INTEGER REFERENCES mesas(id),
  cuenta_id           INTEGER REFERENCES cuentas(id),
  cliente_id          INTEGER REFERENCES clientes(id),
  repartidor_id       INTEGER REFERENCES usuarios(id),
  usuario_cajero_id   INTEGER NOT NULL REFERENCES usuarios(id),
  estado              enum_estado_pedido NOT NULL DEFAULT 'borrador',
  estado_pago         enum_estado_pago NOT NULL DEFAULT 'pendiente',
  metodo_pago         enum_metodo_pago,
  subtotal            NUMERIC(10,2) NOT NULL DEFAULT 0,
  igv                 NUMERIC(10,2) NOT NULL DEFAULT 0,
  total               NUMERIC(10,2) NOT NULL DEFAULT 0,
  comision_plataforma NUMERIC(10,2) NOT NULL DEFAULT 0,
  costo_delivery      NUMERIC(10,2) NOT NULL DEFAULT 0,
  direccion_entrega   VARCHAR(200),
  referencia_entrega  VARCHAR(150),
  observaciones       VARCHAR(300),
  comprobante_tipo    enum_comprobante_tipo NOT NULL DEFAULT 'ticket',
  comprobante_numero  VARCHAR(20),
  fecha_inicio_prep   TIMESTAMPTZ,
  fecha_listo         TIMESTAMPTZ,
  fecha_entrega       TIMESTAMPTZ,
  creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_pedido_totales CHECK (total >= 0 AND subtotal >= 0),
  CONSTRAINT chk_pedido_sala CHECK (tipo_consumo <> 'sala' OR mesa_id IS NOT NULL),
  CONSTRAINT chk_pedido_delivery CHECK (tipo_consumo <> 'delivery' OR direccion_entrega IS NOT NULL),
  CONSTRAINT chk_pago_metodo CHECK (estado_pago <> 'pagado' OR metodo_pago IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS pedido_detalles (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pedido_id          INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  platillo_id        INTEGER NOT NULL REFERENCES platillos(id),
  cantidad           INTEGER NOT NULL CHECK (cantidad > 0),
  precio_unitario    NUMERIC(10,2) NOT NULL CHECK (precio_unitario >= 0),
  subtotal           NUMERIC(10,2) GENERATED ALWAYS AS (ROUND(cantidad * precio_unitario, 2)) STORED,
  notas              VARCHAR(200),
  estado_preparacion enum_estado_prep NOT NULL DEFAULT 'pendiente',
  fecha_inicio_prep  TIMESTAMPTZ,
  fecha_listo        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pagos (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pedido_id        INTEGER REFERENCES pedidos(id) ON DELETE CASCADE,
  cuenta_id        INTEGER REFERENCES cuentas(id),
  metodo           enum_metodo_pago NOT NULL,
  monto            NUMERIC(10,2) NOT NULL CHECK (monto > 0),
  es_contraentrega BOOLEAN NOT NULL DEFAULT FALSE,
  fecha            TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_id       INTEGER NOT NULL REFERENCES usuarios(id),
  CONSTRAINT chk_pago_sujeto CHECK ((pedido_id IS NOT NULL) <> (cuenta_id IS NOT NULL))
);

-- ---------------------------------------------------------------------
-- DOMINIO E — CAJA Y GASTOS
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cuadres_caja (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fecha               DATE NOT NULL UNIQUE DEFAULT CURRENT_DATE,
  estado              enum_estado_caja NOT NULL DEFAULT 'abierta',
  fondo_inicial       NUMERIC(10,2) NOT NULL DEFAULT 0,
  usuario_apertura_id INTEGER REFERENCES usuarios(id),
  fecha_apertura      TIMESTAMPTZ,
  total_ventas        NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_egresos       NUMERIC(10,2) NOT NULL DEFAULT 0,
  monto_esperado      NUMERIC(10,2) NOT NULL DEFAULT 0,
  efectivo_contado    NUMERIC(10,2),
  pagos_digitales     NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_real          NUMERIC(10,2),
  diferencia          NUMERIC(10,2),
  observaciones       VARCHAR(300),
  usuario_cierre_id   INTEGER REFERENCES usuarios(id),
  fecha_cierre        TIMESTAMPTZ,
  CONSTRAINT chk_caja_cerrada CHECK (estado <> 'cerrada' OR (fecha_cierre IS NOT NULL AND efectivo_contado IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS gastos (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fecha                DATE NOT NULL DEFAULT CURRENT_DATE,
  categoria            enum_categoria_gasto NOT NULL,
  descripcion          VARCHAR(200) NOT NULL CHECK (btrim(descripcion) <> ''),
  monto                NUMERIC(10,2) NOT NULL CHECK (monto > 0),
  metodo_pago          enum_metodo_pago NOT NULL,
  descuenta_caja_chica BOOLEAN NOT NULL DEFAULT TRUE,
  comprobante_url      VARCHAR(255),
  usuario_id           INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- DOMINIO F — MERMA Y DEVOLUCIONES
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tipos_merma (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre      VARCHAR(60) NOT NULL UNIQUE,
  descripcion VARCHAR(200)
);

CREATE TABLE IF NOT EXISTS mermas (
  id                     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo_merma_id          INTEGER NOT NULL REFERENCES tipos_merma(id),
  insumo_id              INTEGER REFERENCES insumos(id),
  platillo_id            INTEGER REFERENCES platillos(id),
  cantidad               NUMERIC(12,3) NOT NULL CHECK (cantidad > 0),
  costo_estimado         NUMERIC(10,2) NOT NULL DEFAULT 0,
  clasificacion          enum_clasificacion_merma NOT NULL,
  causa_raiz             VARCHAR(200),
  motivo                 VARCHAR(300) NOT NULL,
  fecha                  DATE NOT NULL DEFAULT CURRENT_DATE,
  estado                 enum_estado_merma NOT NULL DEFAULT 'pendiente',
  usuario_registro_id    INTEGER NOT NULL REFERENCES usuarios(id),
  usuario_aprueba_id     INTEGER REFERENCES usuarios(id),
  fecha_resolucion       TIMESTAMPTZ,
  observacion_resolucion VARCHAR(300),
  origen                 enum_origen_merma NOT NULL DEFAULT 'registro_manual',
  creado_en              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_merma_sujeto CHECK (insumo_id IS NOT NULL OR platillo_id IS NOT NULL),
  CONSTRAINT chk_merma_resuelta CHECK (estado = 'pendiente' OR fecha_resolucion IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS devoluciones (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pedido_id         INTEGER NOT NULL REFERENCES pedidos(id),
  pedido_detalle_id INTEGER REFERENCES pedido_detalles(id),
  fecha_reporte     TIMESTAMPTZ NOT NULL DEFAULT now(),
  motivo            VARCHAR(200) NOT NULL,
  detalle           TEXT,
  monto_reembolsado NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (monto_reembolsado >= 0),
  estado            enum_estado_devolucion NOT NULL DEFAULT 'pendiente',
  resolucion        enum_resolucion_devolucion,
  decidido_por_id   INTEGER REFERENCES usuarios(id),
  fecha_resolucion  TIMESTAMPTZ,
  merma_id          INTEGER REFERENCES mermas(id),
  pago_id           INTEGER REFERENCES pagos(id),
  notificado_dueno  BOOLEAN NOT NULL DEFAULT FALSE,
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_dev_resolucion CHECK (estado <> 'aceptada' OR resolucion IS NOT NULL)
);

-- ---------------------------------------------------------------------
-- DOMINIO G — MANTENIMIENTO DE ACTIVOS
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS activos (
  id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre            VARCHAR(120) NOT NULL,
  categoria         enum_categoria_activo NOT NULL,
  cantidad          INTEGER NOT NULL DEFAULT 1 CHECK (cantidad > 0),
  costo_adquisicion NUMERIC(10,2) NOT NULL DEFAULT 0,
  vida_util_meses   INTEGER CHECK (vida_util_meses IS NULL OR vida_util_meses > 0),
  fecha_adquisicion DATE NOT NULL,
  estado            enum_estado_activo NOT NULL DEFAULT 'activo',
  fecha_baja        DATE,
  motivo_baja       VARCHAR(300),
  usuario_id        INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_activo_baja CHECK (estado <> 'dado_de_baja' OR fecha_baja IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS mantenimientos (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  activo_id        INTEGER NOT NULL REFERENCES activos(id),
  tipo             enum_tipo_mantenimiento NOT NULL,
  fecha            DATE,
  programada_para  DATE,
  descripcion      VARCHAR(300) NOT NULL,
  costo_reparacion NUMERIC(10,2) NOT NULL DEFAULT 0,
  costo_reposicion NUMERIC(10,2) NOT NULL DEFAULT 0,
  decision         enum_decision_mantenimiento,
  estado           enum_estado_mantenimiento NOT NULL DEFAULT 'programado',
  usuario_id       INTEGER NOT NULL REFERENCES usuarios(id),
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_mant_correctivo CHECK (tipo <> 'correctivo' OR decision IS NOT NULL)
);

-- =====================================================================
-- 4. ÍNDICES
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_usuario_rol_rol          ON usuario_rol(rol_id);
CREATE INDEX IF NOT EXISTS idx_permisos_modulo          ON permisos(modulo);
CREATE INDEX IF NOT EXISTS idx_rol_permiso_permiso      ON rol_permiso(permiso_id);
CREATE INDEX IF NOT EXISTS idx_platillos_categoria      ON platillos(categoria_id);
CREATE INDEX IF NOT EXISTS idx_platillos_activo         ON platillos(activo);
CREATE INDEX IF NOT EXISTS idx_insumos_stock_min        ON insumos(stock_actual, stock_minimo);
CREATE INDEX IF NOT EXISTS idx_ftd_insumo               ON fichas_tecnicas_detalle(insumo_id);
CREATE INDEX IF NOT EXISTS idx_mov_inv_insumo_fecha     ON movimientos_inventario(insumo_id, fecha);
CREATE INDEX IF NOT EXISTS idx_mov_inv_tipo             ON movimientos_inventario(tipo);
CREATE INDEX IF NOT EXISTS idx_compras_estado           ON compras(estado);
CREATE INDEX IF NOT EXISTS idx_compras_fecha            ON compras(fecha);
CREATE INDEX IF NOT EXISTS idx_pagos_compras_compra     ON pagos_compras(compra_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cuenta_abierta_mesa ON cuentas(mesa_id) WHERE estado = 'abierta';
CREATE INDEX IF NOT EXISTS idx_cuentas_estado           ON cuentas(estado);
CREATE INDEX IF NOT EXISTS idx_cuentas_mesa             ON cuentas(mesa_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_fecha            ON pedidos(fecha_pedido);
CREATE INDEX IF NOT EXISTS idx_pedidos_estado           ON pedidos(estado);
CREATE INDEX IF NOT EXISTS idx_pedidos_canal            ON pedidos(canal);
CREATE INDEX IF NOT EXISTS idx_pedidos_cuenta           ON pedidos(cuenta_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_cajero           ON pedidos(usuario_cajero_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_repartidor       ON pedidos(repartidor_id);
CREATE INDEX IF NOT EXISTS idx_pedido_detalles_pedido   ON pedido_detalles(pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedido_detalles_platillo ON pedido_detalles(platillo_id);
CREATE INDEX IF NOT EXISTS idx_pagos_fecha              ON pagos(fecha);
CREATE INDEX IF NOT EXISTS idx_pagos_metodo             ON pagos(metodo);
CREATE INDEX IF NOT EXISTS idx_pagos_cuenta             ON pagos(cuenta_id);
CREATE INDEX IF NOT EXISTS idx_cuadres_fecha            ON cuadres_caja(fecha);
CREATE INDEX IF NOT EXISTS idx_gastos_fecha             ON gastos(fecha);
CREATE INDEX IF NOT EXISTS idx_gastos_categoria         ON gastos(categoria);
CREATE INDEX IF NOT EXISTS idx_mermas_fecha             ON mermas(fecha);
CREATE INDEX IF NOT EXISTS idx_mermas_estado            ON mermas(estado);
CREATE INDEX IF NOT EXISTS idx_mermas_tipo              ON mermas(tipo_merma_id);
CREATE INDEX IF NOT EXISTS idx_devoluciones_pedido      ON devoluciones(pedido_id);
CREATE INDEX IF NOT EXISTS idx_devoluciones_estado      ON devoluciones(estado);
CREATE INDEX IF NOT EXISTS idx_devoluciones_pago        ON devoluciones(pago_id);
CREATE INDEX IF NOT EXISTS idx_activos_estado           ON activos(estado);
CREATE INDEX IF NOT EXISTS idx_mantenimientos_activo    ON mantenimientos(activo_id);
CREATE INDEX IF NOT EXISTS idx_mantenimientos_programada ON mantenimientos(programada_para);

-- =====================================================================
-- 5. TRIGGERS DE AUDITORÍA
-- =====================================================================
DO $do$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['usuarios','configuracion','platillos','fichas_tecnicas',
                           'insumos','clientes','activos'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'trg_' || t || '_updated'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %s
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
    END IF;
  END LOOP;
END
$do$;

-- =====================================================================
-- 6. VISTAS DE REPORTE (7)
-- =====================================================================

CREATE OR REPLACE VIEW vw_ventas_por_dia AS
SELECT dia, canal, metodo,
       COUNT(DISTINCT sujeto_id) AS pedidos,
       SUM(monto)                AS monto
FROM (
  SELECT p.fecha_pedido::date AS dia, p.canal, pg.metodo, p.id AS sujeto_id, pg.monto
  FROM pedidos p
  JOIN pagos pg ON pg.pedido_id = p.id
  WHERE p.estado <> 'cancelado'
  UNION ALL
  SELECT c.fecha_cierre::date AS dia, 'local'::enum_canal_pedido AS canal, pg.metodo, c.id AS sujeto_id, pg.monto
  FROM cuentas c
  JOIN pagos pg ON pg.cuenta_id = c.id
  WHERE c.estado = 'cobrada'
) t
GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW vw_kpis_dashboard AS
SELECT co.fecha AS dia,
       COALESCE(v.ingresos, 0) AS ingresos,
       COALESCE(g.egresos, 0)  AS egresos,
       COALESCE(v.ingresos, 0) - COALESCE(g.egresos, 0) AS ganancia_neta,
       co.monto_esperado, co.total_real, co.diferencia
FROM cuadres_caja co
LEFT JOIN (
  SELECT p.fecha::date AS fecha, SUM(p.monto) AS ingresos
  FROM pagos p GROUP BY 1
) v ON v.fecha = co.fecha
LEFT JOIN (
  SELECT fecha, SUM(monto) AS egresos FROM gastos GROUP BY 1
) g ON g.fecha = co.fecha;

CREATE OR REPLACE VIEW vw_stock_alertas AS
SELECT id, codigo, nombre, unidad_medida, stock_actual, stock_minimo,
       (stock_minimo - stock_actual) AS faltante
FROM insumos
WHERE activo AND stock_actual <= stock_minimo
ORDER BY faltante DESC;

CREATE OR REPLACE VIEW vw_tiempos_kds AS
SELECT fecha_pedido::date AS dia,
       canal,
       COUNT(*) AS pedidos,
       ROUND(AVG(EXTRACT(EPOCH FROM (fecha_listo - fecha_inicio_prep)) / 60), 1) AS min_promedio,
       SUM(CASE WHEN EXTRACT(EPOCH FROM (fecha_listo - fecha_pedido)) / 60 > 30
                THEN 1 ELSE 0 END) AS pedidos_prioritarios
FROM pedidos
WHERE fecha_inicio_prep IS NOT NULL AND fecha_listo IS NOT NULL
GROUP BY 1, 2;

CREATE OR REPLACE VIEW vw_food_cost AS
SELECT pl.id, pl.nombre, pl.precio_venta,
       COALESCE(ft.costo_total, 0) AS costo_receta,
       CASE WHEN pl.precio_venta > 0
            THEN ROUND(COALESCE(ft.costo_total, 0) / pl.precio_venta * 100, 1)
       END AS food_cost_pct
FROM platillos pl
LEFT JOIN fichas_tecnicas ft ON ft.platillo_id = pl.id AND ft.activa
WHERE pl.activo;

CREATE OR REPLACE VIEW vw_merma_por_tipo AS
SELECT tm.nombre AS tipo, m.clasificacion,
       COUNT(*) AS registros, SUM(m.costo_estimado) AS costo_total
FROM mermas m
JOIN tipos_merma tm ON tm.id = m.tipo_merma_id
WHERE m.estado = 'aprobada'
GROUP BY 1, 2;

CREATE OR REPLACE VIEW vw_devoluciones_tendencia AS
SELECT pd.platillo_id, pl.nombre AS platillo, d.motivo,
       COUNT(*) AS quejas
FROM devoluciones d
LEFT JOIN pedido_detalles pd ON pd.id = d.pedido_detalle_id
LEFT JOIN platillos pl ON pl.id = pd.platillo_id
GROUP BY 1, 2, 3;

-- Las vistas deben respetar RLS de las tablas base cuando las consulte
-- un rol sujeto a RLS (PostgreSQL 15+).
ALTER VIEW vw_ventas_por_dia          SET (security_invoker = true);
ALTER VIEW vw_kpis_dashboard          SET (security_invoker = true);
ALTER VIEW vw_stock_alertas           SET (security_invoker = true);
ALTER VIEW vw_tiempos_kds             SET (security_invoker = true);
ALTER VIEW vw_food_cost               SET (security_invoker = true);
ALTER VIEW vw_merma_por_tipo          SET (security_invoker = true);
ALTER VIEW vw_devoluciones_tendencia  SET (security_invoker = true);

-- =====================================================================
-- 7. COMENTARIOS DE TABLAS
-- =====================================================================
COMMENT ON TABLE roles                   IS 'A1. Roles del sistema (6): Mozo, Cajero, Cocinero, Repartidor, Dueño/Admin, Admin.';
COMMENT ON TABLE usuarios                IS 'A2. Perfil de usuario; login vía Supabase Auth (auth_uid) o password_hash scrypt. Sin rol_id: RBAC multi-rol.';
COMMENT ON TABLE usuario_rol             IS 'A4. Puente N:M usuarios↔roles (1..N roles por usuario).';
COMMENT ON TABLE permisos                IS 'A5. Catálogo granular de permisos por módulo (modulo.accion).';
COMMENT ON TABLE rol_permiso             IS 'A6. Puente N:M roles↔permisos.';
COMMENT ON TABLE configuracion           IS 'A3. Parámetros clave-valor (IGV, SLA, comisiones, fondo de caja).';

COMMENT ON TABLE categorias_platillo     IS 'B1. Categorías del menú (Pollos, Guarniciones, Entradas, Bebidas, Postres).';
COMMENT ON TABLE platillos               IS 'B2. Catálogo de platillos; baja lógica con activo=false (RN-PL-007).';
COMMENT ON TABLE fichas_tecnicas         IS 'B3. Ficha técnica 1:1 con platillo; costo_total calculado (RN-PL-002).';
COMMENT ON TABLE insumos                 IS 'C1. Catálogo de insumos con stock, mínimo y umbral de merma.';
COMMENT ON TABLE fichas_tecnicas_detalle IS 'B4. Ingredientes N:M ficha↔insumo con cantidad (RN-PL-001).';

COMMENT ON TABLE movimientos_inventario  IS 'C2. Bitácora única de stock; todo cambio de insumos.stock_actual pasa por aquí.';
COMMENT ON TABLE proveedores             IS 'C3. Proveedores de insumos (RUC único de 11 dígitos).';
COMMENT ON TABLE compras                 IS 'C4. Órdenes de compra a proveedor (RN-CO-004/009).';
COMMENT ON TABLE compra_detalles         IS 'C5. Detalle N:M compra↔insumo; subtotal generado.';
COMMENT ON TABLE pagos_compras           IS 'C6. Pagos de compras (efectivo/transferencia) — RN-CO-010.';

COMMENT ON TABLE clientes                IS 'D1. Clientes de WhatsApp/delivery; documento DNI/RUC único por tipo.';
COMMENT ON TABLE mesas                   IS 'D2. Sala con 10 mesas (1..50, estado libre/ocupada).';
COMMENT ON TABLE cuentas                 IS 'D2b. Cuenta abierta por mesa; una sola cuenta abierta por mesa (RN-VL-013).';
COMMENT ON TABLE pedidos                 IS 'D3. Entidad central de venta (local, WhatsApp, delivery propio/externo).';
COMMENT ON TABLE pedido_detalles         IS 'D4. Líneas de pedido con estado de preparación para KDS.';
COMMENT ON TABLE pagos                   IS 'D6. Cobros por pedido o por cuenta consolidada; base del cuadre.';

COMMENT ON TABLE cuadres_caja            IS 'E1. Cuadre diario de caja: apertura, cierre, esperado vs real (1 fila por día).';
COMMENT ON TABLE gastos                  IS 'E2. Gastos del negocio por categoría y método de pago.';

COMMENT ON TABLE tipos_merma             IS 'F1. Catálogo canónico de 7 tipos de merma (RN-ME-001).';
COMMENT ON TABLE mermas                  IS 'F2. Registros de merma; el stock se descuenta solo al aprobar (RN-ME-009).';
COMMENT ON TABLE devoluciones            IS 'F3. Devoluciones y su resolución; enlaza merma (stock) y pago (caja).';

COMMENT ON TABLE activos                 IS 'G1. Activos del negocio y su estado (RN-MA-008).';
COMMENT ON TABLE mantenimientos          IS 'G2. Historial de mantenimiento preventivo/correctivo (RN-MA-009).';

COMMENT ON VIEW vw_ventas_por_dia         IS 'Ventas por día, canal y método de pago (pedidos + cuentas cobradas).';
COMMENT ON VIEW vw_kpis_dashboard         IS 'KPIs diarios: ingresos, egresos, ganancia neta y cuadre.';
COMMENT ON VIEW vw_stock_alertas          IS 'Insumos en o bajo el stock mínimo (RN-CO-002).';
COMMENT ON VIEW vw_tiempos_kds            IS 'Tiempos promedio de preparación y pedidos prioritarios (>30 min).';
COMMENT ON VIEW vw_food_cost              IS 'Food cost por platillo a partir de la ficha técnica activa.';
COMMENT ON VIEW vw_merma_por_tipo         IS 'Merma aprobada agrupada por tipo y clasificación (RN-ME-006).';
COMMENT ON VIEW vw_devoluciones_tendencia IS 'Tendencia de quejas por plato y motivo (RN-DV-004).';

-- =====================================================================
-- FIN — Validación esperada (ver db/README.md §Verificación):
--   29 tablas · 25 ENUM · 45 FK · 7 vistas
-- =====================================================================
COMMIT;
