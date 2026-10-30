import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { workRoutingHandler } from '../../../src/server/work-routing-handler.mjs';
import routing from '../../../src/shared/kakao-directions.cjs';
import { supabaseUrl } from '../_shared/env.ts';

Deno.serve((request: Request) =>
  workRoutingHandler(request, {
    async authorize(authorization: string, workspaceId: string) {
      const caller = createClient(supabaseUrl(), Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const user = await caller.auth.getUser();
      if (user.error || !user.data.user) return null;
      const access = await caller.rpc('demo_access', { p_workspace: workspaceId });
      if (access.error?.code === 'P0001') return { userId: user.data.user.id, access: null };
      if (access.error)
        throw Object.assign(Error('Company access lookup failed'), {
          code: ['42P01', '42883', 'PGRST202', 'PGRST205'].includes(access.error.code)
            ? 'routing-config'
            : 'routing-unavailable',
        });
      return { userId: user.data.user.id, access: access.data };
    },
    directions(
      from: { lat: number; lng: number },
      to: { lat: number; lng: number },
      options: { signal: AbortSignal },
    ) {
      return routing
        .createKakaoRoute({ key: Deno.env.get('KAKAO_MOBILITY_REST_API_KEY') })
        .directions(from, to, options);
    },
  }),
);
