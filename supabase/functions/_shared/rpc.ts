// Shared by the server function adapters. Supabase does not deploy a folder whose name starts
// with "_" as a function; scripts/build-server-function.cjs bundles this file into each function.
// No imports here: staff-accounts uses check() and must not load the storage SDK.

export const check = (result: any) => {
  if (result.error) throw result.error;
  return result.data;
};

// Service-role RPCs that take the verified actor: (actor, action, input).
export const actorRpc =
  (admin: any, name: string, sessionParam = 'p_session') =>
  async (actor: any, action: string, input: any = {}) =>
    check(
      await admin.rpc(name, {
        p_owner: actor.ownerId,
        p_workspace: actor.workspaceId,
        p_actor: actor.id,
        [sessionParam]: actor.authSessionId,
        p_action: action,
        p_input: input,
      }),
    );

// Retired-file cleanup jobs (src/server/privacy-assets.mjs).
export function privacyJobs(admin: any) {
  const rpc = actorRpc(admin, 'demo_desktop_privacy_assets');
  return {
    claimPrivacyJobs: (actor: any) => rpc(actor, 'claim', { limit: 100 }),
    finishPrivacyJob: (actor: any, input: any) => rpc(actor, 'finish', input),
  };
}
