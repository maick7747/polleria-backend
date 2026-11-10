'use strict';

const { AppError } = require('../middleware/error');
const { hashPassword } = require('../lib/password');

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function round3(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

const LIMA_OFFSET_MINUTES = -300;

function isoFromDate(date) {
  const shifted = new Date(date.getTime() + LIMA_OFFSET_MINUTES * 60000);
  return shifted.toISOString().replace('Z', '-05:00');
}

function nowIso() {
  return isoFromDate(new Date());
}

function isoMinutesAgo(minutes) {
  return isoFromDate(new Date(Date.now() - minutes * 60000));
}

function isoDaysAgo(days) {
  return isoFromDate(new Date(Date.now() - days * 86400000));
}

function today() {
  return nowIso().slice(0, 10);
}

// Fecha de calendario (America/Lima, YYYY-MM-DD) de un instante ISO.
// Sirve para saber a qué día operativo pertenece una cuenta abierta,
// sin importar si el instante viene en UTC (Supabase) o con offset -05:00.
function fechaDe(iso) {
  if (!iso) {
    return today();
  }
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) {
    return today();
  }
  return isoFromDate(fecha).slice(0, 10);
}

function dateInDays(days) {
  return isoFromDate(new Date(Date.now() + days * 86400000)).slice(0, 10);
}

const PERMISOS = [
  { id: 1, codigo: 'venta.registrar', descripcion: 'Registrar pedido / agregar rondas', modulo: 'Venta en Local' },
  { id: 2, codigo: 'caja.cobrar', descripcion: 'Cerrar cuenta y registrar el cobro', modulo: 'Venta en Local' },
  { id: 3, codigo: 'cocina.kds', descripcion: 'Operar la pantalla de cocina (KDS)', modulo: 'Cocina KDS' },
  { id: 4, codigo: 'delivery.propio', descripcion: 'Gestionar y entregar delivery propio', modulo: 'Delivery Propio' },
  { id: 5, codigo: 'delivery.externo', descripcion: 'Gestionar pedidos de delivery externo', modulo: 'Delivery Externo' },
  { id: 6, codigo: 'compras.gestionar', descripcion: 'Registrar órdenes de compra de insumos', modulo: 'Compra de Insumos' },
  { id: 7, codigo: 'gastos.registrar', descripcion: 'Registrar gastos del negocio', modulo: 'Registro de Gastos' },
  { id: 8, codigo: 'merma.gestionar', descripcion: 'Registrar y aprobar mermas', modulo: 'Control de Merma' },
  { id: 9, codigo: 'devoluciones.gestionar', descripcion: 'Atender y resolver devoluciones', modulo: 'Devoluciones' },
  { id: 10, codigo: 'menu.gestionar', descripcion: 'Administrar fichas técnicas y menú', modulo: 'Fichas Técnicas / Menú' },
  { id: 11, codigo: 'caja.cuadrar', descripcion: 'Abrir y cerrar el cuadre de caja', modulo: 'Cuadre de Caja' },
  { id: 12, codigo: 'activos.gestionar', descripcion: 'Administrar activos y mantenimiento', modulo: 'Mantenimiento de Activos' },
  { id: 13, codigo: 'reportes.ver', descripcion: 'Consultar reportes y dashboard', modulo: 'Reportes / Dashboard' },
  { id: 14, codigo: 'inventario.gestionar', descripcion: 'Controlar inventario y stock', modulo: 'Control de Inventario' },
  { id: 15, codigo: 'config.gestionar', descripcion: 'Configuración, usuarios y roles', modulo: 'Configuración' },
];

const ROLES = [
  { id: 1, nombre: 'Mozo', descripcion: 'Toma pedidos en sala', activo: true },
  { id: 2, nombre: 'Cajero', descripcion: 'Registra pedidos, cobra y cuadra caja', activo: true },
  { id: 3, nombre: 'Cocinero', descripcion: 'Gestiona la pantalla KDS de cocina', activo: true },
  { id: 4, nombre: 'Repartidor', descripcion: 'Entrega pedidos de delivery propio', activo: true },
  { id: 5, nombre: 'Dueño/Admin', descripcion: 'Acceso total: reportes, aprobaciones, configuración', activo: true },
  { id: 6, nombre: 'Admin', descripcion: 'Administración técnica del sistema', activo: true },
];

const ROLE_PERMISOS = {
  Mozo: ['venta.registrar'],
  Cajero: [
    'venta.registrar',
    'caja.cobrar',
    'delivery.propio',
    'delivery.externo',
    'devoluciones.gestionar',
    'caja.cuadrar',
  ],
  Cocinero: ['cocina.kds', 'merma.gestionar', 'menu.gestionar', 'inventario.gestionar'],
  Repartidor: ['delivery.propio'],
  'Dueño/Admin': PERMISOS.map((permiso) => permiso.codigo),
  Admin: ['compras.gestionar', 'gastos.registrar', 'activos.gestionar', 'reportes.ver', 'config.gestionar'],
};

const TIPOS_MERMA = [
  'Pollo',
  'Guarniciones',
  'Robo/Hurto',
  'Sobreproducción',
  'Caducidad',
  'Rotura proveedor',
  'Incidente físico',
].map((nombre, index) => ({ id: index + 1, nombre, descripcion: null }));

const state = {
  seq: {},
  config: {
    igv_pct: 18,
    igv_min_soles: 70,
    comision_rappi_pct: 25,
    comision_llamafood_pct: 20,
    kds_sla_min: 30,
    sla_delivery_min: 45,
    umbral_merma_pollo_pct: 30,
    fondo_caja_default: 0,
  },
  roles: ROLES.map((role) => ({ ...role })),
  permisos: PERMISOS.map((permiso) => ({ ...permiso })),
  usuarios: [],
  usuario_rol: [],
  configuracion: [],
  categorias_platillo: [],
  platillos: [],
  fichas_tecnicas: [],
  fichas_tecnicas_detalle: [],
  insumos: [],
  movimientos_inventario: [],
  proveedores: [],
  compras: [],
  compra_detalles: [],
  pagos_compras: [],
  clientes: [],
  mesas: [],
  cuentas: [],
  pedidos: [],
  pedido_detalles: [],
  pagos: [],
  cuadres_caja: [],
  gastos: [],
  tipos_merma: TIPOS_MERMA.map((tipo) => ({ ...tipo })),
  mermas: [],
  devoluciones: [],
  reembolsos: [],
  devolucion_reembolsos: [],
  liquidaciones: [],
  activos: [],
  mantenimientos: [],
};

// Alias: la tabla `devolucion_reembolsos` y la colección histórica
// `reembolsos` son la misma lista en memoria.
state.devolucion_reembolsos = state.reembolsos;

function nextId(collection) {
  const current = state.seq[collection] || 0;
  const next = current + 1;
  state.seq[collection] = next;
  return next;
}

function find(collection, id) {
  const numericId = Number(id);
  if (!Array.isArray(state[collection])) {
    return null;
  }
  return state[collection].find((item) => item.id === numericId) || null;
}

function findOrThrow(collection, id, label) {
  const item = find(collection, id);
  if (!item) {
    throw new AppError(404, 'NOT_FOUND', `${label} con id ${id} no existe.`);
  }
  return item;
}

function permisosDeRoles(roles) {
  const set = new Set();
  for (const role of roles) {
    for (const permiso of ROLE_PERMISOS[role] || []) {
      set.add(permiso);
    }
  }
  return Array.from(set);
}

function calcTotals(subtotal, extra = 0) {
  const base = round2(subtotal);
  const rate = Number(state.config.igv_pct) || 0;
  const minimum = Number(state.config.igv_min_soles) || 0;
  const igv = base >= minimum && base > 0 ? round2((base * rate) / 100) : 0;
  return { subtotal: base, igv, total: round2(base + igv + extra) };
}

function generarNumeroPedido() {
  const correlativo = nextId('pedido_numero');
  return `PED-${new Date().getFullYear()}-${String(correlativo).padStart(6, '0')}`;
}

function generarComprobanteNumero() {
  return `B001-${String(nextId('comprobante_numero')).padStart(8, '0')}`;
}

function cajaAbierta(fecha = today()) {
  return state.cuadres_caja.find((caja) => caja.fecha === fecha && caja.estado === 'abierta') || null;
}

function requireCajaAbierta(fecha = today()) {
  const caja = cajaAbierta(fecha);
  if (!caja) {
    throw new AppError(
      409,
      'CAJA_CERRADA',
      'La caja del día está cerrada. Abra el cuadre de caja para operar.',
    );
  }
  return caja;
}

function applyMovement({
  insumo_id,
  tipo,
  cantidad,
  referencia_tipo = null,
  referencia_id = null,
  usuario_id,
  observacion = null,
  stock_resultante = null,
}) {
  const insumo = findOrThrow('insumos', insumo_id, 'Insumo');
  const quantity = round3(cantidad);

  if (!(quantity > 0)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'La cantidad del movimiento debe ser mayor a cero.');
  }

  let nuevoStock;
  if (stock_resultante !== null && stock_resultante !== undefined) {
    nuevoStock = round3(stock_resultante);
  } else if (tipo === 'entrada' || tipo === 'devolucion') {
    nuevoStock = round3(insumo.stock_actual + quantity);
  } else {
    nuevoStock = round3(insumo.stock_actual - quantity);
  }

  if (nuevoStock < -0.0005) {
    throw new AppError(409, 'STOCK_INSUFICIENTE', `No hay stock suficiente de ${insumo.nombre}.`, [
      {
        insumo_id: insumo.id,
        disponible: insumo.stock_actual,
        requerido: quantity,
      },
    ]);
  }

  insumo.stock_actual = Math.max(0, nuevoStock);
  insumo.actualizado_en = nowIso();

  const movimiento = {
    id: nextId('movimientos_inventario'),
    insumo_id: insumo.id,
    tipo,
    cantidad: quantity,
    stock_resultante: insumo.stock_actual,
    referencia_tipo,
    referencia_id,
    usuario_id,
    observacion,
    fecha: nowIso(),
  };
  state.movimientos_inventario.push(movimiento);
  return movimiento;
}

function addPago({ pedido_id = null, cuenta_id = null, metodo, monto, es_contraentrega = false, usuario_id, fecha = nowIso() }) {
  const pago = {
    id: nextId('pagos'),
    pedido_id,
    cuenta_id,
    metodo,
    monto: round2(monto),
    es_contraentrega,
    fecha,
    usuario_id,
  };
  state.pagos.push(pago);
  return pago;
}

function seed() {
  const userSeed = [
    { nombre: 'Maick Vicente', email: 'maick@fratellis.pe', usuario: 'maick', roles: ['Dueño/Admin'], password: 'demo123', telefono: '999111222' },
    { nombre: 'Yair Salamán', email: 'cajero@fratellis.pe', usuario: 'cajero', roles: ['Mozo', 'Cajero'], password: 'demo123', telefono: '999222333' },
    { nombre: 'Cocina Fratelli', email: 'cocina@fratellis.pe', usuario: 'cocina', roles: ['Cocinero'], password: 'demo123', telefono: '999333444' },
    { nombre: 'Repartidor Fratelli', email: 'repartidor@fratellis.pe', usuario: 'repartidor', roles: ['Repartidor'], password: 'demo123', telefono: '999444555' },
    { nombre: 'Técnico Fratelli', email: 'tecnico@fratellis.pe', usuario: 'tecnico', roles: ['Admin'], password: 'demo123', telefono: '999555666' },
  ];

  state.usuarios = userSeed.map((user) => {
    const id = nextId('usuarios');
    const roles = user.roles;
    const permisos = permisosDeRoles(roles);
    for (const role of roles) {
      const roleRecord = state.roles.find((item) => item.nombre === role);
      if (roleRecord) {
        state.usuario_rol.push({ usuario_id: id, rol_id: roleRecord.id, creado_en: isoDaysAgo(60) });
      }
    }
    return {
      id,
      auth_uid: null,
      nombre: user.nombre,
      email: user.email,
      usuario: user.usuario,
      password_hash: hashPassword(user.password),
      telefono: user.telefono,
      activo: true,
      roles,
      permisos,
      ultimo_acceso: null,
      creado_en: isoDaysAgo(90),
      actualizado_en: isoDaysAgo(1),
    };
  });

  state.configuracion = Object.entries(state.config).map(([clave, valor], index) => ({
    id: index + 1,
    clave,
    valor: String(valor),
    descripcion: null,
    actualizado_en: isoDaysAgo(1),
  }));

  const insumoSeed = [
    { codigo: 'INS-001', nombre: 'Pollo entero', categoria: 'alimento', unidad_medida: 'kg', stock_actual: 18.5, stock_minimo: 25, costo_promedio: 12.8 },
    { codigo: 'INS-002', nombre: 'Papa', categoria: 'alimento', unidad_medida: 'kg', stock_actual: 12, stock_minimo: 20, costo_promedio: 3.2 },
    { codigo: 'INS-003', nombre: 'Arroz', categoria: 'alimento', unidad_medida: 'kg', stock_actual: 30, stock_minimo: 10, costo_promedio: 4.1 },
    { codigo: 'INS-004', nombre: 'Aceite vegetal', categoria: 'alimento', unidad_medida: 'l', stock_actual: 8, stock_minimo: 5, costo_promedio: 9.4 },
    { codigo: 'INS-005', nombre: 'Carbón', categoria: 'insumo_general', unidad_medida: 'kg', stock_actual: 40, stock_minimo: 15, costo_promedio: 2.9 },
    { codigo: 'INS-006', nombre: 'Sal', categoria: 'alimento', unidad_medida: 'kg', stock_actual: 12, stock_minimo: 4, costo_promedio: 1.2 },
    { codigo: 'INS-007', nombre: 'Gaseosa 1.5 L', categoria: 'bebida', unidad_medida: 'und', stock_actual: 48, stock_minimo: 24, costo_promedio: 2.5 },
    { codigo: 'INS-008', nombre: 'Chicha morada', categoria: 'bebida', unidad_medida: 'l', stock_actual: 20, stock_minimo: 10, costo_promedio: 3.1 },
    { codigo: 'INS-009', nombre: 'Lechuga', categoria: 'alimento', unidad_medida: 'kg', stock_actual: 9, stock_minimo: 8, costo_promedio: 2.5 },
    { codigo: 'INS-010', nombre: 'Limón', categoria: 'alimento', unidad_medida: 'kg', stock_actual: 9, stock_minimo: 6, costo_promedio: 4.8 },
    { codigo: 'INS-011', nombre: 'Ají amarillo', categoria: 'alimento', unidad_medida: 'kg', stock_actual: 2.1, stock_minimo: 3, costo_promedio: 8.5 },
    { codigo: 'INS-012', nombre: 'Caja para llevar', categoria: 'empaque', unidad_medida: 'und', stock_actual: 120, stock_minimo: 60, costo_promedio: 0.65 },
  ];

  state.insumos = insumoSeed.map((item) => ({
    id: nextId('insumos'),
    ...item,
    umbral_merma_pct: item.nombre.includes('Pollo') ? 30 : 0,
    activo: true,
    creado_en: isoDaysAgo(120),
    actualizado_en: isoDaysAgo(3),
  }));

  for (const insumo of state.insumos) {
    state.movimientos_inventario.push({
      id: nextId('movimientos_inventario'),
      insumo_id: insumo.id,
      tipo: 'entrada',
      cantidad: insumo.stock_actual,
      stock_resultante: insumo.stock_actual,
      referencia_tipo: 'inventario_inicial',
      referencia_id: null,
      usuario_id: 1,
      observacion: 'Saldo inicial de demostración',
      fecha: isoDaysAgo(7),
    });
  }

  const categorias = ['Pollos', 'Guarniciones', 'Entradas', 'Bebidas', 'Postres'];
  state.categorias_platillo = categorias.map((nombre, index) => ({
    id: nextId('categorias_platillo'),
    nombre,
    orden: index + 1,
    activo: true,
  }));

  const platilloSeed = [
    { categoria_id: 1, nombre: 'Pollo entero a la brasa', descripcion: 'Pollo entero con papas y ensalada', precio_venta: 62, estacion: 'parrilla', curso: 'fondo', tiempo_prep_min: 25 },
    { categoria_id: 1, nombre: '1/2 Pollo a la brasa', descripcion: 'Media unidad con guarnición', precio_venta: 34, estacion: 'parrilla', curso: 'fondo', tiempo_prep_min: 20 },
    { categoria_id: 1, nombre: '1/4 Pollo a la brasa', descripcion: 'Cuarto de pollo con papas', precio_venta: 20, estacion: 'parrilla', curso: 'fondo', tiempo_prep_min: 18 },
    { categoria_id: 3, nombre: 'Papa a la huancaína', descripcion: 'Entrada tradicional', precio_venta: 14, estacion: 'frios', curso: 'entrada', tiempo_prep_min: 5 },
    { categoria_id: 2, nombre: 'Arroz chaufa', descripcion: 'Arroz chaufa de pollo', precio_venta: 16, estacion: 'parrilla', curso: 'fondo', tiempo_prep_min: 8 },
    { categoria_id: 2, nombre: 'Papas fritas', descripcion: 'Porción personal', precio_venta: 12, estacion: 'frituras', curso: 'fondo', tiempo_prep_min: 6 },
    { categoria_id: 2, nombre: 'Ensalada fresca', descripcion: 'Lechuga y tomate', precio_venta: 10, estacion: 'frios', curso: 'fondo', tiempo_prep_min: 3 },
    { categoria_id: 4, nombre: 'Inca Kola 1.5 L', descripcion: 'Gaseosa personal', precio_venta: 12, estacion: 'bar', curso: 'fondo', tiempo_prep_min: 0 },
    { categoria_id: 4, nombre: 'Chicha morada 1 L', descripcion: 'Jarra de chicha', precio_venta: 10, estacion: 'bar', curso: 'fondo', tiempo_prep_min: 0 },
    { categoria_id: 4, nombre: 'Cerveza Cusqueña', descripcion: 'Botella 650 ml', precio_venta: 12, estacion: 'bar', curso: 'fondo', tiempo_prep_min: 0 },
    { categoria_id: 5, nombre: 'Mousse de maracuyá', descripcion: 'Postre individual', precio_venta: 9, estacion: 'frios', curso: 'postre', tiempo_prep_min: 2 },
    { categoria_id: 3, nombre: 'Anticuchos', descripcion: 'Dos palitos con papa', precio_venta: 18, estacion: 'parrilla', curso: 'entrada', tiempo_prep_min: 8 },
  ];

  state.platillos = platilloSeed.map((item) => ({
    id: nextId('platillos'),
    ...item,
    imagen_url: null,
    activo: true,
    creado_en: isoDaysAgo(90),
    actualizado_en: isoDaysAgo(5),
  }));

  function createFicha(platilloId, porciones, ingredientes, notas = null) {
    const ficha = {
      id: nextId('fichas_tecnicas'),
      platillo_id: platilloId,
      porciones_rendimiento: porciones,
      costo_total: 0,
      notas,
      activa: true,
      creado_en: isoDaysAgo(30),
      actualizado_en: isoDaysAgo(5),
    };

    let total = 0;
    for (const ingredient of ingredientes) {
      const insumo = findOrThrow('insumos', ingredient.insumo_id, 'Insumo');
      total += ingredient.cantidad * insumo.costo_promedio;
      state.fichas_tecnicas_detalle.push({
        id: nextId('fichas_tecnicas_detalle'),
        ficha_id: ficha.id,
        insumo_id: insumo.id,
        cantidad: round3(ingredient.cantidad),
      });
    }
    ficha.costo_total = round2(total);
    state.fichas_tecnicas.push(ficha);
    return ficha;
  }

  createFicha(1, 1, [
    { insumo_id: 1, cantidad: 1.2 },
    { insumo_id: 5, cantidad: 0.3 },
    { insumo_id: 6, cantidad: 0.02 },
    { insumo_id: 12, cantidad: 1 },
  ], 'Pollo entero con guarnición');

  createFicha(2, 1, [
    { insumo_id: 1, cantidad: 0.6 },
    { insumo_id: 5, cantidad: 0.2 },
    { insumo_id: 6, cantidad: 0.01 },
    { insumo_id: 12, cantidad: 1 },
  ]);

  createFicha(3, 1, [
    { insumo_id: 1, cantidad: 0.3 },
    { insumo_id: 5, cantidad: 0.1 },
    { insumo_id: 6, cantidad: 0.01 },
    { insumo_id: 12, cantidad: 1 },
  ]);

  createFicha(4, 1, [
    { insumo_id: 2, cantidad: 0.25 },
    { insumo_id: 11, cantidad: 0.05 },
    { insumo_id: 9, cantidad: 0.05 },
    { insumo_id: 6, cantidad: 0.01 },
  ]);

  createFicha(5, 1, [
    { insumo_id: 3, cantidad: 0.2 },
    { insumo_id: 4, cantidad: 0.03 },
    { insumo_id: 1, cantidad: 0.08 },
    { insumo_id: 6, cantidad: 0.01 },
  ]);

  createFicha(6, 1, [
    { insumo_id: 2, cantidad: 0.3 },
    { insumo_id: 4, cantidad: 0.05 },
    { insumo_id: 6, cantidad: 0.01 },
  ]);

  createFicha(7, 1, [
    { insumo_id: 9, cantidad: 0.1 },
    { insumo_id: 10, cantidad: 0.1 },
    { insumo_id: 6, cantidad: 0.01 },
  ]);

  state.mesas = Array.from({ length: 10 }, (_, index) => ({
    id: nextId('mesas'),
    numero: index + 1,
    estado: 'libre',
    activa: true,
  }));

  state.clientes = [
    { id: nextId('clientes'), nombre: 'Juan Pérez', tipo_documento: 'DNI', numero_documento: '12345678', telefono: '999777888', direccion: 'Av. Ferrocarril 973', referencia: null },
    { id: nextId('clientes'), nombre: 'María López', tipo_documento: 'RUC', numero_documento: '20123456789', telefono: '999888777', direccion: 'Calle Real 450', referencia: 'Frente al parque' },
    { id: nextId('clientes'), nombre: 'Carlos Ramos', tipo_documento: 'DNI', numero_documento: '87654321', telefono: '988777666', direccion: 'Jr. Puno 120', referencia: 'Portón negro' },
  ].map((cliente) => ({ ...cliente, creado_en: isoDaysAgo(20), actualizado_en: isoDaysAgo(5) }));

  state.cuentas.push({
    id: nextId('cuentas'),
    mesa_id: 2,
    estado: 'abierta',
    total: 0,
    fecha_apertura: isoMinutesAgo(70),
    usuario_apertura_id: 2,
    fecha_cierre: null,
    usuario_cierre_id: null,
    comprobante_tipo: 'boleta',
    comprobante_numero: null,
  });
  state.cuentas.push({
    id: nextId('cuentas'),
    mesa_id: 4,
    estado: 'abierta',
    total: 0,
    fecha_apertura: isoMinutesAgo(95),
    usuario_apertura_id: 3,
    fecha_cierre: null,
    usuario_cierre_id: null,
    comprobante_tipo: 'boleta',
    comprobante_numero: null,
  });
  state.cuentas.push({
    id: nextId('cuentas'),
    mesa_id: 7,
    estado: 'abierta',
    total: 0,
    fecha_apertura: isoMinutesAgo(60),
    usuario_apertura_id: 2,
    fecha_cierre: null,
    usuario_cierre_id: null,
    comprobante_tipo: 'ticket',
    comprobante_numero: null,
  });

  const cuentasCobradas = [
    { mesa_id: 9, total: 1250, metodo: 'tarjeta', apertura: 300, cierre: 120 },
    { mesa_id: 5, total: 800, metodo: 'efectivo', apertura: 280, cierre: 90 },
    { mesa_id: 10, total: 400, metodo: 'yape', apertura: 240, cierre: 60 },
  ];

  for (const cobrada of cuentasCobradas) {
    const cuenta = {
      id: nextId('cuentas'),
      mesa_id: cobrada.mesa_id,
      estado: 'cobrada',
      total: cobrada.total,
      fecha_apertura: isoMinutesAgo(cobrada.apertura),
      usuario_apertura_id: 2,
      fecha_cierre: isoMinutesAgo(cobrada.cierre),
      usuario_cierre_id: 2,
      comprobante_tipo: 'boleta',
      comprobante_numero: generarComprobanteNumero(),
    };
    state.cuentas.push(cuenta);
    addPago({
      cuenta_id: cuenta.id,
      metodo: cobrada.metodo,
      monto: cuenta.total,
      usuario_id: 2,
      fecha: cuenta.fecha_cierre,
    });
  }

  for (const mesaOcupada of [2, 4, 7]) {
    const mesa = state.mesas.find((item) => item.numero === mesaOcupada);
    if (mesa) {
      mesa.estado = 'ocupada';
    }
  }

  function seedPedido(options) {
    const {
      canal,
      tipo_consumo,
      mesa_id = null,
      cuenta_id = null,
      cliente_id = null,
      repartidor_id = null,
      usuario_id = 2,
      estado = 'borrador',
      estado_pago = 'pendiente',
      metodo_pago = null,
      items,
      fecha_pedido = nowIso(),
      observaciones = null,
      direccion_entrega = null,
      referencia_entrega = null,
      costo_delivery = 0,
      estados_detalle = [],
      estado_entrega = null,
      comision_plataforma = 0,
      fecha_inicio_prep = null,
      fecha_listo = null,
      fecha_entrega = null,
    } = options;

    const details = items.map((item) => {
      const platillo = findOrThrow('platillos', item.platillo_id, 'Platillo');
      const cantidad = Number(item.cantidad);
      return {
        platillo_id: platillo.id,
        cantidad,
        precio_unitario: platillo.precio_venta,
        notas: item.notas || null,
        estacion: platillo.estacion || 'parrilla',
        curso: platillo.curso || 'fondo',
        prep_min: platillo.tiempo_prep_min ?? null,
      };
    });

    const subtotal = round2(details.reduce((sum, item) => sum + item.cantidad * item.precio_unitario, 0));
    const totals = calcTotals(subtotal, costo_delivery);
    const id = nextId('pedidos');
    const pedido = {
      id,
      numero: generarNumeroPedido(),
      fecha_pedido,
      canal,
      tipo_consumo,
      mesa_id,
      cuenta_id,
      cliente_id,
      repartidor_id,
      usuario_cajero_id: usuario_id,
      estado,
      estado_pago,
      metodo_pago,
      subtotal: totals.subtotal,
      igv: totals.igv,
      total: totals.total,
      comision_plataforma: round2(comision_plataforma),
      costo_delivery: round2(costo_delivery),
      direccion_entrega,
      referencia_entrega,
      observaciones,
      comprobante_tipo: tipo_consumo === 'sala' ? 'boleta' : 'ticket',
      comprobante_numero: null,
      fecha_inicio_prep,
      fecha_listo,
      fecha_entrega,
      estado_entrega: estado_entrega
        || (['en_cocina', 'servido'].includes(estado) ? 'pendiente' : null),
      stock_descontado: false,
      creado_en: fecha_pedido,
    };
    state.pedidos.push(pedido);

    details.forEach((detail, index) => {
      const prepState = detail.estacion === 'bar'
        ? 'listo'
        : (estados_detalle[index] || 'pendiente');
      state.pedido_detalles.push({
        id: nextId('pedido_detalles'),
        pedido_id: id,
        platillo_id: detail.platillo_id,
        cantidad: detail.cantidad,
        precio_unitario: detail.precio_unitario,
        subtotal: round2(detail.cantidad * detail.precio_unitario),
        notas: detail.notas,
        estado_preparacion: prepState,
        fecha_inicio_prep: prepState === 'pendiente' ? null : fecha_pedido,
        fecha_listo: prepState === 'listo' ? fecha_listo || isoMinutesAgo(5) : null,
        estacion: detail.estacion,
        curso: detail.curso,
        entregado_en: null,
        entregado_por_id: null,
      });
    });

    return pedido;
  }

  seedPedido({
    canal: 'local',
    tipo_consumo: 'sala',
    mesa_id: 2,
    cuenta_id: 1,
    usuario_id: 2,
    estado: 'servido',
    items: [{ platillo_id: 3, cantidad: 1 }, { platillo_id: 6, cantidad: 1 }, { platillo_id: 9, cantidad: 1 }],
    fecha_pedido: isoMinutesAgo(65),
    estados_detalle: ['listo', 'listo', 'listo'],
    fecha_inicio_prep: isoMinutesAgo(60),
    fecha_listo: isoMinutesAgo(35),
    observaciones: 'Sin cebolla en la ensalada',
  });

  seedPedido({
    canal: 'local',
    tipo_consumo: 'sala',
    mesa_id: 2,
    cuenta_id: 1,
    usuario_id: 2,
    estado: 'en_cocina',
    items: [{ platillo_id: 2, cantidad: 1 }],
    fecha_pedido: isoMinutesAgo(18),
    estados_detalle: ['en_preparacion'],
    fecha_inicio_prep: isoMinutesAgo(15),
    observaciones: 'Ronda adicional',
  });

  seedPedido({
    canal: 'local',
    tipo_consumo: 'sala',
    mesa_id: 4,
    cuenta_id: 2,
    usuario_id: 3,
    estado: 'servido',
    items: [{ platillo_id: 3, cantidad: 1 }, { platillo_id: 6, cantidad: 1 }, { platillo_id: 9, cantidad: 1 }],
    fecha_pedido: isoMinutesAgo(58),
    estados_detalle: ['listo', 'listo', 'listo'],
    fecha_inicio_prep: isoMinutesAgo(54),
    fecha_listo: isoMinutesAgo(32),
  });

  seedPedido({
    canal: 'local',
    tipo_consumo: 'sala',
    mesa_id: 4,
    cuenta_id: 2,
    usuario_id: 3,
    estado: 'en_cocina',
    items: [{ platillo_id: 2, cantidad: 1 }],
    fecha_pedido: isoMinutesAgo(22),
    estados_detalle: ['en_preparacion'],
    fecha_inicio_prep: isoMinutesAgo(18),
  });

  seedPedido({
    canal: 'local',
    tipo_consumo: 'sala',
    mesa_id: 4,
    cuenta_id: 2,
    usuario_id: 3,
    estado: 'en_cocina',
    items: [{ platillo_id: 6, cantidad: 1 }, { platillo_id: 7, cantidad: 1 }],
    fecha_pedido: isoMinutesAgo(12),
    estados_detalle: ['pendiente', 'pendiente'],
    fecha_inicio_prep: isoMinutesAgo(10),
  });

  seedPedido({
    canal: 'local',
    tipo_consumo: 'sala',
    mesa_id: 7,
    cuenta_id: 3,
    usuario_id: 2,
    estado: 'en_cocina',
    items: [
      { platillo_id: 2, cantidad: 1 },
      { platillo_id: 6, cantidad: 1 },
      { platillo_id: 9, cantidad: 1 },
      { platillo_id: 7, cantidad: 1 },
    ],
    fecha_pedido: isoMinutesAgo(38),
    estados_detalle: ['en_preparacion', 'pendiente', 'pendiente', 'pendiente'],
    fecha_inicio_prep: isoMinutesAgo(34),
  });

  seedPedido({
    canal: 'whatsapp',
    tipo_consumo: 'delivery',
    cliente_id: 3,
    repartidor_id: 4,
    usuario_id: 2,
    estado: 'en_cocina',
    estado_pago: 'contraentrega_pendiente',
    items: [{ platillo_id: 3, cantidad: 2 }],
    fecha_pedido: isoMinutesAgo(50),
    costo_delivery: 5,
    direccion_entrega: 'Jr. Puno 120',
    referencia_entrega: 'Portón negro',
    estados_detalle: ['en_preparacion'],
    estado_entrega: 'en_camino',
    fecha_inicio_prep: isoMinutesAgo(45),
  });

  seedPedido({
    canal: 'rappi',
    tipo_consumo: 'delivery',
    usuario_id: 2,
    estado: 'en_cocina',
    items: [{ platillo_id: 1, cantidad: 1 }],
    fecha_pedido: isoMinutesAgo(24),
    direccion_entrega: 'Av. Huancavelica 250',
    estados_detalle: ['pendiente'],
    fecha_inicio_prep: isoMinutesAgo(20),
    comision_plataforma: round2(62 * 0.25),
  });

  for (const cuentaId of [1, 2, 3]) {
    const cuenta = state.cuentas.find((item) => item.id === cuentaId);
    if (cuenta) {
      cuenta.total = round2(
        state.pedidos
          .filter((pedido) => pedido.cuenta_id === cuentaId && pedido.estado !== 'cancelado')
          .reduce((sum, pedido) => sum + pedido.total, 0),
      );
    }
  }


  state.proveedores = [
    { id: nextId('proveedores'), ruc: '20123456789', razon_social: 'Distribuidora El Sol', contacto_nombre: 'Rosa Quispe', telefono: '064-123456', direccion: 'Mercado Mayorista', email: 'ventas@elsol.pe', activo: true },
    { id: nextId('proveedores'), ruc: '20987654321', razon_social: 'Bebidas del Centro', contacto_nombre: 'Luis Paredes', telefono: '064-654321', direccion: 'Av. Giráldez 300', email: 'pedidos@bebidascentro.pe', activo: true },
    { id: nextId('proveedores'), ruc: '20456789123', razon_social: 'Pollos Huancayo', contacto_nombre: 'Ana Torres', telefono: '064-777888', direccion: 'Av. Independencia 900', email: 'contacto@polloshuancayo.pe', activo: true },
  ];

  function seedCompra({ proveedor_id, estado, items, fecha, fecha_recepcion = null, notas = null }) {
    const compra = {
      id: nextId('compras'),
      proveedor_id,
      fecha,
      estado,
      total: 0,
      usuario_id: 1,
      notas,
      fecha_recepcion,
      creado_en: `${fecha}T09:00:00-05:00`,
    };
    let total = 0;
    for (const item of items) {
      const insumo = findOrThrow('insumos', item.insumo_id, 'Insumo');
      const subtotalItem = round2(item.cantidad * item.precio_unitario);
      total += subtotalItem;
      state.compra_detalles.push({
        id: nextId('compra_detalles'),
        compra_id: compra.id,
        insumo_id: insumo.id,
        cantidad: round3(item.cantidad),
        precio_unitario: round2(item.precio_unitario),
        subtotal: subtotalItem,
      });
    }
    compra.total = round2(total);
    state.compras.push(compra);
    return compra;
  }

  seedCompra({
    proveedor_id: 3,
    estado: 'ordenada',
    fecha: today(),
    items: [
      { insumo_id: 1, cantidad: 20, precio_unitario: 13.5 },
      { insumo_id: 2, cantidad: 30, precio_unitario: 3.2 },
    ],
    notas: 'Entregar antes de las 10:00',
  });

  seedCompra({
    proveedor_id: 2,
    estado: 'recibida',
    fecha: isoDaysAgo(2).slice(0, 10),
    fecha_recepcion: isoDaysAgo(1).slice(0, 10),
    items: [
      { insumo_id: 7, cantidad: 48, precio_unitario: 5.5 },
      { insumo_id: 8, cantidad: 36, precio_unitario: 6.8 },
    ],
    notas: 'Pedido semanal',
  });

  state.gastos = [
    { id: nextId('gastos'), fecha: today(), categoria: 'servicios_basicos', descripcion: 'Recibo de luz', monto: 45.5, metodo_pago: 'efectivo', descuenta_caja_chica: true, comprobante_url: null, usuario_id: 1, creado_en: isoMinutesAgo(200), actualizado_en: isoMinutesAgo(200) },
    { id: nextId('gastos'), fecha: today(), categoria: 'limpieza', descripcion: 'Detergente y desinfectante', monto: 30, metodo_pago: 'efectivo', descuenta_caja_chica: true, comprobante_url: null, usuario_id: 1, creado_en: isoMinutesAgo(180), actualizado_en: isoMinutesAgo(180) },
    { id: nextId('gastos'), fecha: today(), categoria: 'otros', descripcion: 'Movilidad de compras', monto: 12, metodo_pago: 'efectivo', descuenta_caja_chica: true, comprobante_url: null, usuario_id: 1, creado_en: isoMinutesAgo(160), actualizado_en: isoMinutesAgo(160) },
  ];

  state.mermas = [
    { id: nextId('mermas'), tipo_merma_id: 1, insumo_id: 1, platillo_id: null, cantidad: 3.5, costo_estimado: 45, clasificacion: 'evitable', causa_raiz: 'Exceso de tiempo en parrilla', motivo: 'Pollo quemado durante el turno tarde', fecha: today(), estado: 'aprobada', usuario_registro_id: 4, usuario_aprueba_id: 1, fecha_resolucion: isoMinutesAgo(100), observacion_resolucion: 'Aprobado por el dueño', origen: 'registro_manual', creado_en: isoMinutesAgo(140) },
    { id: nextId('mermas'), tipo_merma_id: 2, insumo_id: 2, platillo_id: null, cantidad: 5, costo_estimado: 40, clasificacion: 'evitable', causa_raiz: 'Sobreproducción', motivo: 'Porción de papas no vendida al cierre de turno', fecha: today(), estado: 'pendiente', usuario_registro_id: 4, usuario_aprueba_id: null, fecha_resolucion: null, observacion_resolucion: null, origen: 'registro_manual', creado_en: isoMinutesAgo(90) },
  ];

  state.devoluciones = [
    { id: nextId('devoluciones'), pedido_id: 2, pedido_detalle_id: null, fecha_reporte: isoMinutesAgo(30), motivo: 'Plato frío', detalle: 'El cliente reporta que el pollo llegó frío por demora del reparto.', monto_reembolsado: 0, estado: 'pendiente', resolucion: null, decidido_por_id: null, fecha_resolucion: null, merma_id: null, pago_id: null, notificado_dueno: true, creado_en: isoMinutesAgo(30) },
    { id: nextId('devoluciones'), pedido_id: 3, pedido_detalle_id: null, fecha_reporte: isoMinutesAgo(45), motivo: 'Falta un acompañamiento', detalle: 'No se incluyó la ensalada en el pedido.', monto_reembolsado: 7.9, estado: 'aceptada', resolucion: 'reembolso_parcial', decidido_por_id: 1, fecha_resolucion: isoMinutesAgo(40), merma_id: null, pago_id: null, notificado_dueno: true, creado_en: isoMinutesAgo(45) },
  ];

  state.activos = [
    { id: nextId('activos'), nombre: 'Horno industrial', categoria: 'cocina', cantidad: 1, costo_adquisicion: 3500, vida_util_meses: 60, fecha_adquisicion: '2023-05-12', estado: 'activo', fecha_baja: null, motivo_baja: null, usuario_id: 1, creado_en: isoDaysAgo(300), actualizado_en: isoDaysAgo(10) },
    { id: nextId('activos'), nombre: 'Refrigeradora vertical', categoria: 'cocina', cantidad: 1, costo_adquisicion: 2800, vida_util_meses: 84, fecha_adquisicion: '2022-01-20', estado: 'en_reparacion', fecha_baja: null, motivo_baja: null, usuario_id: 1, creado_en: isoDaysAgo(400), actualizado_en: isoMinutesAgo(120) },
    { id: nextId('activos'), nombre: 'Freidora industrial', categoria: 'cocina', cantidad: 1, costo_adquisicion: 1200, vida_util_meses: 48, fecha_adquisicion: '2021-03-10', estado: 'activo', fecha_baja: null, motivo_baja: null, usuario_id: 1, creado_en: isoDaysAgo(500), actualizado_en: isoDaysAgo(15) },
    { id: nextId('activos'), nombre: 'Mesa de 4 puestos', categoria: 'salon', cantidad: 4, costo_adquisicion: 800, vida_util_meses: 120, fecha_adquisicion: '2024-02-01', estado: 'activo', fecha_baja: null, motivo_baja: null, usuario_id: 1, creado_en: isoDaysAgo(200), actualizado_en: isoDaysAgo(20) },
  ];

  state.mantenimientos = [
    { id: nextId('mantenimientos'), activo_id: 2, tipo: 'correctivo', fecha: today(), programada_para: null, descripcion: 'No enfría y hace ruido en el motor', costo_reparacion: 320, costo_reposicion: 2800, decision: null, estado: 'programado', usuario_id: 1, creado_en: isoMinutesAgo(120), fecha_autorizacion: null },
    { id: nextId('mantenimientos'), activo_id: 1, tipo: 'preventivo', fecha: null, programada_para: dateInDays(20), descripcion: 'Limpieza profunda y revisión de quemadores', costo_reparacion: 0, costo_reposicion: 0, decision: null, estado: 'programado', usuario_id: 1, creado_en: isoDaysAgo(10), fecha_autorizacion: null },
  ];

  state.liquidaciones = [
    {
      id: nextId('liquidaciones'),
      plataforma: 'rappi',
      desde: isoDaysAgo(3).slice(0, 10),
      hasta: isoDaysAgo(1).slice(0, 10),
      monto_bruto: 480,
      comision: 120,
      monto_neto: 360,
      estado: 'registrada',
      observacion: null,
      usuario_id: 1,
      creado_en: isoDaysAgo(1),
    },
  ];

  state.cuadres_caja.push({
    id: nextId('cuadres_caja'),
    fecha: today(),
    estado: 'abierta',
    fondo_inicial: 200,
    usuario_apertura_id: 2,
    fecha_apertura: isoMinutesAgo(180),
    total_ventas: 0,
    total_egresos: 0,
    monto_esperado: 0,
    efectivo_contado: null,
    pagos_digitales: 0,
    total_real: null,
    diferencia: null,
    observaciones: null,
    usuario_cierre_id: null,
    fecha_cierre: null,
  });

  return state;
}

function getConfig(clave) {
  return state.config[clave];
}

function updateConfig(clave, valor) {
  state.config[clave] = valor;
  const record = state.configuracion.find((item) => item.clave === clave);
  if (record) {
    record.valor = String(valor);
    record.actualizado_en = nowIso();
  } else {
    state.configuracion.push({
      id: nextId('configuracion'),
      clave,
      valor: String(valor),
      descripcion: null,
      actualizado_en: nowIso(),
    });
  }
  return valor;
}

seed();

module.exports = {
  state,
  PERMISOS,
  ROLES,
  ROLE_PERMISOS,
  nextId,
  find,
  findOrThrow,
  permisosDeRoles,
  calcTotals,
  generarNumeroPedido,
  generarComprobanteNumero,
  cajaAbierta,
  requireCajaAbierta,
  applyMovement,
  addPago,
  getConfig,
  updateConfig,
  round2,
  round3,
  nowIso,
  today,
  fechaDe,
  isoMinutesAgo,
  isoDaysAgo,
  dateInDays,
};
