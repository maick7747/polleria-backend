-- ---------------------------------------------------------------------
-- 015 — Correo del cliente
--
-- El formulario de cliente (al cerrar la cuenta) captura correo, pero la
-- tabla no lo tenía: se guardaba y se descartaba en silencio.
-- ---------------------------------------------------------------------

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS correo VARCHAR(120);
