import accessModel from '../shared/access.cjs';
import checks from '../shared/checks.cjs';
import { headers, reply } from './http.mjs';

const { isDesktopRole, isOwnerRole, loginEmail } = accessModel;
const { uuid } = checks;
// 2026-10-22 roles. Owner/master manage every staff role; a submaster manages only roles
// below it (office, sales, worker) and never deletes accounts. Office (2026-10-29) sees and
// issues office, sales and worker logins only; changing or stopping accounts is not theirs.
const STAFF_ROLES = ['master', 'submaster', 'office', 'sales', 'worker'];
const LOWER_ROLES = ['office', 'sales', 'worker'];
const manageable = (actorRole) =>
  isOwnerRole(actorRole) ? STAFF_ROLES : actorRole === 'submaster' ? LOWER_ROLES : [];
const creatable = (actorRole) => (actorRole === 'office' ? LOWER_ROLES : manageable(actorRole));
const staffRole = (s, actorRole) => manageable(actorRole).includes(s);
// Dependencies are network boundaries; authorization never trusts a role from the request body.
export async function accountHandler(request, services) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return reply(405, { error: '지원하지 않는 요청입니다.' });
  let body;
  try {
    const text = await request.text();
    if (text.length > 8000) return reply(413, { error: '요청이 너무 큽니다.' });
    body = JSON.parse(text);
    if (!body || !uuid(body.workspaceId)) throw Error();
  } catch {
    return reply(400, { error: '작업공간을 확인해주세요.' });
  }
  let access;
  try {
    access = await services.authorize(request.headers.get('Authorization'), body.workspaceId);
  } catch {
    return reply(401, { error: '다시 로그인해주세요.' });
  }
  if (
    !access ||
    !isDesktopRole(access.role) ||
    (access.role === 'owner' && access.ownerId !== access.id) ||
    access.workspaceId !== body.workspaceId
  )
    return reply(403, { error: '데스크톱 관리 계정만 직원 계정을 볼 수 있습니다.' });
  // Changes need a role that manages staff; office may only list and create.
  if (!['list', 'create'].includes(body.action) && !manageable(access.role).length)
    return reply(403, { error: '사장님·마스터·부마스터 계정만 직원 계정을 관리할 수 있습니다.' });
  // The target's CURRENT role must also be manageable (a submaster cannot change a master).
  const target = async (userId) =>
    (await services.list(access.ownerId, body.workspaceId)).find((m) => m.user_id === userId);
  try {
    if (body.action === 'list') {
      const members = await services.list(access.ownerId, body.workspaceId);
      return reply(200, {
        members:
          access.role === 'office' ? members.filter((m) => LOWER_ROLES.includes(m.role)) : members,
        currentUserId: access.id,
        assignableRoles: manageable(access.role),
        creatableRoles: creatable(access.role),
        canDelete: isOwnerRole(access.role),
      });
    }
    if (body.action === 'create') {
      const loginId = String(body.loginId || '')
        .trim()
        .toLowerCase();
      const name = String(body.displayName || '').trim();
      if (
        !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(loginId) ||
        !name ||
        name.length > 80 ||
        !creatable(access.role).includes(body.role) ||
        typeof body.password !== 'string' ||
        body.password.length < 12 ||
        body.password.length > 128
      )
        return reply(400, {
          error:
            '아이디는 영문·숫자 등 3~32자, 비밀번호는 12~128자이며 이름과 직원 권한이 필요합니다.',
        });
      const id = await services.createUser(loginEmail(loginId, body.workspaceId), body.password);
      try {
        await services.addMember({
          user_id: id,
          owner_id: access.ownerId,
          workspace_id: body.workspaceId,
          login_id: loginId,
          display_name: name,
          role: body.role,
        });
      } catch (error) {
        await services.deleteUser(id);
        throw error;
      }
      return reply(200, { ok: true });
    }
    if (body.action === 'delete') {
      if (!isOwnerRole(access.role))
        return reply(403, { error: '직원 계정 삭제는 사장님·마스터만 할 수 있습니다.' });
      if (!uuid(body.userId) || body.userId === access.id || body.userId === access.ownerId)
        return reply(400, { error: '사장님 원본 계정과 현재 로그인한 계정은 삭제할 수 없습니다.' });
      // Scope the target before the Auth admin API; failed deletion must remain locked.
      const found = await services.updateMember(access.ownerId, body.workspaceId, body.userId, {
        active: false,
      });
      if (!found) return reply(404, { error: '이 회사에 해당 직원이 없습니다.' });
      try {
        await services.deleteUser(body.userId);
      } catch {
        return reply(500, {
          error: '계정은 사용 중지했지만 삭제를 완료하지 못했습니다. 잠시 후 다시 삭제해주세요.',
        });
      }
      return reply(200, { ok: true });
    }
    if (body.action === 'update') {
      if (
        !uuid(body.userId) ||
        body.userId === access.id ||
        !staffRole(body.role, access.role) ||
        typeof body.active !== 'boolean'
      )
        return reply(400, { error: '직원과 권한을 확인해주세요.' });
      const current = await target(body.userId);
      if (!current) return reply(404, { error: '이 회사에 해당 직원이 없습니다.' });
      if (!staffRole(current.role, access.role))
        return reply(403, { error: '자기보다 높거나 같은 권한의 계정은 바꿀 수 없습니다.' });
      const changed = await services.updateMember(access.ownerId, body.workspaceId, body.userId, {
        role: body.role,
        active: body.active,
      });
      return changed
        ? reply(200, { ok: true })
        : reply(404, { error: '이 회사에 해당 직원이 없습니다.' });
    }
    return reply(400, { error: '지원하지 않는 작업입니다.' });
  } catch {
    return reply(500, { error: '저장하지 못했습니다. 중복 아이디 또는 서버 설정을 확인해주세요.' });
  }
}
