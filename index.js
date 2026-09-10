const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Credenciales de Supabase (variables de entorno para producción)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mcfkcqwvlztyexqixfhk.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Tn-ja9VLPY4FotqccphVew_e-Vs1eUP';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.get('/api/mensaje', async (req, res) => {
  const { data, error } = await supabase.from('mensajes').select('texto').limit(1);

  if (error) {
    console.error('Error de Supabase:', error);
    return res.status(500).json({ respuesta: 'Error al consultar la base de datos' });
  }

  res.json({ respuesta: data[0]?.texto || 'No hay registros' });
});

app.listen(PORT, () => {
  console.log(`Servidor backend corriendo en http://localhost:${PORT}`);
});