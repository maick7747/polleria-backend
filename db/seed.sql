-- =====================================================================
-- seed.sql — Datos demo coherentes con el frontend de Fratelli's
-- Requiere: 001_schema.sql aplicado. Ejecutar ANTES de 002_rbac_rls.sql.
--
-- CONTENIDO
--   * 6 roles · 15 permisos · matriz rol_permiso
--   * 5 usuarios demo (clave: demo123) con RBAC multi-rol
--   * 8 parámetros de configuración
--   * 12 insumos + saldo inicial de inventario
--   * 5 categorías · 12 platillos · 7 fichas técnicas
--   * 10 mesas · 3 clientes · 3 cuentas abiertas
--   * 8 comandas (pedidos) + detalles + 1 pago
--   * 3 proveedores · 2 compras · 3 gastos
--   * 2 mermas · 1 devolución · 4 activos · 2 mantenimientos
--   * 1 cuadre de caja abierto del día
--
-- SEGURIDAD: idempotente por catálogo (ON CONFLICT) y por bloque
--   operativo (NOT EXISTS). No borra datos existentes.
--
-- ADVERTENCIA: es data DEMO. No ejecutar sobre una base con datos reales.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. RBAC — roles, permisos y matriz
-- ---------------------------------------------------------------------
INSERT INTO roles (nombre, descripcion) VALUES
  ('Mozo',        'Toma pedidos en sala'),
  ('Cajero',      'Registra pedidos, cobra y cuadra caja'),
  ('Cocinero',    'Gestiona la pantalla KDS de cocina'),
  ('Repartidor',  'Entrega pedidos de delivery propio'),
  ('Dueño/Admin', 'Acceso total: reportes, aprobaciones, configuración'),
  ('Admin',       'Administración técnica del sistema')
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO permisos (codigo, descripcion, modulo) VALUES
  ('venta.registrar',        'Registrar pedido / agregar rondas',       'Venta en Local'),
  ('caja.cobrar',            'Cerrar cuenta y registrar el cobro',     'Venta en Local'),
  ('cocina.kds',             'Operar la pantalla de cocina (KDS)',     'Cocina KDS'),
  ('delivery.propio',        'Gestionar y entregar delivery propio',   'Delivery Propio'),
  ('delivery.externo',       'Gestionar pedidos de delivery externo',  'Delivery Externo'),
  ('compras.gestionar',      'Registrar órdenes de compra de insumos', 'Compra de Insumos'),
  ('gastos.registrar',       'Registrar gastos del negocio',           'Registro de Gastos'),
  ('merma.gestionar',        'Registrar y aprobar mermas',             'Control de Merma'),
  ('devoluciones.gestionar', 'Atender y resolver devoluciones',        'Devoluciones'),
  ('menu.gestionar',         'Administrar fichas técnicas y menú',     'Fichas Técnicas / Menú'),
  ('caja.cuadrar',           'Abrir y cerrar el cuadre de caja',       'Cuadre de Caja'),
  ('activos.gestionar',      'Administrar activos y mantenimiento',    'Mantenimiento de Activos'),
  ('reportes.ver',           'Consultar reportes y dashboard',         'Reportes / Dashboard'),
  ('inventario.gestionar',   'Controlar inventario y stock',           'Control de Inventario'),
  ('config.gestionar',       'Configuración, usuarios y roles',        'Configuración')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO rol_permiso (rol_id, permiso_id)
SELECT r.id, p.id
FROM (VALUES
  ('Mozo',       'venta.registrar'),
  ('Cajero',     'venta.registrar'),
  ('Cajero',     'caja.cobrar'),
  ('Cajero',     'delivery.propio'),
  ('Cajero',     'delivery.externo'),
  ('Cajero',     'devoluciones.gestionar'),
  ('Cajero',     'caja.cuadrar'),
  ('Cocinero',   'cocina.kds'),
  ('Cocinero',   'merma.gestionar'),
  ('Cocinero',   'menu.gestionar'),
  ('Cocinero',   'inventario.gestionar'),
  ('Repartidor', 'delivery.propio'),
  ('Admin',      'compras.gestionar'),
  ('Admin',      'gastos.registrar'),
  ('Admin',      'activos.gestionar'),
  ('Admin',      'reportes.ver'),
  ('Admin',      'config.gestionar')
) AS m(rol, permiso)
JOIN roles r    ON r.nombre = m.rol
JOIN permisos p ON p.codigo = m.permiso
ON CONFLICT DO NOTHING;

INSERT INTO rol_permiso (rol_id, permiso_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permisos p
WHERE r.nombre = 'Dueño/Admin'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. USUARIOS DEMO (contraseña: demo123 — hash scrypt salt:hash)
-- ---------------------------------------------------------------------
INSERT INTO usuarios (nombre, email, password_hash, telefono) VALUES
  ('Maick Vicente',        'maick@fratellis.pe',      'a1b2c3d4e5f60718293a4b5c6d7e8f90:4ca800b39959cb818a14a46aae9b286699519fd59dbc1ccef50da86ed2229b57', '999111222'),
  ('Yair Salamán',         'cajero@fratellis.pe',     'b2c3d4e5f60718293a4b5c6d7e8f90a1:8467811d565b97722dd3394633fec2ed5c67f871f94aac56d13a29638aca2322', '999222333'),
  ('Cocina Fratelli',      'cocina@fratellis.pe',     'c3d4e5f60718293a4b5c6d7e8f90a1b2:be3fe4a8ad9c43f6b8e19cc987fbd6398ec51d65dad357d31d7011e1b70582fb', '999333444'),
  ('Repartidor Fratelli',  'repartidor@fratellis.pe', 'd4e5f60718293a4b5c6d7e8f90a1b2c3:ba462cc6a5efa82ea48abc73e19fd29bdb671de0c4ccc8338eac8fff2239be33', '999444555'),
  ('Técnico Fratelli',     'tecnico@fratellis.pe',    'e5f60718293a4b5c6d7e8f90a1b2c3d4:feea751b93ffeff7950c96d56a7dc7987b5335bd353b9064329d1b3cdd5d08b7', '999555666')
ON CONFLICT (email) DO NOTHING;

INSERT INTO usuario_rol (usuario_id, rol_id)
SELECT u.id, r.id
FROM (VALUES
  ('maick@fratellis.pe',      'Cocinero'),
  ('maick@fratellis.pe',      'Dueño/Admin'),
  ('maick@fratellis.pe',      'Admin'),
  ('cajero@fratellis.pe',     'Mozo'),
  ('cajero@fratellis.pe',     'Cajero'),
  ('cocina@fratellis.pe',     'Cocinero'),
  ('repartidor@fratellis.pe', 'Repartidor'),
  ('tecnico@fratellis.pe',    'Admin')
) AS m(email, rol)
JOIN usuarios u ON u.email = m.email
JOIN roles r    ON r.nombre = m.rol
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. CONFIGURACIÓN
-- ---------------------------------------------------------------------
INSERT INTO configuracion (clave, valor, descripcion) VALUES
  ('igv_pct',               '18', 'IGV % sobre el subtotal (RN-VL-003)'),
  ('igv_min_soles',         '70', 'Ventas menores a S/ 70 no aplican IGV (RN-VL-011)'),
  ('comision_rappi_pct',    '25', 'Comisión Rappi % (RN-DE-002)'),
  ('comision_llamafood_pct','20', 'Comisión LlamaFood % (RN-DE-002)'),
  ('sla_kds_min',           '30', 'Minutos antes de marcar pedido prioritario (RN-CK-004)'),
  ('sla_delivery_min',      '45', 'Minutos para alerta de delivery (RN-DP-007)'),
  ('umbral_merma_pollo_pct','30', 'Umbral aceptable de merma de pollo % (RN-ME-004)'),
  ('fondo_caja_default',    '0',  'Fondo inicial por defecto al abrir caja')
ON CONFLICT (clave) DO NOTHING;

-- Catálogo canónico de 7 tipos de merma (RN-ME-001).
INSERT INTO tipos_merma (nombre, descripcion) VALUES
  ('Pollo',             'Pérdida de pollo crudo o asado'),
  ('Guarniciones',      'Pérdida de arroz, papas, ensaladas'),
  ('Robo/Hurto',        'Faltante por sustracción'),
  ('Sobreproducción',   'Exceso preparado no vendido'),
  ('Caducidad',         'Producto vencido'),
  ('Rotura proveedor',  'Daño recibido del proveedor'),
  ('Incidente físico',  'Caída, derrame o contaminación')
ON CONFLICT (nombre) DO NOTHING;

-- ---------------------------------------------------------------------
-- 4. INSUMOS Y SALDO INICIAL
-- ---------------------------------------------------------------------
INSERT INTO insumos (codigo, nombre, categoria, unidad_medida, stock_actual, stock_minimo, umbral_merma_pct, costo_promedio) VALUES
  ('INS-001', 'Pollo entero',    'alimento',       'kg',  18.000, 10.000, 30.00, 13.5000),
  ('INS-002', 'Papa',            'alimento',       'kg',  30.000, 20.000,  0.00,  3.2000),
  ('INS-003', 'Arroz',           'alimento',       'kg',  25.000, 15.000,  0.00,  4.1000),
  ('INS-004', 'Aceite vegetal',  'alimento',       'l',   12.000,  8.000,  0.00,  9.5000),
  ('INS-005', 'Carbón',          'insumo_general', 'kg',  20.000, 10.000,  0.00,  3.0000),
  ('INS-006', 'Sal',             'alimento',       'kg',   8.000,  5.000,  0.00,  1.2000),
  ('INS-007', 'Gaseosa 1.5 L',   'bebida',         'und', 40.000, 24.000,  0.00,  5.5000),
  ('INS-008', 'Cerveza',         'bebida',         'und', 36.000, 24.000,  0.00,  6.8000),
  ('INS-009', 'Lechuga',         'alimento',       'kg',   6.000,  8.000,  0.00,  2.5000),
  ('INS-010', 'Tomate',          'alimento',       'kg',   9.000,  6.000,  0.00,  2.8000),
  ('INS-011', 'Crema de ají',    'alimento',       'l',    4.000,  5.000,  0.00,  7.2000),
  ('INS-012', 'Caja de empaque', 'empaque',        'und',150.000,100.000,  0.00,  0.3500)
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO movimientos_inventario
  (insumo_id, tipo, cantidad, stock_resultante, referencia_tipo, usuario_id, observacion, fecha)
SELECT i.id, 'entrada', i.stock_actual, i.stock_actual, 'inv_inicial',
       (SELECT id FROM usuarios WHERE email = 'maick@fratellis.pe'),
       'Saldo inicial de demostración', now() - interval '7 days'
FROM insumos i
WHERE NOT EXISTS (
  SELECT 1 FROM movimientos_inventario m
  WHERE m.insumo_id = i.id AND m.referencia_tipo = 'inv_inicial'
);

-- ---------------------------------------------------------------------
-- 5. MENÚ Y FICHAS TÉCNICAS
-- ---------------------------------------------------------------------
INSERT INTO categorias_platillo (nombre, orden) VALUES
  ('Pollos', 1), ('Guarniciones', 2), ('Entradas', 3), ('Bebidas', 4), ('Postres', 5)
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO platillos (
  categoria_id, nombre, descripcion, precio_venta,
  estacion, curso, tiempo_prep_min
)
SELECT c.id, v.nombre, v.descripcion, v.precio,
       v.estacion::enum_estacion, v.curso::enum_curso, v.tiempo_prep_min
FROM (VALUES
  ('Pollos',      'Pollo entero a la brasa', 'Pollo entero con papas y ensalada', 62.00, 'parrilla', 'fondo',   25),
  ('Pollos',      '1/2 Pollo a la brasa',    'Media unidad con guarnición',       34.00, 'parrilla', 'fondo',   20),
  ('Pollos',      '1/4 Pollo a la brasa',    'Cuarto de pollo con papas',         20.00, 'parrilla', 'fondo',   18),
  ('Entradas',    'Papa a la huancaína',     'Entrada tradicional',               14.00, 'frios',    'entrada',  5),
  ('Guarniciones','Arroz chaufa',            'Arroz chaufa de pollo',             16.00, 'parrilla', 'fondo',    8),
  ('Guarniciones','Papas fritas',            'Porción personal',                  12.00, 'frituras', 'fondo',    6),
  ('Guarniciones','Ensalada fresca',         'Lechuga y tomate',                  10.00, 'frios',    'fondo',    3),
  ('Bebidas',     'Inca Kola 1.5 L',         'Gaseosa personal',                  12.00, 'bar',      'fondo',    0),
  ('Bebidas',     'Chicha morada 1 L',       'Jarra de chicha',                   10.00, 'bar',      'fondo',    0),
  ('Bebidas',     'Cerveza Cusqueña',        'Botella 650 ml',                    12.00, 'bar',      'fondo',    0),
  ('Postres',     'Mousse de maracuyá',      'Postre individual',                  9.00, 'frios',    'postre',   2),
  ('Entradas',    'Anticuchos',              'Dos palitos con papa',              18.00, 'parrilla', 'entrada',  8)
) AS v(categoria, nombre, descripcion, precio, estacion, curso, tiempo_prep_min)
JOIN categorias_platillo c ON c.nombre = v.categoria
WHERE NOT EXISTS (SELECT 1 FROM platillos p WHERE p.nombre = v.nombre);

INSERT INTO fichas_tecnicas (platillo_id, porciones_rendimiento, costo_total, notas)
SELECT p.id, 1, v.costo, v.notas
FROM (VALUES
  ('Pollo entero a la brasa', 17.47, 'Pollo entero con guarnición'),
  ('1/2 Pollo a la brasa',     9.06, NULL),
  ('1/4 Pollo a la brasa',     4.71, NULL),
  ('Papa a la huancaína',      1.30, NULL),
  ('Arroz chaufa',             2.20, NULL),
  ('Papas fritas',             1.45, NULL),
  ('Ensalada fresca',          0.54, NULL)
) AS v(platillo, costo, notas)
JOIN platillos p ON p.nombre = v.platillo
ON CONFLICT (platillo_id) DO NOTHING;

INSERT INTO fichas_tecnicas_detalle (ficha_id, insumo_id, cantidad)
SELECT f.id, i.id, v.cantidad
FROM (VALUES
  ('Pollo entero a la brasa', 'INS-001', 1.200),
  ('Pollo entero a la brasa', 'INS-005', 0.300),
  ('Pollo entero a la brasa', 'INS-006', 0.020),
  ('Pollo entero a la brasa', 'INS-012', 1.000),
  ('1/2 Pollo a la brasa',    'INS-001', 0.600),
  ('1/2 Pollo a la brasa',    'INS-005', 0.200),
  ('1/2 Pollo a la brasa',    'INS-006', 0.010),
  ('1/2 Pollo a la brasa',    'INS-012', 1.000),
  ('1/4 Pollo a la brasa',    'INS-001', 0.300),
  ('1/4 Pollo a la brasa',    'INS-005', 0.100),
  ('1/4 Pollo a la brasa',    'INS-006', 0.010),
  ('1/4 Pollo a la brasa',    'INS-012', 1.000),
  ('Papa a la huancaína',     'INS-002', 0.250),
  ('Papa a la huancaína',     'INS-011', 0.050),
  ('Papa a la huancaína',     'INS-009', 0.050),
  ('Papa a la huancaína',     'INS-006', 0.010),
  ('Arroz chaufa',            'INS-003', 0.200),
  ('Arroz chaufa',            'INS-004', 0.030),
  ('Arroz chaufa',            'INS-001', 0.080),
  ('Arroz chaufa',            'INS-006', 0.010),
  ('Papas fritas',            'INS-002', 0.300),
  ('Papas fritas',            'INS-004', 0.050),
  ('Papas fritas',            'INS-006', 0.010),
  ('Ensalada fresca',         'INS-009', 0.100),
  ('Ensalada fresca',         'INS-010', 0.100),
  ('Ensalada fresca',         'INS-006', 0.010)
) AS v(platillo, codigo, cantidad)
JOIN platillos p       ON p.nombre = v.platillo
JOIN fichas_tecnicas f ON f.platillo_id = p.id
JOIN insumos i         ON i.codigo = v.codigo
ON CONFLICT (ficha_id, insumo_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 6. SALA, CLIENTES Y CUENTAS ABIERTAS
-- ---------------------------------------------------------------------
INSERT INTO mesas (numero)
SELECT g FROM generate_series(1, 10) AS g
ON CONFLICT (numero) DO NOTHING;

INSERT INTO clientes (nombre, tipo_documento, numero_documento, telefono, direccion, referencia) VALUES
  ('Juan Pérez',   'DNI', '12345678',  '999777888', 'Av. Ferrocarril 973', NULL),
  ('María López',  'RUC', '20123456789','999888777', 'Calle Real 450',      'Frente al parque'),
  ('Carlos Ramos', 'DNI', '87654321',  '988777666', 'Jr. Puno 120',        'Portón negro')
ON CONFLICT (tipo_documento, numero_documento) DO NOTHING;

INSERT INTO cuentas (mesa_id, estado, total, fecha_apertura, usuario_apertura_id, comprobante_tipo)
SELECT m.id, 'abierta', 0,
       now() - (v.minutos || ' minutes')::interval,
       (SELECT id FROM usuarios WHERE email = 'cajero@fratellis.pe'),
       'boleta'
FROM (VALUES (3, 70), (5, 115), (8, 45)) AS v(numero, minutos)
JOIN mesas m ON m.numero = v.numero
WHERE NOT EXISTS (
  SELECT 1 FROM cuentas c WHERE c.mesa_id = m.id AND c.estado = 'abierta'
);

-- ---------------------------------------------------------------------
-- 7. COMANDAS (8) Y DETALLES
-- ---------------------------------------------------------------------
INSERT INTO pedidos (
  numero, fecha_pedido, canal, tipo_consumo, mesa_id, cuenta_id, cliente_id,
  repartidor_id, usuario_cajero_id, estado, estado_pago, metodo_pago,
  subtotal, igv, total, comision_plataforma, costo_delivery,
  direccion_entrega, referencia_entrega, observaciones, comprobante_tipo,
  estado_entrega, fecha_inicio_prep, fecha_listo, fecha_entrega
)
SELECT
  v.numero,
  now() - (v.minutos || ' minutes')::interval,
  v.canal::enum_canal_pedido,
  v.tipo_consumo::enum_tipo_consumo,
  m.id,
  c.id,
  cl.id,
  rep.id,
  caj.id,
  v.estado::enum_estado_pedido,
  v.estado_pago::enum_estado_pago,
  NULLIF(v.metodo_pago, '')::enum_metodo_pago,
  v.subtotal, v.igv, v.total, v.comision, v.costo_delivery,
  v.direccion, v.referencia, v.observaciones,
  v.comprobante::enum_comprobante_tipo,
  v.estado_entrega,
  CASE WHEN v.inicio_min  IS NULL THEN NULL ELSE now() - (v.inicio_min  || ' minutes')::interval END,
  CASE WHEN v.listo_min   IS NULL THEN NULL ELSE now() - (v.listo_min   || ' minutes')::interval END,
  CASE WHEN v.entrega_min IS NULL THEN NULL ELSE now() - (v.entrega_min || ' minutes')::interval END
FROM (VALUES
  ('PED-2026-000001','local','sala',3,NULL::text,NULL::text,'servido','pendiente','',
    86.00,15.48,101.48,0.00,0.00,NULL::text,NULL::text,'Sin cebolla en la ensalada','boleta',
    65,60,35,NULL::int,'pendiente'),
  ('PED-2026-000002','local','sala',3,NULL::text,NULL::text,'en_cocina','pendiente','',
    16.00,0.00,16.00,0.00,0.00,NULL::text,NULL::text,'Ronda adicional','boleta',
    18,15,NULL::int,NULL::int,'pendiente'),
  ('PED-2026-000003','local','sala',5,NULL::text,NULL::text,'servido','pendiente','',
    78.00,14.04,92.04,0.00,0.00,NULL::text,NULL::text,NULL::text,'boleta',
    140,135,110,NULL::int,'pendiente'),
  ('PED-2026-000004','local','sala',8,NULL::text,NULL::text,'en_cocina','pendiente','',
    30.00,0.00,30.00,0.00,0.00,NULL::text,NULL::text,NULL::text,'boleta',
    12,10,NULL::int,NULL::int,'pendiente'),
  ('PED-2026-000005','whatsapp','delivery',NULL::int,'87654321','repartidor@fratellis.pe',
   'servido','contraentrega_pendiente','',
    40.00,0.00,45.00,0.00,5.00,'Jr. Puno 120','Portón negro',NULL::text,'ticket',
    50,45,25,NULL::int,'en_camino'),
  ('PED-2026-000006','rappi','delivery',NULL::int,NULL::text,NULL::text,'en_cocina','pendiente','',
    62.00,0.00,62.00,15.50,0.00,'Av. Huancavelica 250',NULL::text,NULL::text,'ticket',
    24,20,NULL::int,NULL::int,'pendiente'),
  ('PED-2026-000007','local','para_llevar',NULL::int,NULL::text,NULL::text,'borrador','pendiente','',
    12.00,0.00,12.00,0.00,0.00,NULL::text,NULL::text,'Para recoger a las 20:30','ticket',
    5,NULL::int,NULL::int,NULL::int,NULL::text),
  ('PED-2026-000008','local','para_llevar',NULL::int,NULL::text,NULL::text,'cobrado','pagado','efectivo',
    23.00,0.00,23.00,0.00,0.00,NULL::text,NULL::text,NULL::text,'ticket',
    180,175,160,150,'entregado')
) AS v(numero, canal, tipo_consumo, mesa_numero, cliente_doc, repartidor_email,
       estado, estado_pago, metodo_pago, subtotal, igv, total, comision, costo_delivery,
       direccion, referencia, observaciones, comprobante, minutos, inicio_min, listo_min, entrega_min,
       estado_entrega)
LEFT JOIN mesas m    ON m.numero = v.mesa_numero
LEFT JOIN cuentas c  ON c.mesa_id = m.id AND c.estado = 'abierta'
LEFT JOIN clientes cl ON cl.numero_documento = v.cliente_doc AND cl.tipo_documento = 'DNI'
LEFT JOIN usuarios rep ON rep.email = v.repartidor_email
LEFT JOIN usuarios caj ON caj.email = 'cajero@fratellis.pe'
WHERE NOT EXISTS (SELECT 1 FROM pedidos p WHERE p.numero = v.numero);

INSERT INTO pedido_detalles (
  pedido_id, platillo_id, cantidad, precio_unitario, notas,
  estado_preparacion, fecha_inicio_prep, fecha_listo
)
SELECT
  pe.id, pl.id, v.cantidad, pl.precio_venta, v.notas,
  v.estado::enum_estado_prep,
  CASE WHEN v.inicio_min IS NULL THEN NULL ELSE now() - (v.inicio_min || ' minutes')::interval END,
  CASE WHEN v.listo_min  IS NULL THEN NULL ELSE now() - (v.listo_min  || ' minutes')::interval END
FROM (VALUES
  ('PED-2026-000001','Pollo entero a la brasa',1,NULL::text,'listo',        60,35),
  ('PED-2026-000001','Inca Kola 1.5 L',        2,NULL::text,'listo',        60,35),
  ('PED-2026-000002','Arroz chaufa',           1,NULL::text,'pendiente',    NULL::int,NULL::int),
  ('PED-2026-000003','1/2 Pollo a la brasa',   2,NULL::text,'listo',        135,110),
  ('PED-2026-000003','Chicha morada 1 L',      1,NULL::text,'listo',        135,110),
  ('PED-2026-000004','Anticuchos',             1,NULL::text,'en_preparacion',10,NULL::int),
  ('PED-2026-000004','Cerveza Cusqueña',       1,NULL::text,'pendiente',    NULL::int,NULL::int),
  ('PED-2026-000005','1/4 Pollo a la brasa',   2,NULL::text,'listo',        45,25),
  ('PED-2026-000006','Pollo entero a la brasa',1,NULL::text,'pendiente',    NULL::int,NULL::int),
  ('PED-2026-000007','Papas fritas',           1,NULL::text,'pendiente',    NULL::int,NULL::int),
  ('PED-2026-000008','Papa a la huancaína',    1,NULL::text,'listo',        175,160),
  ('PED-2026-000008','Mousse de maracuyá',     1,NULL::text,'listo',        175,160)
) AS v(pedido_numero, platillo, cantidad, notas, estado, inicio_min, listo_min)
JOIN pedidos pe  ON pe.numero = v.pedido_numero
JOIN platillos pl ON pl.nombre = v.platillo
WHERE NOT EXISTS (
  SELECT 1 FROM pedido_detalles pd WHERE pd.pedido_id = pe.id
);

-- Pago del pedido para llevar ya cobrado (PED-2026-000008).
INSERT INTO pagos (pedido_id, metodo, monto, es_contraentrega, fecha, usuario_id)
SELECT pe.id, 'efectivo', 23.00, FALSE,
       now() - interval '150 minutes',
       (SELECT id FROM usuarios WHERE email = 'cajero@fratellis.pe')
FROM pedidos pe
WHERE pe.numero = 'PED-2026-000008'
  AND NOT EXISTS (SELECT 1 FROM pagos pg WHERE pg.pedido_id = pe.id);

-- Consolidar totales de cuentas abiertas y marcar mesas ocupadas.
UPDATE cuentas c
SET total = COALESCE((
  SELECT SUM(p.total)
  FROM pedidos p
  WHERE p.cuenta_id = c.id AND p.estado <> 'cancelado'
), 0)
WHERE c.estado = 'abierta';

UPDATE mesas
SET estado = 'ocupada'
WHERE numero IN (3, 5, 8);

-- ---------------------------------------------------------------------
-- 8. COMPRAS Y PROVEEDORES
-- ---------------------------------------------------------------------
INSERT INTO proveedores (ruc, razon_social, contacto_nombre, telefono, direccion, email) VALUES
  ('20123456789', 'Distribuidora El Sol', 'Rosa Quispe',  '064-123456', 'Mercado Mayorista',   'ventas@elsol.pe'),
  ('20987654321', 'Bebidas del Centro',   'Luis Paredes', '064-654321', 'Av. Giráldez 300',    'pedidos@bebidascentro.pe'),
  ('20456789123', 'Pollos Huancayo',      'Ana Torres',   '064-777888', 'Av. Independencia 900','contacto@polloshuancayo.pe')
ON CONFLICT (ruc) DO NOTHING;

INSERT INTO compras (proveedor_id, fecha, estado, total, usuario_id, notas, fecha_recepcion)
SELECT pr.id, v.fecha::date, v.estado::enum_estado_compra, v.total,
       (SELECT id FROM usuarios WHERE email = 'maick@fratellis.pe'),
       v.notas, v.fecha_recepcion::date
FROM (VALUES
  ('20456789123', CURRENT_DATE,     'ordenada', 366.00, 'Entregar antes de las 10:00', NULL::date),
  ('20987654321', CURRENT_DATE - 2, 'recibida', 508.80, 'Pedido semanal',              CURRENT_DATE - 1)
) AS v(ruc, fecha, estado, total, notas, fecha_recepcion)
JOIN proveedores pr ON pr.ruc = v.ruc
WHERE NOT EXISTS (SELECT 1 FROM compras);

INSERT INTO compra_detalles (compra_id, insumo_id, cantidad, precio_unitario)
SELECT c.id, i.id, v.cantidad, v.precio
FROM (VALUES
  ('Entregar antes de las 10:00', 'INS-001', 20.000, 13.5000),
  ('Entregar antes de las 10:00', 'INS-002', 30.000,  3.2000),
  ('Pedido semanal',              'INS-007', 48.000,  5.5000),
  ('Pedido semanal',              'INS-008', 36.000,  6.8000)
) AS v(notas, codigo, cantidad, precio)
JOIN compras c ON c.notas = v.notas
JOIN insumos i ON i.codigo = v.codigo
ON CONFLICT (compra_id, insumo_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 9. GASTOS
-- ---------------------------------------------------------------------
INSERT INTO gastos (fecha, categoria, descripcion, monto, metodo_pago, descuenta_caja_chica, usuario_id, creado_en)
SELECT CURRENT_DATE, v.categoria::enum_categoria_gasto, v.descripcion, v.monto,
       'efectivo'::enum_metodo_pago, TRUE,
       (SELECT id FROM usuarios WHERE email = 'maick@fratellis.pe'),
       now() - (v.minutos || ' minutes')::interval
FROM (VALUES
  ('servicios_basicos', 'Recibo de luz',              45.50, 200),
  ('limpieza',          'Detergente y desinfectante', 30.00, 180),
  ('otros',             'Movilidad de compras',       12.00, 160)
) AS v(categoria, descripcion, monto, minutos)
WHERE NOT EXISTS (SELECT 1 FROM gastos);

-- ---------------------------------------------------------------------
-- 10. MERMAS
-- ---------------------------------------------------------------------
INSERT INTO mermas (
  tipo_merma_id, insumo_id, platillo_id, cantidad, costo_estimado,
  clasificacion, causa_raiz, motivo, fecha, estado,
  usuario_registro_id, usuario_aprueba_id, fecha_resolucion,
  observacion_resolucion, origen, creado_en
)
SELECT tm.id, i.id, pl.id, v.cantidad, v.costo,
       v.clasificacion::enum_clasificacion_merma, v.causa, v.motivo,
       CURRENT_DATE - v.dias, v.estado::enum_estado_merma,
       reg.id, apr.id,
       CASE WHEN v.estado = 'pendiente' THEN NULL
            ELSE now() - (v.dias || ' days')::interval END,
       v.obs, 'registro_manual'::enum_origen_merma,
       now() - (v.minutos || ' minutes')::interval
FROM (VALUES
  ('Pollo',           'INS-001', NULL::text,                  1.200, 16.20,
   'inevitable', 'Manejo de proveedor',       'Pollo golpeado en recepción', 0, 'pendiente', NULL::text,               90),
  ('Sobreproducción', NULL::text, 'Pollo entero a la brasa',  1.000, 18.50,
   'evitable',   'Sobreproducción del turno', 'Pollo no vendido',            1, 'aprobada',  'Aprobado por el dueño',  1440)
) AS v(tipo, insumo_codigo, platillo_nombre, cantidad, costo, clasificacion, causa, motivo, dias, estado, obs, minutos)
JOIN tipos_merma tm ON tm.nombre = v.tipo
LEFT JOIN insumos i   ON i.codigo = v.insumo_codigo
LEFT JOIN platillos pl ON pl.nombre = v.platillo_nombre
JOIN usuarios reg      ON reg.email = 'cocina@fratellis.pe'
LEFT JOIN usuarios apr ON apr.email = 'maick@fratellis.pe'
WHERE NOT EXISTS (SELECT 1 FROM mermas);

-- ---------------------------------------------------------------------
-- 11. DEVOLUCIONES
-- ---------------------------------------------------------------------
INSERT INTO devoluciones (pedido_id, motivo, detalle, monto_reembolsado, estado, notificado_dueno, creado_en)
SELECT p.id, 'Pollo frío', 'El cliente reporta que el pollo llegó frío.',
       0.00, 'pendiente'::enum_estado_devolucion, TRUE,
       now() - interval '30 minutes'
FROM pedidos p
WHERE p.numero = 'PED-2026-000001'
  AND NOT EXISTS (SELECT 1 FROM devoluciones);

-- ---------------------------------------------------------------------
-- 12. ACTIVOS Y MANTENIMIENTOS
-- ---------------------------------------------------------------------
INSERT INTO activos (
  nombre, categoria, cantidad, costo_adquisicion, vida_util_meses,
  fecha_adquisicion, estado, usuario_id, creado_en, actualizado_en
)
SELECT v.nombre, v.categoria::enum_categoria_activo, v.cantidad, v.costo, v.vida,
       v.fecha::date, v.estado::enum_estado_activo,
       (SELECT id FROM usuarios WHERE email = 'maick@fratellis.pe'), now(), now()
FROM (VALUES
  ('Horno industrial',        'cocina', 1, 3500.00,  60, '2023-05-12', 'activo'),
  ('Refrigeradora vertical',  'cocina', 1, 2800.00,  84, '2022-01-20', 'en_reparacion'),
  ('Freidora industrial',     'cocina', 1, 1200.00,  48, '2021-03-10', 'activo'),
  ('Mesa de 4 puestos',       'salon',  4,  800.00, 120, '2024-02-01', 'activo')
) AS v(nombre, categoria, cantidad, costo, vida, fecha, estado)
WHERE NOT EXISTS (SELECT 1 FROM activos);

INSERT INTO mantenimientos (
  activo_id, tipo, fecha, programada_para, descripcion,
  costo_reparacion, costo_reposicion, decision, estado, usuario_id, creado_en
)
SELECT a.id, v.tipo::enum_tipo_mantenimiento,
       CASE WHEN v.fecha_dias IS NULL THEN NULL ELSE CURRENT_DATE - v.fecha_dias::int END,
       CASE WHEN v.programada_dias IS NULL THEN NULL ELSE CURRENT_DATE + v.programada_dias::int END,
       v.descripcion, v.costo_rep, v.costo_repos,
       v.decision::enum_decision_mantenimiento,
       'programado'::enum_estado_mantenimiento,
       (SELECT id FROM usuarios WHERE email = 'maick@fratellis.pe'),
       now() - (v.minutos || ' minutes')::interval
FROM (VALUES
  ('Refrigeradora vertical', 'correctivo', 0,    NULL::int, 'No enfría y hace ruido en el motor', 320.00, 2800.00, 'reparar', 120),
  ('Horno industrial',       'preventivo', NULL::int, 20,   'Limpieza profunda y revisión de quemadores', 0.00, 0.00, NULL::text, 14400)
) AS v(activo, tipo, fecha_dias, programada_dias, descripcion, costo_rep, costo_repos, decision, minutos)
JOIN activos a ON a.nombre = v.activo
WHERE NOT EXISTS (SELECT 1 FROM mantenimientos);

-- ---------------------------------------------------------------------
-- 13. CUADRE DE CAJA ABIERTO DEL DÍA
-- ---------------------------------------------------------------------
INSERT INTO cuadres_caja (
  fecha, estado, fondo_inicial, usuario_apertura_id, fecha_apertura,
  total_ventas, total_egresos, monto_esperado, pagos_digitales
)
SELECT CURRENT_DATE, 'abierta', 200.00,
       (SELECT id FROM usuarios WHERE email = 'cajero@fratellis.pe'),
       now() - interval '180 minutes',
       COALESCE((SELECT SUM(monto) FROM pagos WHERE fecha::date = CURRENT_DATE), 0),
       COALESCE((SELECT SUM(monto) FROM gastos WHERE fecha = CURRENT_DATE), 0),
       200.00
         + COALESCE((SELECT SUM(monto) FROM pagos WHERE fecha::date = CURRENT_DATE), 0)
         - COALESCE((SELECT SUM(monto) FROM gastos WHERE fecha = CURRENT_DATE), 0),
       0.00
WHERE NOT EXISTS (SELECT 1 FROM cuadres_caja WHERE estado = 'abierta');

COMMIT;

-- =====================================================================
-- FIN — Verificación rápida:
--   SELECT count(*) FROM mesas;                    -- 10
--   SELECT count(*) FROM cuentas WHERE estado='abierta'; -- 3
--   SELECT count(*) FROM pedidos;                  -- 8
--   SELECT count(*) FROM insumos;                  -- 12
--   SELECT count(*) FROM configuracion;            -- 8
-- =====================================================================
