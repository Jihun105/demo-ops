// Response headers of the server function handlers. The two sets are kept exactly as each handler
// has always sent them (header order, Cache-Control), so they are not merged into one.

// earth-assets, staff-accounts, work-reports: every reply is JSON and never cached.
export const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
export const reply = (status, body) => new Response(JSON.stringify(body), { status, headers });

// work-routing, bank-deposits: CORS only; each handler adds its own JSON headers.
export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
