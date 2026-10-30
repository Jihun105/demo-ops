'use strict';
const setupCodes = ['42P01', '42883', 'PGRST202', 'PGRST205'];
function isSetupCode(code) {
  return setupCodes.includes(code);
}
function errorDetails(result) {
  const error = result.error;
  const code = String(error.code || result.status || '');
  const accessDenied =
    [401, 403].includes(Number(result.status || error.status)) ||
    ['401', '403', '42501', 'P0001'].includes(code);
  const setupRequired = isSetupCode(code);
  return {
    code,
    message: error.message,
    setupRequired,
    accessDenied,
    retryable: !setupRequired && !accessDenied,
  };
}
function providerError(result, message) {
  const details = errorDetails(result);
  return Object.assign(Error(message || details.message), details, {
    message: message || details.message,
  });
}
async function providerResult(request) {
  const result = await request;
  if (!result?.error) return result;
  return {
    ...result,
    error: errorDetails(result),
  };
}
async function functionResult(request) {
  const response = await request;
  const result = await providerResult(response);
  if (result.error) {
    try {
      const body = await response.error.context?.json();
      result.error.userMessage = body?.error || body?.message || '';
      if (typeof body?.code === 'string') result.error.serverCode = body.code;
    } catch {}
  }
  return result;
}
module.exports = { providerResult, functionResult, providerError, isSetupCode };
