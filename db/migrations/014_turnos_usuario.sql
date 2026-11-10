-- 014_turnos_usuario.sql
-- Turnos del personal: un usuario puede cubrir varios turnos (mañana/tarde/noche).
-- Idempotente: se puede re-ejecutar sin efectos secundarios.

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS turnos text[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usuarios_turnos_check'
  ) THEN
    ALTER TABLE usuarios
      ADD CONSTRAINT usuarios_turnos_check
      CHECK (turnos <@ ARRAY['mañana', 'tarde', 'noche']::text[]);
  END IF;
END
$$;

-- Backfill de los usuarios demo (solo si aún no tienen turnos asignados).
UPDATE usuarios SET turnos = ARRAY['mañana', 'tarde', 'noche']
WHERE email = 'maick@fratellis.pe' AND turnos = '{}';
UPDATE usuarios SET turnos = ARRAY['mañana', 'tarde']
WHERE email = 'cajero@fratellis.pe' AND turnos = '{}';
UPDATE usuarios SET turnos = ARRAY['tarde', 'noche']
WHERE email = 'cocina@fratellis.pe' AND turnos = '{}';
UPDATE usuarios SET turnos = ARRAY['tarde', 'noche']
WHERE email = 'repartidor@fratellis.pe' AND turnos = '{}';
UPDATE usuarios SET turnos = ARRAY['mañana', 'tarde']
WHERE email = 'tecnico@fratellis.pe' AND turnos = '{}';
