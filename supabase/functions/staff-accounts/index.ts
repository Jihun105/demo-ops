import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { accountHandler } from '../../../src/server/staff-accounts-handler.mjs';
import { check } from '../_shared/rpc.ts';
import { supabaseUrl } from '../_shared/env.ts';

// Service key is available only in the Edge Function environment, never in the apps.
const url = supabaseUrl();
const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
Deno.serve((request: Request) => {
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return accountHandler(request, {
    async authorize(authorization: string, workspace: string) {
      if (!authorization?.startsWith('Bearer ')) throw Error('Missing token');
      const user = check(await admin.auth.getUser(authorization.slice(7))).user;
      const caller = createClient(url, anon, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const access = check(await caller.rpc('demo_access', { p_workspace: workspace }));
      return { ...access, id: user.id };
    },
    async list(owner: string, workspace: string) {
      return check(
        await admin
          .from('demo_members')
          .select('user_id,login_id,display_name,role,active')
          .eq('owner_id', owner)
          .eq('workspace_id', workspace)
          .order('created_at'),
      );
    },
    async createUser(email: string, password: string) {
      return check(await admin.auth.admin.createUser({ email, password, email_confirm: true })).user
        .id;
    },
    async deleteUser(id: string) {
      check(await admin.auth.admin.deleteUser(id));
    },
    async addMember(row: object) {
      check(await admin.from('demo_members').insert(row));
    },
    async updateMember(owner: string, workspace: string, id: string, patch: object) {
      const rows = check(
        await admin
          .from('demo_members')
          .update(patch)
          .eq('owner_id', owner)
          .eq('workspace_id', workspace)
          .eq('user_id', id)
          .select('user_id'),
      );
      return rows.length === 1;
    },
  });
});
