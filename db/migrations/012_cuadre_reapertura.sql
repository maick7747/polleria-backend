-- 012_cuadre_reapertura.sql
-- Permite reabrir el cuadre de caja del día (o el de ayer si el cierre pasó
-- la medianoche) cuando `cuadres_caja.fecha` es UNIQUE y ya existe la fila.
--
-- Se conserva la fila: no se borra ni se crea otra. La reapertura solo cambia
-- el estado a 'abierta' y deja traza de quién reabrió, cuándo y por qué.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS.

ALTER TABLE public.cuadres_caja
  ADD COLUMN IF NOT EXISTS reabierto_en TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS usuario_reabre_id INTEGER REFERENCES public.usuarios(id),
  ADD COLUMN IF NOT EXISTS motivo_reapertura VARCHAR(300);

-- Verificación: deben aparecer las 3 columnas nuevas.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'cuadres_caja'
  AND column_name IN ('reabierto_en', 'usuario_reabre_id', 'motivo_reapertura')
ORDER BY column_name;
