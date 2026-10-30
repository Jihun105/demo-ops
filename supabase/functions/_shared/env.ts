// The Supabase address the server functions call. On a development Mac the local tools share
// one Docker network, where the gateway's short name ("kong") can belong to another local
// project; npm run dev:live therefore sets its own gateway in DEMO_SUPABASE_INTERNAL_URL.
// Production leaves it unset and uses SUPABASE_URL. No imports here (used by every function).
export const supabaseUrl = () =>
  Deno.env.get('DEMO_SUPABASE_INTERNAL_URL') || Deno.env.get('SUPABASE_URL')!;
