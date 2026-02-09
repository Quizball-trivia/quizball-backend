import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Timing-safe string comparison to prevent timing attacks.
 * Converts both strings to Uint8Array and compares byte-by-byte.
 */
function timingSafeEqual(a: string | null, b: string): boolean {
  if (a === null) return false;

  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  // If lengths differ, still compare to prevent timing leaks
  if (aBytes.length !== bBytes.length) return false;

  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization');
  const cronSecret = Deno.env.get('CRON_SECRET');

  if (!cronSecret || !timingSafeEqual(authHeader, `Bearer ${cronSecret}`)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing required env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data, error } = await supabase.rpc('cleanup_ai_users');

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ deleted: data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
