-- =====================================================================
-- 019_imagenes.sql
-- Imagen por entidad (platillos, activos, insumos y proveedores) y
-- persistencia de los datos de activos que el formulario ya enviaba.
--
-- Cambios:
--   1. `platillos.imagen_url` pasa de VARCHAR(255) a VARCHAR(500) para
--      admitir las URLs públicas de Supabase Storage.
--   2. `activos` gana `imagen_url`, `proveedor`, `garantia_meses` y
--      `observaciones` (el frontend ya los enviaba, pero se descartaban).
--   3. `insumos` y `proveedores` ganan `imagen_url`.
--   4. Bucket público `fratelli-imagenes` + política de lectura pública.
--      La subida la hace solo el backend con la service_role; el límite de
--      2 MB y los MIME (jpeg/png/webp) se validan en la API.
--
-- Idempotente y no destructivo: solo ALTER ... ADD COLUMN IF NOT EXISTS,
-- un ALTER TYPE que amplía y CREATE POLICY precedido de DROP IF EXISTS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Platillos: ampliar la URL de imagen (255 -> 500)
-- ---------------------------------------------------------------------
ALTER TABLE platillos ALTER COLUMN imagen_url TYPE VARCHAR(500);

COMMENT ON COLUMN platillos.imagen_url IS
  'URL pública de la imagen del platillo (bucket fratelli-imagenes o URL externa).';

-- ---------------------------------------------------------------------
-- 2. Activos: imagen y datos de compra/garantía
-- ---------------------------------------------------------------------
ALTER TABLE activos ADD COLUMN IF NOT EXISTS imagen_url VARCHAR(500);
ALTER TABLE activos ADD COLUMN IF NOT EXISTS proveedor VARCHAR(150);
ALTER TABLE activos ADD COLUMN IF NOT EXISTS garantia_meses INTEGER
  CHECK (garantia_meses IS NULL OR garantia_meses >= 0);
ALTER TABLE activos ADD COLUMN IF NOT EXISTS observaciones VARCHAR(300);

COMMENT ON COLUMN activos.imagen_url IS
  'URL pública de la imagen del activo (bucket fratelli-imagenes o URL externa).';
COMMENT ON COLUMN activos.proveedor IS
  'Proveedor con el que se adquirió el activo (texto libre, no FK).';
COMMENT ON COLUMN activos.garantia_meses IS
  'Meses de garantía del activo; NULL si no aplica o no se registró.';
COMMENT ON COLUMN activos.observaciones IS
  'Notas libres del activo (estado, accesorios, ubicación, etc.).';

-- ---------------------------------------------------------------------
-- 3. Insumos y proveedores: imagen
-- ---------------------------------------------------------------------
ALTER TABLE insumos ADD COLUMN IF NOT EXISTS imagen_url VARCHAR(500);
ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS imagen_url VARCHAR(500);

COMMENT ON COLUMN insumos.imagen_url IS
  'URL pública de la imagen del insumo (bucket fratelli-imagenes o URL externa).';
COMMENT ON COLUMN proveedores.imagen_url IS
  'URL pública de la imagen/logo del proveedor (bucket fratelli-imagenes o URL externa).';

-- ---------------------------------------------------------------------
-- 4. Storage: bucket público de imágenes
-- ---------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('fratelli-imagenes', 'fratelli-imagenes', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Lectura pública de los objetos del bucket. Las escrituras siguen
-- reservadas a la service_role (el backend), porque no se crea política
-- de INSERT/UPDATE/DELETE para anon/authenticated.
DROP POLICY IF EXISTS "fratelli_imagenes_public_read" ON storage.objects;
CREATE POLICY "fratelli_imagenes_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'fratelli-imagenes');
