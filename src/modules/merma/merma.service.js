'use strict';

const store = require('../../data/store');
const repository = require('../../data/repository');
const db = require('../../data/db');
const { AppError } = require('../../middleware/error');
const {
  requiredObject,
  requiredString,
  requiredInt,
  requiredNumber,
  requiredEnum,
  optionalString,
  optionalDate,
  paginate,
  pageParams,
  parseId,
  parseSort,
} = require('../../middleware/validate');

const CLASIFICACIONES = ['evitable', 'inevitable'];
const ORIGENES = ['registro_manual', 'devolucion', 'cancelacion'];
const ESTADOS = ['pendiente', 'aprobada', 'rechazada'];
const CAMPOS_ORDEN = ['id', 'fecha', 'cantidad', 'estado'];

function aNumero(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function valorOrden(fila, campo) {
  if (campo === 'id' || campo === 'cantidad') {
    return aNumero(fila[campo]);
  }
  const valor = fila[campo];
  return valor === null || valor === undefined ? '' : String(valor);
}

function ordenar(filas, campo, ascending) {
  const direccion = ascending ? 1 : -1;
  return [...filas].sort((izq, der) => {
    const a = valorOrden(izq, campo);
    const b = valorOrden(der, campo);
    if (a < b) return -1 * direccion;
    if (a > b) return 1 * direccion;
    return aNumero(der.id) - aNumero(izq.id);
  });
}

function mermaDTO(merma, refs = {}) {
  return {
    ...merma,
    cantidad: aNumero(merma.cantidad),
    costo_estimado: db.round2(aNumero(merma.costo_estimado)),
    tipo_merma: refs.tipo === undefined ? null : refs.tipo,
    insumo: refs.insumo === undefined ? null : refs.insumo,
    platillo: refs.platillo === undefined ? null : refs.platillo,
    registrado_por: refs.registrado_por === undefined ? null : refs.registrado_por,
  };
}

function enriquecerMerma(merma) {
  const tipo = store.find('tipos_merma', merma.tipo_merma_id);
  const insumo = merma.insumo_id ? store.find('insumos', merma.insumo_id) : null;
  const platillo = merma.platillo_id ? store.find('platillos', merma.platillo_id) : null;
  const usuario = store.find('usuarios', merma.usuario_registro_id);
  return mermaDTO(merma, {
    tipo: tipo ? tipo.nombre : null,
    insumo: insumo ? insumo.nombre : null,
    platillo: platillo ? platillo.nombre : null,
    registrado_por: usuario ? usuario.nombre : null,
  });
}

async function porIds(tabla, ids, select = 'id, nombre') {
  const limpios = [...new Set(ids.map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  if (limpios.length === 0) {
    return new Map();
  }
  const { data } = await repository.list(tabla, {
    select,
    filters: { id: limpios },
    limit: 1000,
  });
  return new Map((data || []).map((fila) => [fila.id, fila.nombre]));
}

// Una consulta por catálogo (4 en total) en lugar de N+1: se recolectan los ids
// de la página y se resuelven en lote. Se evita el embedding de PostgREST para
// no depender de los nombres de FK (usuarios tiene dos referencias en mermas).
async function enriquecerMermasSupabase(filas) {
  const [tipos, insumos, platillos, usuarios] = await Promise.all([
    porIds('tipos_merma', filas.map((fila) => fila.tipo_merma_id)),
    porIds('insumos', filas.map((fila) => fila.insumo_id)),
    porIds('platillos', filas.map((fila) => fila.platillo_id)),
    porIds('usuarios', filas.map((fila) => fila.usuario_registro_id)),
  ]);

  return filas.map((fila) =>
    mermaDTO(fila, {
      tipo: tipos.get(fila.tipo_merma_id) || null,
      insumo: fila.insumo_id ? insumos.get(fila.insumo_id) || null : null,
      platillo: fila.platillo_id ? platillos.get(fila.platillo_id) || null : null,
      registrado_por: usuarios.get(fila.usuario_registro_id) || null,
    }),
  );
}

function costoEstimado({ insumo_id, platillo_id, cantidad }) {
  if (insumo_id) {
    const insumo = store.findOrThrow('insumos', insumo_id, 'Insumo');
    return store.round2(insumo.costo_promedio * cantidad);
  }

  const ficha = store.state.fichas_tecnicas.find(
    (item) => item.platillo_id === Number(platillo_id) && item.activa,
  );
  if (!ficha) {
    return 0;
  }
  const porciones = ficha.porciones_rendimiento || 1;
  return store.round2((ficha.costo_total / porciones) * cantidad);
}

async function costoEstimadoSupabase({ insumo_id, platillo_id, cantidad }) {
  if (insumo_id) {
    const insumo = await db.findOrThrow('insumos', insumo_id, 'Insumo');
    return db.round2(Number(insumo.costo_promedio) * cantidad);
  }

  const { data } = await repository.list('fichas_tecnicas', {
    filters: { platillo_id: Number(platillo_id), activa: true },
    orderBy: 'id',
    ascending: true,
    limit: 1,
  });
  const ficha = data && data[0];
  if (!ficha) {
    return 0;
  }
  const porciones = Number(ficha.porciones_rendimiento) || 1;
  return db.round2((Number(ficha.costo_total) / porciones) * cantidad);
}

async function listTipos() {
  if (!db.isSupabase()) {
    return { data: store.state.tipos_merma, meta: { total: store.state.tipos_merma.length } };
  }
  const { data } = await repository.list('tipos_merma', {
    orderBy: 'id',
    ascending: true,
    limit: 1000,
  });
  const filas = data || [];
  return { data: filas, meta: { total: filas.length } };
}

function filtrosMerma(query = {}) {
  const estado = query.estado ? requiredEnum(query.estado, 'estado', ESTADOS) : null;
  const tipoId = query.tipo_merma_id ? parseId(query.tipo_merma_id, 'tipo_merma_id') : null;
  const desde = optionalDate(query.desde, 'desde');
  const hasta = optionalDate(query.hasta, 'hasta');
  const { campo, ascending } = parseSort(query.sort, CAMPOS_ORDEN, 'id:desc', 'sort');
  return { estado, tipoId, desde, hasta, sort: campo, ascending };
}

function listMermasMemoria(filtros, query) {
  const filtradas = store.state.mermas
    .filter((merma) => !filtros.estado || merma.estado === filtros.estado)
    .filter((merma) => !filtros.tipoId || merma.tipo_merma_id === filtros.tipoId)
    .filter((merma) => !filtros.desde || merma.fecha >= filtros.desde)
    .filter((merma) => !filtros.hasta || merma.fecha <= filtros.hasta);

  const ordenadas = ordenar(filtradas, filtros.sort, filtros.ascending);
  return paginate(ordenadas.map(enriquecerMerma), query);
}

async function listMermasSupabase(filtros, query) {
  const { page, limit } = pageParams(query);

  let consulta = repository.table('mermas').select('*', { count: 'exact' });
  if (filtros.estado) {
    consulta = consulta.eq('estado', filtros.estado);
  }
  if (filtros.tipoId) {
    consulta = consulta.eq('tipo_merma_id', filtros.tipoId);
  }
  if (filtros.desde) {
    consulta = consulta.gte('fecha', filtros.desde);
  }
  if (filtros.hasta) {
    consulta = consulta.lte('fecha', filtros.hasta);
  }
  consulta = consulta
    .order(filtros.sort, { ascending: filtros.ascending })
    .order('id', { ascending: false });

  const inicio = (page - 1) * limit;
  const { data, error, count } = await consulta.range(inicio, inicio + limit - 1);
  if (error) {
    throw db.persistenceError('No se pudieron listar las mermas.', error);
  }

  const filas = data || [];
  const total = typeof count === 'number' ? count : filas.length;
  return {
    data: await enriquecerMermasSupabase(filas),
    meta: { page, limit, total, pages: total === 0 ? 0 : Math.ceil(total / limit) },
  };
}

async function listMermas(query = {}) {
  const filtros = filtrosMerma(query);
  if (db.isSupabase()) {
    return listMermasSupabase(filtros, query);
  }
  return listMermasMemoria(filtros, query);
}

async function getMerma(id) {
  const merma = await db.findOrThrow('mermas', parseId(id), 'Merma');
  if (!db.isSupabase()) {
    return enriquecerMerma(merma);
  }
  const [dto] = await enriquecerMermasSupabase([merma]);
  return dto;
}

async function validarSujeto(payload) {
  const tipoId = requiredInt(payload.tipo_merma_id, 'tipo_merma_id', { min: 1 });
  if (!db.isSupabase()) {
    store.findOrThrow('tipos_merma', tipoId, 'Tipo de merma');
  } else {
    await db.findOrThrow('tipos_merma', tipoId, 'Tipo de merma');
  }

  const insumoId = payload.insumo_id ? requiredInt(payload.insumo_id, 'insumo_id', { min: 1 }) : null;
  const platilloId = payload.platillo_id
    ? requiredInt(payload.platillo_id, 'platillo_id', { min: 1 })
    : null;

  if (!insumoId && !platilloId) {
    throw new AppError(400, 'VALIDATION_ERROR', 'La merma requiere insumo_id o platillo_id.', [
      { field: 'insumo_id' },
    ]);
  }
  if (insumoId) {
    if (db.isSupabase()) {
      await db.findOrThrow('insumos', insumoId, 'Insumo');
    } else {
      store.findOrThrow('insumos', insumoId, 'Insumo');
    }
  }
  if (platilloId) {
    if (db.isSupabase()) {
      await db.findOrThrow('platillos', platilloId, 'Platillo');
    } else {
      store.findOrThrow('platillos', platilloId, 'Platillo');
    }
  }

  return { tipoId, insumoId, platilloId };
}

async function crearMerma(body, usuario) {
  const payload = requiredObject(body);
  const { tipoId, insumoId, platilloId } = await validarSujeto(payload);
  const cantidad = requiredNumber(payload.cantidad, 'cantidad', { min: 0.001 });

  const base = {
    tipo_merma_id: tipoId,
    insumo_id: insumoId,
    platillo_id: platilloId,
    cantidad: db.round3(cantidad),
    clasificacion: requiredEnum(payload.clasificacion, 'clasificacion', CLASIFICACIONES),
    causa_raiz: optionalString(payload.causa_raiz, 'causa_raiz', { max: 200 }),
    motivo: requiredString(payload.motivo, 'motivo', { max: 300 }),
    fecha: optionalDate(payload.fecha, 'fecha') || db.today(),
    estado: 'pendiente',
    usuario_registro_id: usuario.id,
    usuario_aprueba_id: null,
    fecha_resolucion: null,
    observacion_resolucion: null,
    origen: payload.origen
      ? requiredEnum(payload.origen, 'origen', ORIGENES)
      : 'registro_manual',
  };

  if (!db.isSupabase()) {
    const merma = {
      id: store.nextId('mermas'),
      ...base,
      costo_estimado: costoEstimado({ insumo_id: insumoId, platillo_id: platilloId, cantidad }),
      creado_en: store.nowIso(),
    };
    store.state.mermas.push(merma);
    return enriquecerMerma(merma);
  }

  const costo = await costoEstimadoSupabase({
    insumo_id: insumoId,
    platillo_id: platilloId,
    cantidad: base.cantidad,
  });

  let creada;
  try {
    creada = await repository.insert('mermas', { ...base, costo_estimado: costo });
  } catch (error) {
    throw db.persistenceError('No se pudo registrar la merma.', error);
  }

  const [dto] = await enriquecerMermasSupabase([creada]);
  return dto;
}

async function aprobarMermaSupabase(merma, payload, usuario) {
  const movs = [];

  if (merma.insumo_id) {
    movs.push({
      insumo_id: merma.insumo_id,
      tipo: 'merma',
      cantidad: aNumero(merma.cantidad),
      referencia_tipo: 'merma',
      referencia_id: merma.id,
      usuario_id: usuario.id,
      observacion: `Merma aprobada: ${merma.motivo}`,
    });
  } else {
    const { data: fichas } = await repository.list('fichas_tecnicas', {
      filters: { platillo_id: Number(merma.platillo_id), activa: true },
      orderBy: 'id',
      ascending: true,
      limit: 1,
    });
    const ficha = fichas && fichas[0];
    if (!ficha) {
      throw new AppError(
        422,
        'BUSINESS_RULE_VIOLATION',
        'El platillo no tiene ficha técnica para descontar stock.',
      );
    }

    const { data: detalles } = await repository.list('fichas_tecnicas_detalle', {
      filters: { ficha_id: ficha.id },
      orderBy: 'id',
      ascending: true,
      limit: 1000,
    });
    const porciones = Number(ficha.porciones_rendimiento) || 1;
    const cantidadMerma = aNumero(merma.cantidad);
    const requerimientos = (detalles || []).map((detalle) => ({
      insumo_id: detalle.insumo_id,
      cantidad: db.round3((Number(detalle.cantidad) / porciones) * cantidadMerma),
    }));

    const insumoIds = [...new Set(requerimientos.map((item) => item.insumo_id))];
    const { data: insumos } = insumoIds.length
      ? await repository.list('insumos', {
        select: 'id, nombre, stock_actual',
        filters: { id: insumoIds },
        limit: 1000,
      })
      : { data: [] };
    const stock = new Map((insumos || []).map((insumo) => [insumo.id, insumo]));

    for (const requerimiento of requerimientos) {
      const insumo = stock.get(requerimiento.insumo_id);
      if (!insumo) {
        throw new AppError(404, 'NOT_FOUND', `Insumo con id ${requerimiento.insumo_id} no existe.`);
      }
      if (Number(insumo.stock_actual) + 0.0005 < requerimiento.cantidad) {
        throw new AppError(
          409,
          'STOCK_INSUFICIENTE',
          `No hay stock suficiente de ${insumo.nombre}.`,
          [
            {
              insumo_id: insumo.id,
              disponible: Number(insumo.stock_actual),
              requerido: requerimiento.cantidad,
            },
          ],
        );
      }
    }

    for (const requerimiento of requerimientos) {
      movs.push({
        insumo_id: requerimiento.insumo_id,
        tipo: 'merma',
        cantidad: requerimiento.cantidad,
        referencia_tipo: 'merma',
        referencia_id: merma.id,
        usuario_id: usuario.id,
        observacion: `Merma de platillo: ${merma.motivo}`,
      });
    }
  }

  await db.applyMovements(movs);

  const ahora = db.nowIso();
  const patch = {
    estado: 'aprobada',
    usuario_aprueba_id: usuario.id,
    fecha_resolucion: ahora,
    observacion_resolucion: optionalString(payload.observacion, 'observacion', { max: 300 }),
  };

  let actualizada;
  try {
    actualizada = await repository.update('mermas', merma.id, patch);
  } catch (error) {
    // Compensación: el movimiento ya descontó stock; se devuelve con entradas
    // inversas y se informa el fallo (no hay transacción entre ambas escrituras).
    const compensaciones = movs.map((mov) => ({
      insumo_id: mov.insumo_id,
      tipo: 'entrada',
      cantidad: mov.cantidad,
      referencia_tipo: 'merma',
      referencia_id: mov.referencia_id,
      usuario_id: mov.usuario_id,
      observacion: `Compensación por fallo al aprobar la merma #${merma.id}`,
    }));
    try {
      await db.applyMovements(compensaciones);
    } catch (compensacionError) {
      // Si la compensación falla, se deja constancia en el error de persistencia.
      error.compensacion = compensacionError.message;
    }
    throw db.persistenceError('No se pudo aprobar la merma; se revirtió el stock.', error);
  }

  const [dto] = await enriquecerMermasSupabase([actualizada || { ...merma, ...patch }]);
  return { ...dto, movimientos_inventario: movs.length };
}

async function aprobarMerma(id, body, usuario) {
  const merma = await db.findOrThrow('mermas', parseId(id), 'Merma');
  const payload = body && typeof body === 'object' ? body : {};

  if (merma.estado !== 'pendiente') {
    throw new AppError(409, 'MERMA_YA_RESUELTA', 'La merma ya fue aprobada o rechazada.');
  }

  if (db.isSupabase()) {
    return aprobarMermaSupabase(merma, payload, usuario);
  }

  const movimientos = [];

  if (merma.insumo_id) {
    movimientos.push(
      store.applyMovement({
        insumo_id: merma.insumo_id,
        tipo: 'merma',
        cantidad: merma.cantidad,
        referencia_tipo: 'merma',
        referencia_id: merma.id,
        usuario_id: usuario.id,
        observacion: `Merma aprobada: ${merma.motivo}`,
      }),
    );
  } else {
    const ficha = store.state.fichas_tecnicas.find(
      (item) => item.platillo_id === merma.platillo_id && item.activa,
    );
    if (!ficha) {
      throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'El platillo no tiene ficha técnica para descontar stock.');
    }

    const porciones = ficha.porciones_rendimiento || 1;
    const requerimientos = store.state.fichas_tecnicas_detalle
      .filter((item) => item.ficha_id === ficha.id)
      .map((item) => ({
        insumo_id: item.insumo_id,
        cantidad: store.round3((item.cantidad / porciones) * merma.cantidad),
      }));

    for (const requerimiento of requerimientos) {
      const insumo = store.findOrThrow('insumos', requerimiento.insumo_id, 'Insumo');
      if (insumo.stock_actual + 0.0005 < requerimiento.cantidad) {
        throw new AppError(409, 'STOCK_INSUFICIENTE', `No hay stock suficiente de ${insumo.nombre}.`, [
          {
            insumo_id: insumo.id,
            disponible: insumo.stock_actual,
            requerido: requerimiento.cantidad,
          },
        ]);
      }
    }

    for (const requerimiento of requerimientos) {
      movimientos.push(
        store.applyMovement({
          insumo_id: requerimiento.insumo_id,
          tipo: 'merma',
          cantidad: requerimiento.cantidad,
          referencia_tipo: 'merma',
          referencia_id: merma.id,
          usuario_id: usuario.id,
          observacion: `Merma de platillo: ${merma.motivo}`,
        }),
      );
    }
  }

  const ahora = store.nowIso();
  merma.estado = 'aprobada';
  merma.usuario_aprueba_id = usuario.id;
  merma.fecha_resolucion = ahora;
  merma.observacion_resolucion = optionalString(payload.observacion, 'observacion', { max: 300 });

  return {
    ...enriquecerMerma(merma),
    movimientos_inventario: movimientos.length,
  };
}

async function rechazarMerma(id, body, usuario) {
  const merma = await db.findOrThrow('mermas', parseId(id), 'Merma');
  const payload = requiredObject(body || {});

  if (merma.estado !== 'pendiente') {
    throw new AppError(409, 'MERMA_YA_RESUELTA', 'La merma ya fue aprobada o rechazada.');
  }

  const patch = {
    estado: 'rechazada',
    usuario_aprueba_id: usuario.id,
    fecha_resolucion: db.nowIso(),
    observacion_resolucion: optionalString(payload.observacion, 'observacion', { max: 300 }),
  };

  if (!db.isSupabase()) {
    Object.assign(merma, patch);
    return enriquecerMerma(merma);
  }

  let actualizada;
  try {
    actualizada = await repository.update('mermas', merma.id, patch);
  } catch (error) {
    throw db.persistenceError('No se pudo rechazar la merma.', error);
  }

  const [dto] = await enriquecerMermasSupabase([actualizada || { ...merma, ...patch }]);
  return dto;
}

module.exports = {
  CLASIFICACIONES,
  ORIGENES,
  enriquecerMerma,
  listTipos,
  listMermas,
  getMerma,
  crearMerma,
  aprobarMerma,
  rechazarMerma,
};
