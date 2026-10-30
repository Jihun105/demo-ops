'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readEnvironment, companyFrom } = require('../environment.cjs');
const { validateConfig } = require('../backend/supabase/config.cjs');
const { uuid } = require('../shared/field-model.cjs');

const invalidConfig = () =>
  Object.assign(Error('프로그램 설치 설정을 확인할 수 없습니다. 관리자에게 문의해주세요.'), {
    code: 'desktop-config-invalid',
  });
function hasFields(value, fields) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((key) => Object.hasOwn(value, key))
  );
}
function validateDesktopConfig(value) {
  if (
    !hasFields(value, ['formatVersion', 'company', 'maps']) ||
    value.formatVersion !== 1 ||
    !hasFields(value.company, ['url', 'key', 'workspaceId']) ||
    Object.values(value.company).some((entry) => typeof entry !== 'string') ||
    !hasFields(value.maps, ['kakaoJavascriptKey', 'googleApiKey', 'googleMapId']) ||
    !uuid(value.company.workspaceId) ||
    Object.values(value.maps).some((entry) => typeof entry !== 'string')
  )
    throw invalidConfig();
  let company;
  try {
    company = validateConfig(value.company);
  } catch {
    throw invalidConfig();
  }
  return {
    formatVersion: 1,
    company: { url: company.url, key: company.key, workspaceId: value.company.workspaceId },
    maps: { ...value.maps },
  };
}
function configFromEnvironment(options) {
  const env = readEnvironment(options);
  return {
    formatVersion: 1,
    company: companyFrom(env),
    maps: {
      kakaoJavascriptKey: env.KAKAO_MAPS_JAVASCRIPT_KEY || '',
      googleApiKey: env.GOOGLE_MAPS_API_KEY || '',
      googleMapId: env.GOOGLE_MAP_ID || '',
    },
  };
}
function loadDesktopConfig({ packaged = false, resourcesPath, root, env } = {}) {
  if (!packaged) return configFromEnvironment({ root, env });
  try {
    return validateDesktopConfig(
      JSON.parse(fs.readFileSync(path.join(resourcesPath, 'desktop-config.json'), 'utf8')),
    );
  } catch {
    throw invalidConfig();
  }
}
module.exports = { configFromEnvironment, validateDesktopConfig, loadDesktopConfig };
