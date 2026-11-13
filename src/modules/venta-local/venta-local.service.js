'use strict';

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredString,
  optionalString,
  requiredInt,
  requiredEnum,
  optionalNumber,
  optionalDate,
  optionalAfter,
  pageParams,
  paginate,
  metaPaginada,
  parseId,
} = require('../../middleware/validate');
const pedidos = require('../../lib/pedidos');
const pedidosDb = require('../../lib/pedidos-db');
const documentoProviders = require('./providers/documento');

function fechaLima(iso) {
  if (!iso) {
    return null;
  }
  return new Date(Date.parse(iso) - 5 * 3600000).toISOString().slice(0, 10);
}

async function cuentaAbiertaDeMesa(mesaId) {
  if (!db.isSupabase()) {
    return store.state.cuentas.find(
      (cuenta) => cuenta.mesa_id === Number(mesaId) && cuenta.estado === 'abierta',
    ) || null;
  }
  return db.findOne('cuentas', { mesa_id: Number(mesaId), estado: 'abierta' });
}

async function rondasDeCuenta(cuentaId) {
  if (!db.isSupabase()) {
    return store.state.pedidos.filter((pedido) => pedido.cuenta_id === cuentaId);
  }
  const { data } = await repository.list('pedidos', {
    filters: { cuenta_id: Number(cuentaId) },
    orderBy: 'id',
    ascending: true,
    limit: 100,
  });
  return data;
}

function nombreUsuarioSync(usuarioId) {
  if (!usuarioId) {
    return null;
  }
  const usuario = store.find('usuarios', usuarioId);
  return usuario ? usuario.nombre : null;
}

async function nombreUsuario(usuarioId) {
  if (!usuarioId) {
    return null;
  }
  const usuario = await repository.getById('usuarios', usuarioId, 'id,nombre');
  return usuario ? usuario.nombre : null;
}

async function nombresDeUsuarios(ids) {
  const unicos = [...new Set(ids.filter((id) => id != null))];
  if (unicos.length === 0) {
    return new Map();
  }
  const { data } = await repository.list('usuarios', {
    select: 'id,nombre',
    filters: { id: unicos },
    limit: 100,
  });
  return new Map(data.map((usuario) => [usuario.id, usuario.nombre]));
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
    correo: cliente.correo ?? null,
    direccion: cliente.direccion ?? null,
    referencia: cliente.referencia ?? null,
  };
}

async function clienteDeCuenta(cuenta) {
  if (!cuenta || !cuenta.cliente_id) {
    return null;
  }
  if (!db.isSupabase()) {
    return store.find('clientes', cuenta.cliente_id);
  }
  return repository.getById('clientes', cuenta.cliente_id);
}

// Resuelve (crea o actualiza) el cliente asociado a una cuenta. Si se pasa
// `clienteIdActual`, actualiza ese registro (edición del cliente de la cuenta);
// si no, busca por (tipo_documento, numero_documento) y actualiza si existe,
// o crea uno nuevo. Un documento duplicado (código 23505) no es un error: se
// reutiliza el cliente que ya existe.
async function resolverCliente(clientePayload, clienteIdActual = null) {
  if (clientePayload === undefined || clientePayload === null || clientePayload === '') {
    return clienteIdActual;
  }

  const payload = requiredObject(clientePayload, 'cliente');
  const nombre = requiredString(payload.nombre, 'nombre', { max: 120 });
  const tipoDocumento = payload.tipo_documento
    ? requiredEnum(payload.tipo_documento, 'tipo_documento', ['DNI', 'RUC'])
    : null;
  const numeroDocumento = payload.numero_documento
    ? requiredString(payload.numero_documento, 'numero_documento', { max: 11 })
    : null;

  if (tipoDocumento && !numeroDocumento) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El número de documento es obligatorio.', [
      { field: 'numero_documento' },
    ]);
  }

  const datos = {
    nombre,
    tipo_documento: tipoDocumento,
    numero_documento: numeroDocumento,
    telefono: optionalString(payload.telefono, 'telefono', { max: 20 }),
    correo: optionalString(payload.correo, 'correo', { max: 120 }),
    direccion: optionalString(payload.direccion, 'direccion', { max: 200 }),
    referencia: optionalString(payload.referencia, 'referencia', { max: 150 }),
  };
  const actualizadoEn = db.nowIso();

  if (!db.isSupabase()) {
    if (clienteIdActual) {
      const actual = store.find('clientes', clienteIdActual);
      if (actual) {
        Object.assign(actual, datos, { actualizado_en: actualizadoEn });
        return actual.id;
      }
    }
    if (tipoDocumento && numeroDocumento) {
      const existente = store.state.clientes.find(
        (item) =>
          item.tipo_documento === tipoDocumento &&
          item.numero_documento === numeroDocumento,
      );
      if (existente) {
        Object.assign(existente, datos, { actualizado_en: actualizadoEn });
        return existente.id;
      }
    }
    const record = {
      id: store.nextId('clientes'),
      ...datos,
      creado_en: actualizadoEn,
      actualizado_en: actualizadoEn,
    };
    store.state.clientes.push(record);
    return record.id;
  }

  if (clienteIdActual) {
    try {
      const actual = await repository.update('clientes', clienteIdActual, {
        ...datos,
        actualizado_en: actualizadoEn,
      });
      if (actual) {
        return actual.id;
      }
    } catch (error) {
      // Documento duplicado: se resuelve por documento más abajo.
      if (String(error.code) !== '23505') {
        throw db.persistenceError('No se pudo actualizar el cliente de la cuenta.', error);
      }
    }
  }

  if (tipoDocumento && numeroDocumento) {
    const existente = await db.findOne('clientes', {
      tipo_documento: tipoDocumento,
      numero_documento: numeroDocumento,
    });
    if (existente) {
      if (existente.id !== clienteIdActual) {
        await repository.update('clientes', existente.id, {
          ...datos,
          actualizado_en: actualizadoEn,
        });
      }
      return existente.id;
    }
  }

  try {
    const creado = await repository.insert('clientes', datos);
    return creado.id;
  } catch (error) {
    if (String(error.code) === '23505' && tipoDocumento && numeroDocumento) {
      const existente = await db.findOne('clientes', {
        tipo_documento: tipoDocumento,
        numero_documento: numeroDocumento,
      });
      if (existente) {
        return existente.id;
      }
    }
    throw db.persistenceError('No se pudo registrar el cliente de la cuenta.', error);
  }
}

async function resumenCuenta(cuenta, nombres = null) {
  if (!db.isSupabase()) {
    const mesa = store.find('mesas', cuenta.mesa_id);
    const rondas = store.state.pedidos.filter((pedido) => pedido.cuenta_id === cuenta.id);
    const cliente = cuenta.cliente_id ? store.find('clientes', cuenta.cliente_id) : null;
    return {
      ...cuenta,
      usuario_apertura_nombre: nombreUsuarioSync(cuenta.usuario_apertura_id),
      mesa_numero: mesa ? mesa.numero : null,
      cliente: clienteResumen(cliente),
      rondas: rondas.length,
      pedidos: rondas.map((pedido) => pedido.id),
    };
  }

  const [mesa, rondas, usuarioApertura, cliente] = await Promise.all([
    repository.getById('mesas', cuenta.mesa_id),
    rondasDeCuenta(cuenta.id),
    nombres
      ? nombres.get(cuenta.usuario_apertura_id) ?? null
      : nombreUsuario(cuenta.usuario_apertura_id),
    clienteDeCuenta(cuenta),
  ]);
  return {
    ...cuenta,
    total: Number(cuenta.total),
    usuario_apertura_nombre: usuarioApertura,
    mesa_numero: mesa ? mesa.numero : null,
    cliente: clienteResumen(cliente),
    rondas: rondas.length,
    pedidos: rondas.map((pedido) => pedido.id),
  };
}

async function cuentaAbiertaDetalle(mesaId) {
  const cuenta = await cuentaAbiertaDeMesa(mesaId);
  if (!cuenta) {
    return null;
  }
  const [rondas, cliente] = await Promise.all([
    rondasDeCuenta(cuenta.id),
    clienteDeCuenta(cuenta),
  ]);
  const detalle = await Promise.all(rondas.map((pedido) => pedidosDb.pedidoConDetalles(pedido)));
  return {
    ...cuenta,
    total: Number(cuenta.total),
    usuario_apertura_nombre: db.isSupabase()
      ? await nombreUsuario(cuenta.usuario_apertura_id)
      : nombreUsuarioSync(cuenta.usuario_apertura_id),
    mesa_numero: null,
    cliente: clienteResumen(cliente),
    rondas: rondas.length,
    pedidos: detalle,
  };
}

async function listMesas(query = {}) {
  const estado = query.estado
    ? requiredEnum(query.estado, 'estado', ['libre', 'ocupada'])
    : null;

  if (!db.isSupabase()) {
    const data = store.state.mesas
      .filter((mesa) => mesa.activa)
      .map((mesa) => {
        const cuenta = store.state.cuentas.find(
          (item) => item.mesa_id === mesa.id && item.estado === 'abierta',
        );
        return {
          ...mesa,
          estado: cuenta ? 'ocupada' : mesa.estado,
          cuenta_abierta: cuenta
            ? {
                id: cuenta.id,
                total: cuenta.total,
                fecha_apertura: cuenta.fecha_apertura,
                usuario_apertura_id: cuenta.usuario_apertura_id,
                usuario_apertura_nombre: nombreUsuarioSync(cuenta.usuario_apertura_id),
              }
            : null,
        };
      })
      .filter((mesa) => !estado || mesa.estado === estado);

    return paginate(data, { ...query, limit: query.limit || 50 });
  }

  const [{ data: mesas }, { data: cuentas }] = await Promise.all([
    repository.list('mesas', {
      filters: { activa: true },
      orderBy: 'numero',
      ascending: true,
      limit: 100,
    }),
    repository.list('cuentas', {
      filters: { estado: 'abierta' },
      orderBy: 'id',
      ascending: true,
      limit: 100,
    }),
  ]);

  const abiertas = new Map(cuentas.map((cuenta) => [cuenta.mesa_id, cuenta]));
  const nombres = await nombresDeUsuarios(cuentas.map((cuenta) => cuenta.usuario_apertura_id));
  const data = mesas
    .map((mesa) => {
      const cuenta = abiertas.get(mesa.id);
      return {
        ...mesa,
        estado: cuenta ? 'ocupada' : mesa.estado,
        cuenta_abierta: cuenta
          ? {
              id: cuenta.id,
              total: Number(cuenta.total),
              fecha_apertura: cuenta.fecha_apertura,
              usuario_apertura_id: cuenta.usuario_apertura_id,
              usuario_apertura_nombre: nombres.get(cuenta.usuario_apertura_id) ?? null,
            }
          : null,
      };
    })
    .filter((mesa) => !estado || mesa.estado === estado);

  return paginate(data, { ...query, limit: query.limit || 50 });
}

async function getMesa(id) {
  if (!db.isSupabase()) {
    const mesa = store.findOrThrow('mesas', parseId(id), 'Mesa');
    const cuenta = store.state.cuentas.find(
      (item) => item.mesa_id === mesa.id && item.estado === 'abierta',
    );
    return {
      ...mesa,
      estado: cuenta ? 'ocupada' : mesa.estado,
      cuenta_abierta: cuenta
        ? {
            ...(await resumenCuenta(cuenta)),
            pedidos: store.state.pedidos
              .filter((pedido) => pedido.cuenta_id === cuenta.id)
              .map((pedido) => pedidos.pedidoConDetalles(pedido)),
          }
        : null,
    };
  }

  const mesa = await db.findOrThrow('mesas', parseId(id), 'Mesa');
  const detalle = await cuentaAbiertaDetalle(mesa.id);
  if (detalle) {
    detalle.mesa_numero = mesa.numero;
  }
  return {
    ...mesa,
    estado: detalle ? 'ocupada' : mesa.estado,
    cuenta_abierta: detalle,
  };
}

async function listCuentas(query = {}) {
  const estado = query.estado
    ? requiredEnum(query.estado, 'estado', ['abierta', 'cobrada', 'cancelada'])
    : null;
  const after = optionalAfter(query);

  if (!db.isSupabase()) {
    const data = store.state.cuentas
      .filter((cuenta) => !estado || cuenta.estado === estado)
      .filter((cuenta) => !after || Number(cuenta.id) > after)
      .sort((a, b) => b.id - a.id)
      .map((cuenta) => resumenCuentaSync(cuenta));

    return paginate(data, query, { cursor: true });
  }

  const { data } = await repository.list('cuentas', {
    filters: estado ? { estado } : {},
    orderBy: 'id',
    ascending: false,
    limit: 100,
    after,
  });
  const nombres = await nombresDeUsuarios(data.map((cuenta) => cuenta.usuario_apertura_id));
  const mapped = await Promise.all(
    data.map((cuenta) => resumenCuenta(cuenta, nombres)),
  );
  return paginate(mapped, query, { cursor: true });
}

function resumenCuentaSync(cuenta) {
  const mesa = store.find('mesas', cuenta.mesa_id);
  const rondas = store.state.pedidos.filter((pedido) => pedido.cuenta_id === cuenta.id);
  const cliente = cuenta.cliente_id ? store.find('clientes', cuenta.cliente_id) : null;
  return {
    ...cuenta,
    usuario_apertura_nombre: nombreUsuarioSync(cuenta.usuario_apertura_id),
    mesa_numero: mesa ? mesa.numero : null,
    cliente: clienteResumen(cliente),
    rondas: rondas.length,
    pedidos: rondas.map((pedido) => pedido.id),
  };
}

async function getCuentaBasica(id) {
  if (!db.isSupabase()) {
    return resumenCuentaSync(store.findOrThrow('cuentas', parseId(id), 'Cuenta'));
  }
  const cuenta = await db.findOrThrow('cuentas', parseId(id), 'Cuenta');
  return resumenCuenta(cuenta);
}

async function createCuenta(body, usuario) {
  const payload = requiredObject(body);
  const mesaId = requiredInt(payload.mesa_id, 'mesa_id', { min: 1 });

  if (!db.isSupabase()) {
    const mesa = store.findOrThrow('mesas', mesaId, 'Mesa');
    if (!mesa.activa) {
      throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'La mesa está inactiva.');
    }
    if (store.state.cuentas.some((cuenta) => cuenta.mesa_id === mesaId && cuenta.estado === 'abierta')) {
      throw new AppError(409, 'CUENTA_ABIERTA', `La mesa ${mesa.numero} ya tiene una cuenta abierta.`);
    }
    store.requireCajaAbierta();

    const clienteId = await resolverCliente(payload.cliente);

    const cuenta = {
      id: store.nextId('cuentas'),
      mesa_id: mesaId,
      estado: 'abierta',
      total: 0,
      fecha_apertura: store.nowIso(),
      usuario_apertura_id: usuario.id,
      cliente_id: clienteId,
      fecha_cierre: null,
      usuario_cierre_id: null,
      comprobante_tipo: 'boleta',
      comprobante_numero: null,
    };
    store.state.cuentas.push(cuenta);
    mesa.estado = 'ocupada';
    return resumenCuentaSync(cuenta);
  }

  const mesa = await db.findOrThrow('mesas', mesaId, 'Mesa');
  if (!mesa.activa) {
    throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'La mesa está inactiva.');
  }
  if (await cuentaAbiertaDeMesa(mesaId)) {
    throw new AppError(409, 'CUENTA_ABIERTA', `La mesa ${mesa.numero} ya tiene una cuenta abierta.`);
  }
  await db.requireCajaAbierta();

  const clienteId = await resolverCliente(payload.cliente);

  let cuenta;
  try {
    cuenta = await repository.insert('cuentas', {
      mesa_id: mesaId,
      estado: 'abierta',
      total: 0,
      fecha_apertura: db.nowIso(),
      usuario_apertura_id: usuario.id,
      cliente_id: clienteId,
      comprobante_tipo: 'boleta',
    });
  } catch (error) {
    if (String(error.code) === '23505') {
      throw new AppError(409, 'CUENTA_ABIERTA', `La mesa ${mesa.numero} ya tiene una cuenta abierta.`);
    }
    throw db.persistenceError('No se pudo abrir la cuenta.', error);
  }

  try {
    await repository.update('mesas', mesaId, { estado: 'ocupada' });
  } catch (error) {
    try {
      await repository.remove('cuentas', cuenta.id);
    } catch (rollbackError) {
      // compensación best-effort
    }
    throw db.persistenceError(
      `Se abrió la cuenta ${cuenta.id} pero no se pudo marcar la mesa ${mesa.numero} como ocupada.`,
      error,
    );
  }

  return resumenCuenta(cuenta);
}

// Datos de cobro de la cuenta: cliente y tipo de comprobante. Se capturan al
// cerrar la cuenta (no al abrir la mesa), que es cuando el cliente decide qué
// comprobante necesita.
const COMPROBANTES = ['ticket', 'boleta', 'ninguno'];

async function attachCliente(cuentaId, body) {
  const id = parseId(cuentaId);
  const payload = requiredObject(body);

  const quitarCliente = payload.cliente === null;
  const tieneCliente = payload.cliente !== undefined && !quitarCliente;
  const tieneComprobante = payload.comprobante_tipo !== undefined
    && payload.comprobante_tipo !== null;
  if (!tieneCliente && !tieneComprobante && !quitarCliente) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Envía el cliente o el tipo de comprobante.',
      [{ field: 'cliente' }],
    );
  }
  const comprobanteTipo = tieneComprobante
    ? requiredEnum(payload.comprobante_tipo, 'comprobante_tipo', COMPROBANTES)
    : null;

  if (!db.isSupabase()) {
    const cuenta = store.findOrThrow('cuentas', id, 'Cuenta');
    if (cuenta.estado !== 'abierta') {
      throw new AppError(409, 'CONFLICT', 'La cuenta ya no está abierta.');
    }

    if (quitarCliente) {
      cuenta.cliente_id = null;
    } else if (tieneCliente) {
      cuenta.cliente_id = await resolverCliente(payload.cliente, cuenta.cliente_id);
    }
    if (comprobanteTipo) {
      cuenta.comprobante_tipo = comprobanteTipo;
    }
    return resumenCuentaSync(cuenta);
  }

  const cuenta = await db.findOrThrow('cuentas', id, 'Cuenta');
  if (cuenta.estado !== 'abierta') {
    throw new AppError(409, 'CONFLICT', 'La cuenta ya no está abierta.');
  }

  const patch = {};
  if (quitarCliente) {
    patch.cliente_id = null;
  } else if (tieneCliente) {
    patch.cliente_id = await resolverCliente(payload.cliente, cuenta.cliente_id);
  }
  if (comprobanteTipo) {
    patch.comprobante_tipo = comprobanteTipo;
  }

  let actualizada;
  try {
    actualizada = await repository.update('cuentas', cuenta.id, patch);
  } catch (error) {
    throw db.persistenceError('No se pudieron guardar los datos de cobro de la cuenta.', error);
  }

  return resumenCuenta(actualizada || { ...cuenta, ...patch });
}

// Ajusta cuentas.total en una sola operacion atomica cuando la RPC existe
// (migracion 006): evita lost updates por read-modify-write. Si la funcion no
// esta aplicada, se conserva el comportamiento anterior.
async function ajustarTotalCuenta(cuenta, delta, mensajeError) {
  if (db.isSupabase()) {
    try {
      return await repository.rpc('fn_sumar_total_cuenta', {
        p_cuenta_id: Number(cuenta.id),
        p_delta: db.round2(delta),
      });
    } catch (error) {
      if (!repository.esFuncionInexistente(error)) {
        throw db.persistenceError(mensajeError, error);
      }
    }
  }

  const total = db.round2(Math.max(0, Number(cuenta.total) + Number(delta)));
  if (!db.isSupabase()) {
    cuenta.total = total;
    return total;
  }
  const actualizada = await repository.update('cuentas', cuenta.id, { total });
  return actualizada ? Number(actualizada.total) : total;
}

function parseIdempotencyKey(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return requiredString(value, 'idempotency_key', { max: 64 });
}

function parseEnviarCocina(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new AppError(400, 'VALIDATION_ERROR', 'enviar_cocina debe ser booleano.', [
      { field: 'enviar_cocina' },
    ]);
  }
  return value;
}

async function addRonda(cuentaId, body, usuario) {
  const id = parseId(cuentaId);
  const payload = requiredObject(body);
  const idempotencyKey = parseIdempotencyKey(payload.idempotency_key);
  const enviarCocina = parseEnviarCocina(payload.enviar_cocina);

  if (!db.isSupabase()) {
    const cuenta = store.findOrThrow('cuentas', id, 'Cuenta');

    if (idempotencyKey) {
      const previo = store.state.pedidos.find(
        (pedido) => pedido.idempotency_key === idempotencyKey,
      );
      if (previo) {
        return { ...pedidos.pedidoConDetalles(previo), idempotente: true };
      }
    }

    if (cuenta.estado !== 'abierta') {
      throw new AppError(409, 'CONFLICT', 'La cuenta ya no está abierta.');
    }
    store.requireCajaAbierta();

    const pedido = pedidos.createPedidoRecord({
      canal: 'local',
      tipo_consumo: 'sala',
      mesa_id: cuenta.mesa_id,
      cuenta_id: cuenta.id,
      usuario_id: usuario.id,
      items: payload.items,
      observaciones: payload.observaciones,
      idempotency_key: idempotencyKey,
    });

    cuenta.total = store.round2(cuenta.total + pedido.total);

    if (!enviarCocina) {
      return pedidos.pedidoConDetalles(pedido);
    }

    try {
      const envio = pedidos.enviarPedidoACocina(pedido, usuario.id);
      return {
        ...pedidos.pedidoConDetalles(envio.pedido),
        movimientos_inventario: envio.movimientos.length,
      };
    } catch (error) {
      if (pedido.stock_descontado === true) {
        pedidos.revertirStockPedido(pedido, usuario.id, 'No se pudo enviar a cocina');
      }
      pedido.estado = 'cancelado';
      cuenta.total = store.round2(Math.max(0, cuenta.total - pedido.total));
      throw error;
    }
  }

  try {
    return await pedidosDb.crearRondaYEnviarRpc({
      cuentaId: id,
      usuarioId: usuario.id,
      items: payload.items,
      observaciones: payload.observaciones,
      idempotencyKey,
      enviar: enviarCocina,
    });
  } catch (error) {
    if (!repository.esFuncionInexistente(error)) {
      const traducido = pedidosDb.traducirErrorRpc(error);
      if (traducido) {
        throw traducido;
      }
      throw db.persistenceError('No se pudo registrar la ronda.', error);
    }
  }

  const cuenta = await db.findOrThrow('cuentas', id, 'Cuenta');

  if (idempotencyKey) {
    const previo = await db.findOne('pedidos', { idempotency_key: idempotencyKey });
    if (previo) {
      return { ...(await pedidosDb.pedidoConDetalles(previo)), idempotente: true };
    }
  }

  if (cuenta.estado !== 'abierta') {
    throw new AppError(409, 'CONFLICT', 'La cuenta ya no está abierta.');
  }
  await db.requireCajaAbierta();

  let pedido;
  try {
    pedido = await pedidosDb.createPedidoRecord({
      canal: 'local',
      tipo_consumo: 'sala',
      mesa_id: cuenta.mesa_id,
      cuenta_id: cuenta.id,
      usuario_id: usuario.id,
      items: payload.items,
      observaciones: payload.observaciones,
      idempotency_key: idempotencyKey,
    });
  } catch (error) {
    // Protección de carrera: otra petición con la misma clave pudo ganar
    // entre la búsqueda previa y el insert. Si el pedido ya existe, se
    // devuelve ese en lugar de propagar el fallo de unicidad.
    if (idempotencyKey) {
      const previo = await db
        .findOne('pedidos', { idempotency_key: idempotencyKey })
        .catch(() => null);
      if (previo) {
        return { ...(await pedidosDb.pedidoConDetalles(previo)), idempotente: true };
      }
    }
    throw error;
  }

  await ajustarTotalCuenta(
    cuenta,
    pedido.total,
    `La ronda ${pedido.numero} se registró pero no se pudo actualizar el total de la cuenta.`,
  );

  if (!enviarCocina) {
    return pedidosDb.pedidoConDetalles(pedido, { detalles: pedido.detalles });
  }

  try {
    const envio = await pedidosDb.enviarPedidoACocina(pedido, usuario.id);
    const detalle = await pedidosDb.pedidoConDetalles(envio.pedido, { detalles: envio.detalles });
    return {
      ...detalle,
      movimientos_inventario: envio.movimientos.length,
    };
  } catch (error) {
    await pedidosDb
      .revertirStockPedido(pedido, usuario.id, 'No se pudo enviar a cocina')
      .catch(() => []);
    await repository.update('pedidos', pedido.id, { estado: 'cancelado' }).catch(() => null);
    await ajustarTotalCuenta(
      cuenta,
      -Number(pedido.total),
      `La ronda ${pedido.numero} no se pudo enviar a cocina y no se pudo ajustar el total.`,
    ).catch(() => null);
    throw error;
  }
}

async function listPedidos(query = {}) {
  const estado = query.estado
    ? requiredEnum(query.estado, 'estado', ['borrador', 'en_cocina', 'servido', 'cobrado', 'cancelado'])
    : null;
  const canal = query.canal
    ? requiredEnum(query.canal, 'canal', pedidos.CANALES)
    : null;
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');
  const after = optionalAfter(query);

  if (!db.isSupabase()) {
    const data = store.state.pedidos
      .filter((pedido) => !estado || pedido.estado === estado)
      .filter((pedido) => !canal || pedido.canal === canal)
      .filter((pedido) => !desde || pedido.fecha_pedido.slice(0, 10) >= desde)
      .filter((pedido) => !hasta || pedido.fecha_pedido.slice(0, 10) <= hasta)
      .filter((pedido) => !after || Number(pedido.id) > after)
      .sort((a, b) => b.id - a.id)
      .map((pedido) => pedidos.pedidoConDetalles(pedido));

    return paginate(data, query, { cursor: true });
  }

  const filters = {};
  if (estado) {
    filters.estado = estado;
  }
  if (canal) {
    filters.canal = canal;
  }
  if (desde || hasta) {
    filters.fecha_pedido = {
      op: 'between',
      value: [
        `${desde || '1970-01-01'}T00:00:00-05:00`,
        `${hasta || '2999-12-31'}T23:59:59.999-05:00`,
      ],
    };
  }

  const { page, limit } = pageParams(query);
  const { data, meta } = await repository.list('pedidos', {
    filters,
    orderBy: 'id',
    ascending: false,
    page,
    limit,
    after,
  });

  const mapped = await Promise.all(data.map((pedido) => pedidosDb.pedidoConDetalles(pedido)));
  return { data: mapped, meta };
}

async function getPedido(id) {
  if (!db.isSupabase()) {
    return pedidos.pedidoConDetalles(store.findOrThrow('pedidos', parseId(id), 'Pedido'));
  }
  const pedido = await db.findOrThrow('pedidos', parseId(id), 'Pedido');
  return pedidosDb.pedidoConDetalles(pedido);
}

async function createPedido(body, usuario) {
  const payload = requiredObject(body);

  if (!db.isSupabase()) {
    store.requireCajaAbierta();

    if (payload.cuenta_id) {
      const cuenta = store.findOrThrow('cuentas', requiredInt(payload.cuenta_id, 'cuenta_id'), 'Cuenta');
      if (cuenta.estado !== 'abierta') {
        throw new AppError(409, 'CONFLICT', 'La cuenta no está abierta.');
      }
    }

    if (payload.mesa_id) {
      store.findOrThrow('mesas', requiredInt(payload.mesa_id, 'mesa_id'), 'Mesa');
    }

    const pedido = pedidos.createPedidoRecord({
      canal: payload.canal || 'local',
      tipo_consumo: payload.tipo_consumo || 'para_llevar',
      items: payload.items,
      mesa_id: payload.mesa_id,
      cuenta_id: payload.cuenta_id,
      cliente_id: payload.cliente_id,
      repartidor_id: payload.repartidor_id,
      usuario_id: usuario.id,
      observaciones: payload.observaciones,
      direccion_entrega: payload.direccion_entrega,
      referencia_entrega: payload.referencia_entrega,
      costo_delivery: optionalNumber(payload.costo_delivery, 'costo_delivery', { min: 0 }) || 0,
    });

    if (pedido.cuenta_id) {
      const cuenta = store.findOrThrow('cuentas', pedido.cuenta_id, 'Cuenta');
      cuenta.total = store.round2(cuenta.total + pedido.total);
    }

    return pedidos.pedidoConDetalles(pedido);
  }

  await db.requireCajaAbierta();

  if (payload.cuenta_id) {
    const cuenta = await db.findOrThrow(
      'cuentas',
      requiredInt(payload.cuenta_id, 'cuenta_id'),
      'Cuenta',
    );
    if (cuenta.estado !== 'abierta') {
      throw new AppError(409, 'CONFLICT', 'La cuenta no está abierta.');
    }
  }

  if (payload.mesa_id) {
    await db.findOrThrow('mesas', requiredInt(payload.mesa_id, 'mesa_id'), 'Mesa');
  }

  const pedido = await pedidosDb.createPedidoRecord({
    canal: payload.canal || 'local',
    tipo_consumo: payload.tipo_consumo || 'para_llevar',
    items: payload.items,
    mesa_id: payload.mesa_id,
    cuenta_id: payload.cuenta_id,
    cliente_id: payload.cliente_id,
    repartidor_id: payload.repartidor_id,
    usuario_id: usuario.id,
    observaciones: payload.observaciones,
    direccion_entrega: payload.direccion_entrega,
    referencia_entrega: payload.referencia_entrega,
    costo_delivery: optionalNumber(payload.costo_delivery, 'costo_delivery', { min: 0 }) || 0,
  });

  if (pedido.cuenta_id) {
    const cuenta = await db.findOrThrow('cuentas', pedido.cuenta_id, 'Cuenta');
    await ajustarTotalCuenta(
      cuenta,
      pedido.total,
      `El pedido ${pedido.numero} se registró pero no se pudo actualizar el total de la cuenta.`,
    );
  }

  return pedidosDb.pedidoConDetalles(pedido, { detalles: pedido.detalles });
}

async function updatePedido(id, body) {
  const payload = requiredObject(body);

  if (!db.isSupabase()) {
    const pedido = store.findOrThrow('pedidos', parseId(id), 'Pedido');
    if (pedido.estado !== 'borrador') {
      throw new AppError(409, 'PEDIDO_NO_EDITABLE', 'Solo se puede editar un pedido en borrador.');
    }

    const totalAnterior = pedido.total;

    if (payload.observaciones !== undefined) {
      pedido.observaciones = optionalString(payload.observaciones, 'observaciones', { max: 300 });
    }
    if (payload.direccion_entrega !== undefined) {
      pedido.direccion_entrega = optionalString(payload.direccion_entrega, 'direccion_entrega', { max: 200 });
    }
    if (payload.referencia_entrega !== undefined) {
      pedido.referencia_entrega = optionalString(payload.referencia_entrega, 'referencia_entrega', { max: 150 });
    }
    if (payload.costo_delivery !== undefined) {
      pedido.costo_delivery = optionalNumber(payload.costo_delivery, 'costo_delivery', { min: 0 }) || 0;
    }

    if (payload.items !== undefined) {
      const { detalles, subtotal } = pedidos.buildDetalles(payload.items);
      store.state.pedido_detalles = store.state.pedido_detalles.filter(
        (detail) => detail.pedido_id !== pedido.id,
      );
      for (const detail of detalles) {
        store.state.pedido_detalles.push({
          id: store.nextId('pedido_detalles'),
          pedido_id: pedido.id,
          ...detail,
          estado_preparacion: 'pendiente',
          fecha_inicio_prep: null,
          fecha_listo: null,
        });
      }
      const totals = store.calcTotals(subtotal, pedido.costo_delivery);
      pedido.subtotal = totals.subtotal;
      pedido.igv = totals.igv;
      pedido.total = totals.total;
    } else if (payload.costo_delivery !== undefined) {
      const totals = store.calcTotals(pedido.subtotal, pedido.costo_delivery);
      pedido.igv = totals.igv;
      pedido.total = totals.total;
    }

    if (pedido.cuenta_id) {
      const cuenta = store.find('cuentas', pedido.cuenta_id);
      if (cuenta && cuenta.estado === 'abierta') {
        cuenta.total = store.round2(Math.max(0, cuenta.total - totalAnterior + pedido.total));
      }
    }

    return pedidos.pedidoConDetalles(pedido);
  }

  const pedido = await db.findOrThrow('pedidos', parseId(id), 'Pedido');
  if (pedido.estado !== 'borrador') {
    throw new AppError(409, 'PEDIDO_NO_EDITABLE', 'Solo se puede editar un pedido en borrador.');
  }

  const totalAnterior = Number(pedido.total);
  const patch = {};

  if (payload.observaciones !== undefined) {
    patch.observaciones = optionalString(payload.observaciones, 'observaciones', { max: 300 });
  }
  if (payload.direccion_entrega !== undefined) {
    patch.direccion_entrega = optionalString(payload.direccion_entrega, 'direccion_entrega', { max: 200 });
  }
  if (payload.referencia_entrega !== undefined) {
    patch.referencia_entrega = optionalString(payload.referencia_entrega, 'referencia_entrega', { max: 150 });
  }
  if (payload.costo_delivery !== undefined) {
    patch.costo_delivery = optionalNumber(payload.costo_delivery, 'costo_delivery', { min: 0 }) || 0;
  }

  if (payload.items !== undefined) {
    const { detalles, subtotal } = await pedidosDb.buildDetalles(payload.items);
    const { data: existentes } = await repository.list('pedido_detalles', {
      filters: { pedido_id: pedido.id },
      limit: 100,
    });
    for (const detail of existentes) {
      await repository.remove('pedido_detalles', detail.id);
    }
    for (const detail of detalles) {
      await repository.insert('pedido_detalles', {
        pedido_id: pedido.id,
        platillo_id: detail.platillo_id,
        cantidad: detail.cantidad,
        precio_unitario: detail.precio_unitario,
        notas: detail.notas,
        estado_preparacion: 'pendiente',
        fecha_inicio_prep: null,
        fecha_listo: null,
      });
    }
    const costo = patch.costo_delivery !== undefined
      ? Number(patch.costo_delivery)
      : Number(pedido.costo_delivery);
    const totals = await db.calcTotals(subtotal, costo);
    patch.subtotal = totals.subtotal;
    patch.igv = totals.igv;
    patch.total = totals.total;
  } else if (payload.costo_delivery !== undefined) {
    const totals = await db.calcTotals(Number(pedido.subtotal), Number(patch.costo_delivery));
    patch.igv = totals.igv;
    patch.total = totals.total;
  }

  let actualizado = pedido;
  if (Object.keys(patch).length > 0) {
    actualizado = (await repository.update('pedidos', pedido.id, patch)) || pedido;
  }

  if (pedido.cuenta_id) {
    const cuenta = await repository.getById('cuentas', pedido.cuenta_id);
    if (cuenta && cuenta.estado === 'abierta') {
      await repository.update('cuentas', cuenta.id, {
        total: db.round2(
          Math.max(0, Number(cuenta.total) - totalAnterior + Number(actualizado.total)),
        ),
      });
    }
  }

  return pedidosDb.pedidoConDetalles(actualizado);
}

async function enviarCocina(id, usuario) {
  if (!db.isSupabase()) {
    const pedido = store.findOrThrow('pedidos', parseId(id), 'Pedido');
    const result = pedidos.enviarPedidoACocina(pedido, usuario.id);
    return {
      ...pedidos.pedidoConDetalles(result.pedido),
      movimientos_inventario: result.movimientos.length,
    };
  }

  const pedido = await db.findOrThrow('pedidos', parseId(id), 'Pedido');
  const result = await pedidosDb.enviarPedidoACocina(pedido, usuario.id);
  const detalle = await pedidosDb.pedidoConDetalles(result.pedido, { detalles: result.detalles });
  return {
    ...detalle,
    movimientos_inventario: result.movimientos.length,
  };
}

async function cancelarPedido(id, body, usuario) {
  const payload = requiredObject(body || {});
  const motivo = optionalString(payload.motivo, 'motivo', { max: 300 });

  if (!db.isSupabase()) {
    const pedido = store.findOrThrow('pedidos', parseId(id), 'Pedido');
    if (pedido.estado === 'cobrado') {
      throw new AppError(409, 'CONFLICT', 'Un pedido cobrado no puede cancelarse.');
    }
    if (pedido.estado === 'cancelado') {
      throw new AppError(409, 'CONFLICT', 'El pedido ya está cancelado.');
    }

    const movimientos = pedidos.revertirStockPedido(pedido, usuario.id, motivo || 'Cancelación de pedido');
    pedido.estado = 'cancelado';
    pedido.fecha_cancelacion = store.nowIso();
    pedido.motivo_cancelacion = motivo;

    if (pedido.cuenta_id) {
      const cuenta = store.find('cuentas', pedido.cuenta_id);
      if (cuenta && cuenta.estado === 'abierta') {
        cuenta.total = store.round2(Math.max(0, cuenta.total - pedido.total));
      }
    }

    return {
      ...pedidos.pedidoConDetalles(pedido),
      movimientos_inventario: movimientos.length,
    };
  }

  const pedido = await db.findOrThrow('pedidos', parseId(id), 'Pedido');
  if (pedido.estado === 'cobrado') {
    throw new AppError(409, 'CONFLICT', 'Un pedido cobrado no puede cancelarse.');
  }
  if (pedido.estado === 'cancelado') {
    throw new AppError(409, 'CONFLICT', 'El pedido ya está cancelado.');
  }

  // Transición ATÓMICA antes de reponer stock: solo la primera cancelación
  // gana. Así dos terminales (o un reintento) no devuelven el stock dos veces.
  const cancelados = await repository.updateWhere(
    'pedidos',
    { id: pedido.id, estado: ['borrador', 'en_cocina', 'servido'] },
    { estado: 'cancelado' },
  );
  if (!cancelados || cancelados.length === 0) {
    throw new AppError(409, 'PEDIDO_YA_CERRADO', 'El pedido ya fue cobrado o cancelado.');
  }

  const movimientos = await pedidosDb.revertirStockPedido(
    pedido,
    usuario.id,
    motivo || 'Cancelación de pedido',
  );

  // El esquema no tiene columnas fecha_cancelacion/motivo_cancelacion:
  // el motivo se conserva en el log de la petición y el estado queda en 'cancelado'.
  const actualizado = cancelados[0];

  if (pedido.cuenta_id) {
    const cuenta = await repository.getById('cuentas', pedido.cuenta_id);
    if (cuenta && cuenta.estado === 'abierta') {
      await ajustarTotalCuenta(
        cuenta,
        -Number(pedido.total),
        `El pedido ${pedido.numero} se canceló pero no se pudo actualizar el total de la cuenta.`,
      );
    }
  }

  return {
    ...(await pedidosDb.pedidoConDetalles(actualizado)),
    movimientos_inventario: movimientos.length,
  };
}

const CAMPOS_CLIENTE = [
  'id',
  'nombre',
  'tipo_documento',
  'numero_documento',
  'telefono',
  'direccion',
  'referencia',
  'creado_en',
];

function clienteDTO(cliente) {
  return {
    id: cliente.id,
    nombre: cliente.nombre,
    tipo_documento: cliente.tipo_documento ?? null,
    numero_documento: cliente.numero_documento ?? null,
    telefono: cliente.telefono ?? null,
    direccion: cliente.direccion ?? null,
    referencia: cliente.referencia ?? null,
    creado_en: cliente.creado_en ?? null,
  };
}

async function listClientes(query = {}) {
  const documento = query.documento ? String(query.documento).trim() : '';
  const q = query.q ? String(query.q).trim() : '';
  const after = optionalAfter(query);

  if (!db.isSupabase()) {
    const buscado = q.toLowerCase();
    const data = store.state.clientes
      .filter((cliente) => !after || Number(cliente.id) > after)
      .filter((cliente) => !documento || String(cliente.numero_documento || '').includes(documento))
      .filter(
        (cliente) =>
          !buscado ||
          String(cliente.nombre || '').toLowerCase().includes(buscado) ||
          String(cliente.numero_documento || '').includes(buscado),
      )
      .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)))
      .map(clienteDTO);

    return paginate(data, query, { cursor: true });
  }

  const { page, limit } = pageParams(query);
  let consulta = repository
    .table('clientes')
    .select(CAMPOS_CLIENTE.join(', '), { count: 'exact' });

  if (after) {
    consulta = consulta.gt('id', after);
  }
  if (documento) {
    consulta = consulta.ilike('numero_documento', `%${documento}%`);
  }
  if (q) {
    // `or` de PostgREST usa comas y paréntesis como sintaxis: se limpian del
    // término para que el filtro no se rompa con texto libre.
    const termino = q.replace(/[,()]/g, ' ').trim();
    if (termino) {
      consulta = consulta.or(
        `nombre.ilike.%${termino}%,numero_documento.ilike.%${termino}%`,
      );
    }
  }

  consulta = consulta.order('nombre', { ascending: true }).order('id', { ascending: true });

  const inicio = (page - 1) * limit;
  const { data, error, count } = await consulta.range(inicio, inicio + limit - 1);
  if (error) {
    throw db.persistenceError('No se pudieron listar los clientes.', error);
  }

  const total = typeof count === 'number' ? count : (data || []).length;
  const filas = (data || []).map(clienteDTO);
  return {
    data: filas,
    meta: metaPaginada({ page, limit, total }, filas, inicio),
  };
}

async function createCliente(body) {
  const payload = requiredObject(body);
  const nombre = requiredString(payload.nombre, 'nombre', { max: 120 });
  const tipoDocumento = payload.tipo_documento
    ? requiredEnum(payload.tipo_documento, 'tipo_documento', ['DNI', 'RUC'])
    : null;
  const numeroDocumento = payload.numero_documento
    ? requiredString(payload.numero_documento, 'numero_documento', { max: 11 })
    : null;

  if (tipoDocumento && !numeroDocumento) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El número de documento es obligatorio.', [
      { field: 'numero_documento' },
    ]);
  }

  const cliente = {
    nombre,
    tipo_documento: tipoDocumento,
    numero_documento: numeroDocumento,
    telefono: optionalString(payload.telefono, 'telefono', { max: 20 }),
    direccion: optionalString(payload.direccion, 'direccion', { max: 200 }),
    referencia: optionalString(payload.referencia, 'referencia', { max: 150 }),
  };

  if (!db.isSupabase()) {
    if (
      tipoDocumento &&
      store.state.clientes.some(
        (item) =>
          item.tipo_documento === tipoDocumento &&
          item.numero_documento === numeroDocumento,
      )
    ) {
      throw new AppError(409, 'CONFLICT', 'Ya existe un cliente con ese documento.');
    }
    const record = {
      id: store.nextId('clientes'),
      ...cliente,
      creado_en: store.nowIso(),
      actualizado_en: store.nowIso(),
    };
    store.state.clientes.push(record);
    return record;
  }

  if (tipoDocumento) {
    const existente = await db.findOne('clientes', {
      tipo_documento: tipoDocumento,
      numero_documento: numeroDocumento,
    });
    if (existente) {
      throw new AppError(409, 'CONFLICT', 'Ya existe un cliente con ese documento.');
    }
  }

  try {
    return await repository.insert('clientes', cliente);
  } catch (error) {
    if (String(error.code) === '23505') {
      throw new AppError(409, 'CONFLICT', 'Ya existe un cliente con ese documento.');
    }
    throw db.persistenceError('No se pudo registrar el cliente.', error);
  }
}

async function validarDocumento(body) {
  const payload = requiredObject(body);
  const tipo = requiredEnum(payload.tipo_documento, 'tipo_documento', ['DNI', 'RUC']);
  const numero = requiredString(payload.numero_documento, 'numero_documento', { max: 11 });

  // Patrón Strategy: el proveedor se resuelve por DOCUMENTO_PROVIDER y, si
  // falla, se intenta DOCUMENTO_FALLBACK. Nunca bloquea la venta.
  return documentoProviders.validarDocumento({ tipo, numero });
}

module.exports = {
  listMesas,
  getMesa,
  listCuentas,
  getCuentaBasica,
  createCuenta,
  attachCliente,
  addRonda,
  listPedidos,
  getPedido,
  createPedido,
  updatePedido,
  enviarCocina,
  cancelarPedido,
  listClientes,
  createCliente,
  validarDocumento,
};
