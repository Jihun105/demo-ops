'use strict';
const { validateConfig } = require('../backend/index.cjs');
const {
  validateAccess,
  isDesktopRole,
  isDesktopLoginRole,
  isPreviewRole,
  loginEmail,
  can,
} = require('../shared/access.cjs');
const { uuid } = require('../shared/field-model.cjs');
const { randomUUID } = require('node:crypto');
function desktopAuth(createBackend) {
  let client = null,
    access = null,
    settings = null,
    pending = false,
    actorId = null,
    liveSessionId = null,
    generation = 0;
  function requireOwner() {
    if (!client || !isDesktopRole(access?.role))
      throw Error('데스크톱 계정으로 먼저 로그인해주세요.');
    return access;
  }
  // Signed-in role for menus, including the sales preview (which has no data access).
  function currentAccess() {
    if (!client || !isDesktopLoginRole(access?.role))
      throw Error('데스크톱 계정으로 먼저 로그인해주세요.');
    return access;
  }
  return {
    requireOwner,
    currentAccess,
    previewOnly: () => !!client && isPreviewRole(access?.role),
    syncClient() {
      requireOwner();
      return client;
    },
    async refreshAccess() {
      const api = client,
        previous = requireOwner();
      const result = await api.getAccess(previous.workspaceId);
      if (client !== api) throw Error('로그인 계정이 변경되었습니다.');
      const revoke = () => {
        client = null;
        access = null;
        settings = null;
        void api.auth.signOut({ scope: 'local' }).catch(() => {});
        throw Object.assign(Error('데스크톱 사용 권한이 없습니다. 다시 로그인해주세요.'), {
          code: '403',
          accessDenied: true,
        });
      };
      if (result.error) {
        if (result.error.accessDenied) revoke();
        throw Object.assign(Error('회사 권한을 확인하지 못했습니다.'), {
          code: result.error.code,
          retryable: result.error.retryable,
        });
      }
      const session = await api.auth.getSession();
      if (client !== api) throw Error('로그인 계정이 변경되었습니다.');
      if (session.error) throw Error('로그인 상태를 확인하지 못했습니다.');
      if (!session.data?.session) revoke();
      let next;
      try {
        next = validateAccess(result.data, previous.workspaceId, session.data.session.user?.id);
      } catch {
        revoke();
      }
      if (!isDesktopRole(next.role) || next.ownerId !== previous.ownerId) revoke();
      access = next;
      return next;
    },
    async login(input, bound = {}) {
      if (pending) throw Error('로그인 확인 중입니다.');
      if (client) return currentAccess();
      const clean = validateConfig(input);
      if (
        bound.url &&
        bound.workspaceId &&
        (new URL(bound.url).origin !== clean.url || bound.workspaceId !== input.workspaceId)
      )
        throw Error('기존 회사 연결 정보와 다릅니다. 다른 회사 계정으로 이 DB를 열 수 없습니다.');
      if (!uuid(input.workspaceId)) throw Error('회사 작업공간 ID를 확인해주세요.');
      pending = true;
      const attempt = ++generation;
      let next;
      try {
        next = createBackend(clean.url, clean.key, {
          auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
        });
        const result = await next.auth.signInWithPassword({
          email: loginEmail(clean.email, input.workspaceId),
          password: input.password,
        });
        if (result.error || !result.data?.session) throw Error('아이디와 비밀번호를 확인해주세요.');
        const permission = await next.getDesktopAccess(
          input.workspaceId,
          bound.ownerId,
          bound.email,
        );
        if (permission.error)
          throw Error(
            '회사 권한을 확인하지 못했습니다. 서버 권한 설정과 계정 상태를 확인해주세요.',
          );
        const verified = validateAccess(permission.data, input.workspaceId, result.data.user.id);
        if (!isDesktopLoginRole(verified.role))
          throw Error('데스크톱은 마스터·부마스터·관리자·영업 계정만 사용할 수 있습니다.');
        if (bound.ownerId && verified.ownerId !== bound.ownerId)
          throw Error('기존 회사 계정과 다릅니다.');
        if (attempt !== generation) throw Error('로그인 계정이 변경되었습니다.');
        client = next;
        actorId = result.data.user.id;
        liveSessionId = randomUUID();
        access = verified;
        settings = { ...clean, workspaceId: input.workspaceId };
        return access;
      } catch (error) {
        if (next) await next.auth.signOut({ scope: 'local' }).catch(() => {});
        throw error;
      } finally {
        pending = false;
      }
    },
    async scopedClient() {
      const original = client,
        bound = { ...requireOwner() };
      const current = async () => {
        const a = requireOwner();
        if (
          client !== original ||
          a.ownerId !== bound.ownerId ||
          a.workspaceId !== bound.workspaceId
        )
          throw Error('로그인 계정이 변경되었습니다.');
        const result = await original.auth.getSession();
        if (client !== original || result.error || !result.data?.session)
          throw Error('다시 로그인해주세요.');
        return result.data.session.access_token;
      };
      await current();
      return createBackend(settings.url, settings.key, { accessToken: current });
    },
    // Office and sales send registration review requests. Sales has no company data, so this
    // context carries only the server API and the signed-in access.
    async requestContext() {
      const original = client,
        bound = { ...currentAccess() };
      if (!can(bound, 'register-request') && !can(bound, 'register'))
        throw Error('신규 등록을 할 수 없는 계정입니다.');
      return {
        api: original.desktop,
        earth: original.earth,
        access: bound,
        current: () => client === original && access?.workspaceId === bound.workspaceId,
      };
    },
    async fieldSession() {
      requireOwner();
      const result = await client.auth.getSession();
      if (result.error || !result.data?.session) throw Error('다시 로그인해주세요.');
      return { session: result.data.session, access, settings };
    },
    async sharedContext() {
      const original = client,
        bound = { ...requireOwner() },
        sessionId = liveSessionId,
        epoch = generation;
      const session = await original.auth.getSession();
      if (
        client !== original ||
        generation !== epoch ||
        session.error ||
        session.data?.session?.user?.id !== actorId ||
        !uuid(actorId)
      )
        throw Error('로그인 계정이 변경되었습니다. 다시 로그인해주세요.');
      return {
        api: original.desktop,
        privacy: original.privacy,
        access: { ...bound, actorId },
        sessionId,
        current: () =>
          client === original &&
          generation === epoch &&
          liveSessionId === sessionId &&
          access?.ownerId === bound.ownerId &&
          access?.workspaceId === bound.workspaceId,
      };
    },
    async logout() {
      const previous = client;
      generation++;
      actorId = null;
      liveSessionId = null;
      client = null;
      access = null;
      settings = null;
      if (previous) await previous.auth.signOut({ scope: 'local' });
    },
  };
}
module.exports = { desktopAuth };
