# Backend Fratelli's — API REST (Express 5)

Implementación de la API descrita en `docs/CONTRATO_API.md` y `docs/ARQUITECTURA.md`.
Express 5 + CommonJS, sin frameworks adicionales. Incluye un **store en memoria realista**
con 10 mesas, cuentas/rondas, pedidos, KDS, insumos, movimientos, mermas, devoluciones,
gastos, activos, usuarios y configuración. El cliente de Supabase se crea solo si hay
variables de entorno; la API funciona sin base de datos para demo/pruebas.

## Arranque

```bash
npm install
cp .env.example .env      # opcional; también funciona sin .env
npm start                 # http://localhost:3000/api
npm run dev               # node --watch
npm run smoke             # arranca en un puerto libre y prueba los endpoints base (memory)
npm run smoke:supabase    # igual, pero con DB_MODE=supabase contra Supabase real
npm run verify            # reglas de negocio (memory)
```

## Persistencia (doble modo)

Los módulos core funcionan con `DB_MODE=memory` (store en memoria) o
`DB_MODE=supabase` (tablas reales vía `repository.js`):

| Módulo | memory | supabase |
|---|---|---|
| `auth` (login/me) | Sí | Sí |
| `venta-local` (mesas, cuentas, rondas, pedidos, clientes) | Sí | Sí |
| `cerrar-cuenta` (detalle, pagos, cobro, comprobante) | Sí | Sí |
| `cocina` (KDS, estados, ingredientes, métricas) | Sí | Sí |
| `inventario` (stock, alertas, ajustes, movimientos) | Sí | Sí |
| `cuadre-caja` (consulta, apertura, cierre) | Sí | Sí |
| Resto de módulos | Sí | Aún en `store.js` |

`/api/comandas` es un alias de KDS (`cocina`) y usa la rama persistida.

Con Supabase se usa `SUPABASE_SERVICE_ROLE_KEY` solo en el backend. Las
operaciones compuestas (abrir cuenta, enviar a cocina, cobrar, ajustar stock)
no son transaccionales: si un paso falla se devuelve `PERSISTENCIA_ERROR` con
detalle. El detalle completo está en `../docs/PERSISTENCIA.md`.

## Variables de entorno

| Variable | Default | Uso |
|----------|---------|-----|
| `PORT` | `3000` | Puerto HTTP |
| `NODE_ENV` | `development` | Entorno |
| `DB_MODE` | `memory` | `memory` (store) o `supabase` (tablas reales) |
| `SUPABASE_URL` | vacío | URL de Supabase (opcional) |
| `SUPABASE_KEY` | vacío | Key pública (opcional) |
| `SUPABASE_SERVICE_ROLE_KEY` | vacío | Solo backend; bypassa RLS para escrituras |
| `JWT_SECRET` | secreto demo | Firma HMAC del token (mínimo recomendado 32 bytes) |
| `TOKEN_TTL_SEC` | `1800` | Expiración del token (30 min, RNF-003) |
| `CORS_ORIGIN` | `*` | Origen(es) permitidos, separados por coma |
| `LOG_REQUESTS` | `1` | `0` desactiva el log de peticiones |

## Usuario demo

| Email | Contraseña | Roles |
|-------|------------|-------|
| `maick@fratellis.pe` | `demo123` | `Dueño/Admin` |
| `cajero@fratellis.pe` | `demo123` | `Mozo`, `Cajero` |
| `cocina@fratellis.pe` | `demo123` | `Cocinero` |
| `repartidor@fratellis.pe` | `demo123` | `Repartidor` |
| `tecnico@fratellis.pe` | `demo123` | `Admin` |

`POST /api/auth/login` acepta `{ email, password }` o `{ usuario, clave }`.
El token es HMAC-SHA256 propio (`src/lib/token.js`), con payload `{ sub, usuario, nombre, roles[], permisos[], iat, exp }`.

## Estructura

```text
backend/
├── index.js                     # delega en src/server.js
├── src/
│   ├── app.js                   # middlewares, rutas, 404, error handler
│   ├── server.js                # listen + graceful shutdown
│   ├── config/env.js
│   ├── lib/
│   │   ├── supabase.js          # cliente solo si hay env (o null)
│   │   ├── token.js             # HMAC firmar/verificar
│   │   ├── password.js          # scrypt hash/verify
│   │   └── pedidos.js           # reglas compartidas de pedidos y stock
│   ├── middleware/
│   │   ├── auth.js              # Bearer
│   │   ├── roles.js             # RBAC por permisos/roles
│   │   ├── validate.js          # helpers de validación y paginación
│   │   └── error.js             # AppError + formato JSON único
│   ├── data/store.js            # store en memoria + seed
│   └── modules/<dominio>/       # <dominio>.routes.js + <dominio>.service.js
└── scripts/smoke.js
```

## Endpoints

Todas las rutas requieren `Authorization: Bearer <token>` salvo `/api/health` y `/api/auth/login`.
Los listados devuelven `{ data, meta: { page, limit, total, pages } }`.

### Salud y autenticación

| Método | Ruta |
|--------|------|
| GET | `/api/health` |
| POST | `/api/auth/login` |
| GET | `/api/auth/me` |
| POST | `/api/auth/logout` |

### Dashboard y reportes

| Método | Ruta |
|--------|------|
| GET | `/api/dashboard?fecha=` |
| GET | `/api/reportes/:tipo` (`ventas`, `costos`, `merma`, `devoluciones`, `inventario`, `activos`, `personal`) |
| GET | `/api/reportes/:tipo/export` → `501` (pendiente) |

### Venta en local (`venta.registrar` / `caja.cobrar`)

| Método | Ruta |
|--------|------|
| GET | `/api/mesas?estado=libre\|ocupada` |
| GET | `/api/mesas/:id` |
| GET | `/api/cuentas?estado=abierta` |
| POST | `/api/cuentas` |
| POST | `/api/cuentas/:id/pedidos` |
| GET | `/api/cuentas/:id` (detalle y consolidado) |
| POST | `/api/cuentas/:id/cobrar` |
| GET | `/api/cuentas/:id/pagos` |
| GET | `/api/cuentas/:id/comprobante` |
| POST | `/api/cuentas/:id/cancelar` |
| GET | `/api/pedidos?estado=&canal=&desde=&hasta=` |
| GET | `/api/pedidos/:id` |
| POST | `/api/pedidos` |
| PATCH | `/api/pedidos/:id` |
| POST | `/api/pedidos/:id/enviar-cocina` |
| POST | `/api/pedidos/:id/cancelar` |
| GET | `/api/clientes?documento=` |
| POST | `/api/clientes` |
| POST | `/api/clientes/validar-documento` |

Alias coherentes solicitados para el frontend:
`/api/venta-local/mesas`, `/api/venta-local/cuentas`, `/api/venta-local/pedidos`, `/api/venta-local/clientes`
y `/api/cerrar-cuenta/:id`, `/api/cerrar-cuenta/:id/cobrar`, `/api/cerrar-cuenta/:id/comprobante`.

### Cocina KDS (`cocina.kds`) y comandas

| Método | Ruta |
|--------|------|
| GET | `/api/kds/pedidos?estado=pendiente\|en_preparacion\|listo` |
| PATCH | `/api/kds/pedidos/:pedidoId/platos/:detalleId/estado` |
| GET | `/api/kds/pedidos/:id/ingredientes` |
| GET | `/api/kds/metricas?desde=&hasta=` |
| GET | `/api/pedidos-listos` (`venta.registrar`) |
| GET | `/api/cocina/comandas` (alias de KDS) |
| GET | `/api/comandas` (alias REST adicional) |

### Delivery propio (`delivery.propio`)

| Método | Ruta |
|--------|------|
| GET | `/api/delivery-propio/pedidos?estado=&repartidor_id=` |
| POST | `/api/delivery-propio/pedidos` |
| PATCH | `/api/delivery-propio/pedidos/:id/repartidor` |
| PATCH | `/api/delivery-propio/pedidos/:id/estado` |
| POST | `/api/delivery-propio/pedidos/:id/entrega` |

### Delivery externo (`delivery.externo`)

| Método | Ruta |
|--------|------|
| GET | `/api/delivery-externo/pedidos?plataforma=rappi\|llamafood&estado=` |
| POST | `/api/delivery-externo/pedidos` |
| POST | `/api/delivery-externo/pedidos/:id/aceptar` |
| POST | `/api/delivery-externo/pedidos/:id/cancelar` |
| GET | `/api/delivery-externo/liquidaciones?desde=&hasta=&plataforma=` |
| POST | `/api/delivery-externo/liquidaciones` |

### Compras (`compras.gestionar`)

| Método | Ruta |
|--------|------|
| GET | `/api/compras?estado=&proveedor_id=&desde=&hasta=` |
| GET | `/api/compras/sugerencia` |
| GET | `/api/compras/:id` |
| POST | `/api/compras` |
| PATCH | `/api/compras/:id` |
| POST | `/api/compras/:id/recibir` |
| POST | `/api/compras/:id/cancelar` |
| POST | `/api/compras/:id/pagos` |
| GET | `/api/compras/:id/plantilla?canal=whatsapp\|telefono` |
| GET | `/api/proveedores?q=` |
| POST | `/api/proveedores` |

### Inventario (`inventario.gestionar`)

| Método | Ruta |
|--------|------|
| GET | `/api/inventario?estado=ok\|bajo\|critico&q=` |
| GET | `/api/inventario/alertas` |
| GET | `/api/inventario/:insumoId/movimientos?desde=&hasta=&tipo=` |
| POST | `/api/inventario/verificar` |
| POST | `/api/inventario/ajustes` |
| PATCH | `/api/inventario/:insumoId/minimo` |

### Fichas técnicas / menú (`menu.gestionar`)

| Método | Ruta |
|--------|------|
| GET | `/api/categorias-platillo` |
| GET | `/api/platillos?categoria_id=&activo=&q=` |
| GET | `/api/platillos/:id` |
| POST | `/api/platillos` |
| PATCH | `/api/platillos/:id` |
| PATCH | `/api/platillos/:id/activo` |
| GET | `/api/platillos/:id/ficha` |
| PUT | `/api/platillos/:id/ficha` |
| GET | `/api/ingredientes?categoria=&q=` |
| GET | `/api/fichas` (alias REST adicional) |

### Merma (`merma.gestionar`)

| Método | Ruta |
|--------|------|
| GET | `/api/tipos-merma` |
| GET | `/api/mermas?estado=&tipo_merma_id=&desde=&hasta=` |
| GET | `/api/mermas/:id` |
| POST | `/api/mermas` |
| POST | `/api/mermas/:id/aprobar` |
| POST | `/api/mermas/:id/rechazar` |

### Devoluciones (`devoluciones.gestionar`)

| Método | Ruta |
|--------|------|
| GET | `/api/devoluciones?estado=&desde=&hasta=` |
| GET | `/api/devoluciones/:id` |
| POST | `/api/devoluciones` |
| POST | `/api/devoluciones/:id/resolver` |
| POST | `/api/devoluciones/:id/reembolso` |

### Gastos (`gastos.registrar`)

| Método | Ruta |
|--------|------|
| GET | `/api/gastos?categoria=&desde=&hasta=` |
| GET | `/api/gastos/resumen?desde=&hasta=` |
| GET | `/api/gastos/:id` |
| POST | `/api/gastos` |
| PATCH | `/api/gastos/:id` |

### Cuadre de caja (`caja.cuadrar`)

| Método | Ruta |
|--------|------|
| GET | `/api/cuadre-caja?fecha=YYYY-MM-DD` |
| POST | `/api/cuadre-caja/apertura` |
| GET | `/api/cuadre-caja/:id` |
| POST | `/api/cuadre-caja/:id/cierre` |
| GET | `/api/cuadre-caja/:id/resumen` |
| GET | `/api/cuadre-caja/:id/pdf` → `501` (pendiente) |

### Activos (`activos.gestionar`)

| Método | Ruta |
|--------|------|
| GET | `/api/activos?categoria=&estado=&q=` |
| GET | `/api/activos/alertas?severidad=` |
| GET | `/api/activos/:id` |
| POST | `/api/activos` |
| PATCH | `/api/activos/:id` |
| GET | `/api/activos/:id/mantenimientos` |
| POST | `/api/activos/:id/mantenimientos` |
| POST | `/api/mantenimientos/:id/autorizar` |

### Configuración (`config.gestionar`)

| Método | Ruta |
|--------|------|
| GET | `/api/usuarios?q=` |
| POST | `/api/usuarios` |
| PATCH | `/api/usuarios/:id` |
| PUT | `/api/usuarios/:id/roles` |
| GET | `/api/roles` |
| GET | `/api/permisos` |
| GET | `/api/configuracion` |
| PUT | `/api/configuracion` |

## Reglas de negocio implementadas

- **Cobro al cerrar cuenta**: una cuenta por mesa agrupa 1..N rondas y se cobra una sola vez con comprobante único. Sin split ni descuentos.
- **IGV**: 18% del subtotal; **0** cuando el subtotal es menor a S/ 70 (RN-VL-010). `total = subtotal + IGV (+ delivery cuando aplica)`.
- **Stock**: solo cambia por `movimientos_inventario`. Se descuenta al **enviar a cocina**; la merma descuenta al **aprobar**; la cancelación de delivery externo **revierte** stock; la compra recibida **suma** stock.
- **KDS**: SLA 30 min; `prioritario` lo calcula el backend.
- **Comisiones**: Rappi 25%, LlamaFood 20%.
- **Cuadre**: uno por día; umbral de diferencia S/ 0; si la diferencia no es cero exige observación.
- **RBAC multi-rol**: el JWT lleva `roles[]` y `permisos[]`; el middleware autoriza por permiso (unión de roles).

### Decisiones de implementación no fijadas por el contrato

- `POST /api/pedidos/:id/cancelar` y `POST /api/cuentas/:id/cancelar` revierten stock si el pedido ya lo había descontado (el contrato lo dejaba `[POR DEFINIR]`).
- `POST /api/delivery-propio/pedidos` envía a cocina por defecto (`enviar_cocina: true`), porque el contrato no define un endpoint separado de envío para ese canal.
- `POST /api/inventario/ajustes` interpreta `cantidad` como el **nuevo stock físico** del insumo.
- Los reembolsos se guardan en una colección interna `reembolsos` y afectan el cuadre como egreso.
- `GET /api/cuadre-caja` devuelve `null` si no existe cuadre para la fecha (tal como indica el contrato).
- Endpoints adicionales no listados literalmente en el contrato: `/api/comandas`, `/api/fichas`, `/api/cuentas/:id/pagos`, `/api/cuentas/:id/comprobante` y los alias `/api/venta-local/*`, `/api/cocina/*`, `/api/cerrar-cuenta/*`.

## Errores

Formato único:

```json
{
  "error": {
    "code": "STOCK_INSUFICIENTE",
    "message": "No hay stock suficiente de Pollo entero.",
    "details": [{ "insumo_id": 1, "disponible": 0.5, "requerido": 1 }],
    "requestId": "req_..."
  }
}
```

Códigos usados: `VALIDATION_ERROR`, `UNAUTHORIZED`, `CREDENCIALES_INVALIDAS`, `FORBIDDEN`,
`NOT_FOUND`, `CONFLICT`, `STOCK_INSUFICIENTE`, `CAJA_CERRADA`, `CUENTA_ABIERTA`,
`CUENTA_YA_COBRADA`, `PEDIDO_NO_EDITABLE`, `MERMA_YA_RESUELTA`, `COMPRA_YA_RECIBIDA`,
`CUADRE_YA_EXISTE`, `BUSINESS_RULE_VIOLATION`, `INTERNAL_ERROR`, `NOT_IMPLEMENTED`.

## Pendientes

- Exportación PDF/XLSX (`501`).
- PDF del cuadre de caja (`501`).
- Rate limit del login.
- Persistencia real en Supabase: módulos core ya migrados (ver §Persistencia); el resto sigue en `store.js`.
- RPC/funciones PostgreSQL para operaciones compuestas sin estados parciales.
- Refresh token y política exacta de expiración.
- Webhooks reales de Rappi/LlamaFood y subida de archivos.
