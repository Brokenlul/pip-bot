import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getConfig, memoryEnabled, supabaseAdminKey } from '../config.js';

let client: SupabaseClient | null = null;

export function getDb(): SupabaseClient | null {
  if (!memoryEnabled()) return null;
  if (client) return client;
  const cfg = getConfig();
  client = createClient(cfg.SUPABASE_URL!, supabaseAdminKey(cfg)!, {
    auth: { persistSession: false },
  });
  return client;
}
