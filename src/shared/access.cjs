'use strict';
const { uuid } = require('./checks.cjs');
const roles = Object.freeze({
  owner: '사장님',
  master: '마스터',
  submaster: '부마스터',
  office: '관리자',
  sales: '영업',
  worker: '일반 작업자',
});
// Same matrix as demo_desktop.role_allows (database/cloud/desktop/core.sql). The server decides;
// this copy only chooses which menus and buttons to show.
const FEATURES = Object.freeze({
  owner: [
    'billing',
    'customer-edit',
    'delete',
    'import',
    'privacy',
    'read',
    'register',
    'requirements',
    'sales',
    'staff',
    'work-plan',
  ],
  master: [
    'billing',
    'customer-edit',
    'delete',
    'import',
    'privacy',
    'read',
    'register',
    'requirements',
    'sales',
    'staff',
    'work-plan',
  ],
  submaster: [
    'billing',
    'customer-edit',
    'read',
    'register',
    'requirements',
    'sales',
    'staff',
    'work-plan',
  ],
  office: ['read', 'register-request', 'requirements', 'sales', 'staff', 'work-plan'],
  sales: ['register-request'],
  worker: [],
});
const DESKTOP_ROLES = Object.freeze(['owner', 'master', 'submaster', 'office']);
// Phones: owner/master, submaster (step 6-3) and field workers. Office and sales use the PC.
const PHONE_ROLES = Object.freeze(['owner', 'master', 'submaster', 'worker']);
const isOwnerRole = (role) => role === 'owner' || role === 'master';
const isDesktopRole = (role) => DESKTOP_ROLES.includes(role);
// Sales signs in to the desktop for the new-registration screen only. Until the approval queue
// (step 4) it is a preview: no customer data is downloaded and registering stays locked.
const isPreviewRole = (role) => role === 'sales';
const isDesktopLoginRole = (role) => isDesktopRole(role) || isPreviewRole(role);
const isPhoneRole = (role) => PHONE_ROLES.includes(role);
const features = (role) => (Object.hasOwn(FEATURES, role) ? FEATURES[role] : []);
const can = (access, feature) => features(access?.role).includes(feature);
function validateAccess(value, workspaceId, userId) {
  if (
    !value ||
    !Object.hasOwn(roles, value.role) ||
    value.workspaceId !== workspaceId ||
    !uuid(value.ownerId) ||
    (value.role === 'owner' && value.ownerId !== userId)
  )
    throw Error('회사 계정 권한을 확인하지 못했습니다. 사장님에게 계정 상태를 확인해주세요.');
  return value;
}
function loginEmail(login, workspaceId) {
  const value = String(login).trim().toLowerCase();
  if (value.includes('@')) return value;
  if (!uuid(workspaceId) || !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(value))
    throw Error('전달받은 직원 아이디와 회사 연결 정보를 확인해주세요.');
  return `${value}@${workspaceId}.staff.demo.invalid`;
}
module.exports = {
  roles,
  isOwnerRole,
  isDesktopRole,
  isPreviewRole,
  isDesktopLoginRole,
  isPhoneRole,
  features,
  can,
  validateAccess,
  loginEmail,
};
