// Supabase and R2 clients of the earth-assets and work-reports functions (see rpc.ts).
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { S3Client, DeleteObjectCommand } from 'npm:@aws-sdk/client-s3@3.922.0';
import { supabaseUrl } from './env.ts';

// caller acts as the signed-in user (its own RLS); admin uses the service role.
export function clients(request: Request) {
  const url = supabaseUrl();
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: request.headers.get('Authorization') || '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { caller, admin };
}

// The private R2 bucket. R2_ENDPOINT / R2_PUBLIC_ENDPOINT are set only by the development
// screen (npm run dev:live, scripts/dev-live/storage.cjs): there the functions reach the
// stand-in storage by one address and the PC app by another. Production leaves both unset.
export function r2() {
  const bucket = Deno.env.get('R2_BUCKET') || '';
  const local = Deno.env.get('R2_ENDPOINT');
  const client = (endpoint: string) =>
    new S3Client({
      region: 'auto',
      endpoint,
      ...(local ? { forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID') || '',
        secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY') || '',
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  const storage = client(
    local || `https://${Deno.env.get('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
  );
  // Links handed to the app (upload/download URLs) must use the address the app can reach.
  const publicEndpoint = local && Deno.env.get('R2_PUBLIC_ENDPOINT');
  const signer = publicEndpoint ? client(publicEndpoint) : storage;
  async function removeObject(key: string) {
    await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(5000),
    });
  }
  return { bucket, storage, signer, removeObject };
}
