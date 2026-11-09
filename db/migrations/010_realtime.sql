-- 010_realtime.sql
-- Publica las tablas que alimentan el aviso KDS -> mozo en Supabase Realtime.
--
-- Idempotente: se puede aplicar varias veces sin error. Si la publicación
-- `supabase_realtime` ya existe (Supabase la crea en cada proyecto) solo se
-- agregan las tablas que falten.
--
-- Aplicar en Supabase -> SQL Editor, o con `npm run db:apply` si hay
-- DATABASE_URL. No crea políticas RLS ni GRANTs: las políticas de 002_rbac_rls
-- siguen mandando y, con la clave publicable (rol `anon`), Realtime no
-- entregará filas. En ese caso el frontend sigue con el polling de 15 s.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'pedidos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.pedidos;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'pedido_detalles'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.pedido_detalles;
  END IF;
END
$$;

-- Verificación (debe listar pedidos y pedido_detalles):
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
ORDER BY schemaname, tablename;
