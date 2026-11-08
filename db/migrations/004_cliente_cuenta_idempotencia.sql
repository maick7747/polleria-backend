ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS cliente_id INTEGER REFERENCES clientes(id);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pedidos_idempotency_key
  ON pedidos (idempotency_key) WHERE idempotency_key IS NOT NULL;
