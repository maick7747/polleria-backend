'use strict';

// Tablero agregado de /venta-local.
// Devuelve mesas + cuentas abiertas + sus rondas y detalles en un número fijo
// de consultas (sin N+1 por cuenta). Contrato estable para el frontend:
//   { generado_en, mesas[], cuentas[] }

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const pedidos = require('../../lib/pedidos');

const PAGE_SIZE = 500;

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nombreUsuarioSync(usuarioId) {
  if (!usuarioId) {
    return null;
  }
  const usuario = store.find('usuarios', usuarioId);
  return usuario ? usuario.nombre : null;
}

function clienteResumen(cliente) {
  if (!cliente) {
    return null;
  }
  return {
    id: cliente.id,
    nombre: cliente.nombre,
    tipo_documento: cliente.tipo_documento ?? null,
    numero_documento: cliente.numero_documento ?? null,
    telefono: cliente.telefono ?? null,
  };
}

function normalizarDetalle(detalle) {
  return {
    id: detalle.id,
    pedido_id: detalle.pedido_id,
    platillo_id: detalle.platillo_id,
    cantidad: num(detalle.cantidad),
    precio_unitario: num(detalle.precio_unitario),
    subtotal: num(detalle.subtotal),
    notas: detalle.notas ?? null,
    estado_preparacion: detalle.estado_preparacion ?? null,
    fecha_inicio_prep: detalle.fecha_inicio_prep ?? null,
    fecha_listo: detalle.fecha_listo ?? null,
    platillo_nombre: detalle.platillo_nombre ?? null,
    // KDS v2: la vista de Mesas necesita saber si la línea ya se entregó.
    estacion: detalle.estacion ?? null,
    curso: detalle.curso ?? null,
    entregado_en: detalle.entregado_en ?? null,
  };
}

function normalizarPedido(pedido, extras = {}) {
  return {
    id: pedido.id,
    numero: pedido.numero,
    fecha_pedido: pedido.fecha_pedido,
    canal: pedido.canal,
    tipo_consumo: pedido.tipo_consumo,
    mesa_id: pedido.mesa_id ?? null,
    cuenta_id: pedido.cuenta_id ?? null,
    cliente_id: pedido.cliente_id ?? null,
    repartidor_id: pedido.repartidor_id ?? null,
    usuario_cajero_id: pedido.usuario_cajero_id ?? null,
    estado: pedido.estado,
    estado_pago: pedido.estado_pago ?? null,
    metodo_pago: pedido.metodo_pago ?? null,
    subtotal: num(pedido.subtotal),
    igv: num(pedido.igv),
    total: num(pedido.total),
    comision_plataforma: num(pedido.comision_plataforma),
    costo_delivery: num(pedido.costo_delivery),
    direccion_entrega: pedido.direccion_entrega ?? null,
    referencia_entrega: pedido.referencia_entrega ?? null,
    observaciones: pedido.observaciones ?? null,
    comprobante_tipo: pedido.comprobante_tipo ?? null,
    comprobante_numero: pedido.comprobante_numero ?? null,
    fecha_inicio_prep: pedido.fecha_inicio_prep ?? null,
    fecha_listo: pedido.fecha_listo ?? null,
    fecha_entrega: pedido.fecha_entrega ?? null,
    estado_entrega: pedido.estado_entrega ?? null,
    mesa_numero: extras.mesa_numero ?? pedido.mesa_numero ?? null,
    cliente_nombre: extras.cliente_nombre ?? pedido.cliente_nombre ?? null,
    repartidor_nombre: extras.repartidor_nombre ?? pedido.repartidor_nombre ?? null,
    detalles: Array.isArray(pedido.detalles)
      ? pedido.detalles.map(normalizarDetalle)
      : [],
  };
}

function armarTablero(mesas, cuentasAbiertas, pedidosPorCuenta) {
  const porMesa = new Map(cuentasAbiertas.map((cuenta) => [cuenta.mesa_id, cuenta]));
  const mesasActivas = mesas.filter((mesa) => mesa.activa !== false);
  const mesasOcupadas = mesasActivas.filter((mesa) => porMesa.has(mesa.id)).length;
  const totalAbierto = Math.round(
    cuentasAbiertas.reduce((suma, cuenta) => suma + num(cuenta.total), 0) * 100,
  ) / 100;

  return {
    generado_en: new Date().toISOString(),
    meta: {
      resumen: {
        mesas_total: mesasActivas.length,
        mesas_ocupadas: mesasOcupadas,
        mesas_libres: mesasActivas.length - mesasOcupadas,
        cuentas_abiertas: cuentasAbiertas.length,
        total_abierto: totalAbierto,
      },
    },
    mesas: mesasActivas
      .sort((a, b) => Number(a.numero) - Number(b.numero))
      .map((mesa) => {
        const cuenta = porMesa.get(mesa.id) || null;
        const rondas = cuenta ? pedidosPorCuenta.get(cuenta.id) || [] : [];
        return {
          id: mesa.id,
          numero: mesa.numero,
          estado: cuenta ? 'ocupada' : 'libre',
          activa: mesa.activa !== false,
          cuenta_abierta: cuenta
            ? {
                id: cuenta.id,
                total: num(cuenta.total),
                fecha_apertura: cuenta.fecha_apertura,
                usuario_apertura_id: cuenta.usuario_apertura_id,
                usuario_apertura_nombre: cuenta.usuario_apertura_nombre ?? null,
                cliente: cuenta.cliente ?? null,
                rondas: rondas.length,
              }
            : null,
        };
      }),
    cuentas: cuentasAbiertas.map((cuenta) => {
      const rondas = pedidosPorCuenta.get(cuenta.id) || [];
      return {
        id: cuenta.id,
        mesa_id: cuenta.mesa_id,
        estado: cuenta.estado,
        total: num(cuenta.total),
        fecha_apertura: cuenta.fecha_apertura,
        usuario_apertura_id: cuenta.usuario_apertura_id,
        usuario_apertura_nombre: cuenta.usuario_apertura_nombre ?? null,
        fecha_cierre: cuenta.fecha_cierre ?? null,
        usuario_cierre_id: cuenta.usuario_cierre_id ?? null,
        comprobante_tipo: cuenta.comprobante_tipo ?? null,
        comprobante_numero: cuenta.comprobante_numero ?? null,
        cliente_id: cuenta.cliente_id ?? null,
        cliente: cuenta.cliente ?? null,
        rondas: rondas.length,
        pedidos: rondas,
      };
    }),
  };
}

function obtenerTableroMemoria() {
  const cuentasAbiertas = store.state.cuentas
    .filter((cuenta) => cuenta.estado === 'abierta')
    .sort((a, b) => Number(b.id) - Number(a.id))
    .map((cuenta) => {
      const cliente = cuenta.cliente_id ? store.find('clientes', cuenta.cliente_id) : null;
      return {
        ...cuenta,
        usuario_apertura_nombre: nombreUsuarioSync(cuenta.usuario_apertura_id),
        cliente: clienteResumen(cliente),
      };
    });

  const idsCuentas = new Set(cuentasAbiertas.map((cuenta) => cuenta.id));
  const pedidosPorCuenta = new Map();

  for (const pedido of [...store.state.pedidos].sort((a, b) => Number(a.id) - Number(b.id))) {
    if (pedido.cuenta_id == null || !idsCuentas.has(pedido.cuenta_id)) {
      continue;
    }
    const lista = pedidosPorCuenta.get(pedido.cuenta_id) || [];
    lista.push(normalizarPedido(pedidos.pedidoConDetalles(pedido)));
    pedidosPorCuenta.set(pedido.cuenta_id, lista);
  }

  return armarTablero(store.state.mesas, cuentasAbiertas, pedidosPorCuenta);
}

// repository.list limita a 100 filas por página; esta helper recorre las
// páginas necesarias reutilizando el mismo orden. No es N+1 por cuenta: el
// número de consultas no depende del número de cuentas.
async function listAll(table, options = {}) {
  const collected = [];
  let page = 1;

  for (;;) {
    const { data, meta } = await repository.list(table, {
      ...options,
      page,
      limit: PAGE_SIZE,
    });
    collected.push(...data);

    const total = meta ? Number(meta.total) : NaN;
    if (!Number.isFinite(total) || collected.length >= total || data.length === 0) {
      return collected;
    }
    page += 1;
  }
}

function idsUnicos(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))];
}

async function obtenerTableroSupabase() {
  const mesas = await listAll('mesas', {
    filters: { activa: true },
    orderBy: 'numero',
    ascending: true,
  });

  const cuentas = await listAll('cuentas', {
    filters: { estado: 'abierta' },
    orderBy: 'id',
    ascending: false,
  });

  const idsCuentas = idsUnicos(cuentas.map((cuenta) => cuenta.id));
  let filasPedidos = [];
  let filasDetalles = [];

  if (idsCuentas.length > 0) {
    filasPedidos = await listAll('pedidos', {
      filters: { cuenta_id: idsCuentas },
      orderBy: 'id',
      ascending: true,
    });
  }

  const idsPedidos = idsUnicos(filasPedidos.map((pedido) => pedido.id));
  if (idsPedidos.length > 0) {
    filasDetalles = await listAll('pedido_detalles', {
      filters: { pedido_id: idsPedidos },
      orderBy: 'id',
      ascending: true,
    });
  }

  const idsPlatillos = idsUnicos(filasDetalles.map((detalle) => detalle.platillo_id));
  const idsUsuarios = idsUnicos([
    ...cuentas.map((cuenta) => cuenta.usuario_apertura_id),
    ...filasPedidos.map((pedido) => pedido.repartidor_id),
  ]);
  const idsClientes = idsUnicos([
    ...cuentas.map((cuenta) => cuenta.cliente_id),
    ...filasPedidos.map((pedido) => pedido.cliente_id),
  ]);

  const [platillos, usuarios, clientes] = await Promise.all([
    idsPlatillos.length > 0
      ? listAll('platillos', {
          select: 'id,nombre',
          filters: { id: idsPlatillos },
        })
      : [],
    idsUsuarios.length > 0
      ? listAll('usuarios', {
          select: 'id,nombre',
          filters: { id: idsUsuarios },
        })
      : [],
    idsClientes.length > 0
      ? listAll('clientes', {
          select: 'id,nombre,tipo_documento,numero_documento,telefono',
          filters: { id: idsClientes },
        })
      : [],
  ]);

  const platillosPorId = new Map(platillos.map((platillo) => [platillo.id, platillo.nombre]));
  const usuariosPorId = new Map(usuarios.map((usuario) => [usuario.id, usuario.nombre]));
  const clientesPorId = new Map(clientes.map((cliente) => [cliente.id, cliente]));
  const mesasPorId = new Map(mesas.map((mesa) => [mesa.id, mesa]));

  const detallesPorPedido = new Map();
  for (const fila of filasDetalles) {
    const lista = detallesPorPedido.get(fila.pedido_id) || [];
    lista.push(
      normalizarDetalle({
        ...fila,
        platillo_nombre: platillosPorId.get(fila.platillo_id) ?? null,
      }),
    );
    detallesPorPedido.set(fila.pedido_id, lista);
  }

  const pedidosPorCuenta = new Map();
  for (const fila of filasPedidos) {
    const cliente = fila.cliente_id ? clientesPorId.get(fila.cliente_id) : null;
    const mesa = fila.mesa_id ? mesasPorId.get(fila.mesa_id) : null;
    const lista = pedidosPorCuenta.get(fila.cuenta_id) || [];
    lista.push(
      normalizarPedido(
        { ...fila, detalles: detallesPorPedido.get(fila.id) || [] },
        {
          mesa_numero: mesa ? mesa.numero : null,
          cliente_nombre: cliente ? cliente.nombre : null,
          repartidor_nombre: fila.repartidor_id
            ? usuariosPorId.get(fila.repartidor_id) ?? null
            : null,
        },
      ),
    );
    pedidosPorCuenta.set(fila.cuenta_id, lista);
  }

  const cuentasAbiertas = cuentas.map((cuenta) => {
    const cliente = cuenta.cliente_id ? clientesPorId.get(cuenta.cliente_id) : null;
    return {
      ...cuenta,
      usuario_apertura_nombre: cuenta.usuario_apertura_id
        ? usuariosPorId.get(cuenta.usuario_apertura_id) ?? null
        : null,
      cliente: clienteResumen(cliente),
    };
  });

  return armarTablero(mesas, cuentasAbiertas, pedidosPorCuenta);
}

async function obtenerTablero() {
  if (!db.isSupabase()) {
    return obtenerTableroMemoria();
  }
  return obtenerTableroSupabase();
}

module.exports = { obtenerTablero };
