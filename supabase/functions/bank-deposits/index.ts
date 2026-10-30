import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { bankDepositHandler } from '../../../src/server/bank-deposits-handler.mjs';
import { supabaseUrl } from '../_shared/env.ts';

Deno.serve((request: Request) => {
  const url = supabaseUrl(),
    key = Deno.env.get('SUPABASE_ANON_KEY')!;
  let admin: ReturnType<typeof createClient>;
  const rpc = async (name: string, args: Record<string, unknown>) => {
    admin ||= createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const result = await admin.rpc(name, args);
    if (result.error) throw Error('입금 처리 서버 설정을 확인해주세요.');
    return result.data;
  };
  return bankDepositHandler(request, {
    device: (hash: string) => rpc('demo_bank_device', { p_hash: hash }),
    async authorize(authorization: string, workspaceId: string) {
      const caller = createClient(url, key, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const user = await caller.auth.getUser();
      if (user.error || !user.data.user) return null;
      const access = await caller.rpc('demo_desktop_privacy_access', { p_workspace: workspaceId });
      return { userId: user.data.user.id, access: access.error ? null : access.data };
    },
    repository: {
      context: (s: any, id: string, fingerprint: string) =>
        rpc('demo_bank_context', {
          p_owner: s.ownerId,
          p_workspace: s.workspaceId,
          p_id: id,
          p_fingerprint: fingerprint,
        }),
      commit: (s: any, d: any, head: number, decision: any, manual: boolean) =>
        rpc('demo_bank_commit', {
          p_owner: s.ownerId,
          p_workspace: s.workspaceId,
          p_actor: s.actorId,
          p_hash: s.deviceHash,
          p_receipt: d,
          p_head: head,
          p_status: decision.status,
          p_claim: decision.claimId,
          p_reason: decision.reason,
          p_manual: manual,
        }),
    },
  });
});
