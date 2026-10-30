'use strict';
async function manageStaff(auth, input) {
  const bound = { ...auth.requireOwner() };
  const fields = {
    list: [],
    create: ['displayName', 'loginId', 'password', 'role'],
    update: ['userId', 'role', 'active'],
    delete: ['userId'],
  };
  if (!input || !Object.hasOwn(fields, input.action)) throw Error('지원하지 않는 계정 작업입니다.');
  const body = { action: input.action, workspaceId: bound.workspaceId };
  for (const key of fields[input.action]) body[key] = input[key];
  if (JSON.stringify(body).length > 8000) throw Error('입력 내용이 너무 깁니다.');
  const client = await auth.scopedClient();
  const result = await client.staff.manage(body);
  if (result.error) {
    const message = result.error.userMessage;
    throw Error(message || '직원 계정 서버에 연결하지 못했습니다. 다시 시도해주세요.');
  }
  if (result.data?.error) throw Error(result.data.error);
  return result.data;
}
module.exports = { manageStaff };
