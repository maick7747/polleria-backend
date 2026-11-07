'use strict';

const { createClient } = require('@supabase/supabase-js');
const env = require('../config/env');

let client = null;

if (env.supabaseUrl && env.supabaseKey) {
  client = createClient(env.supabaseUrl, env.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

module.exports = client;
