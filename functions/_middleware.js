// Handles CORS preflight (OPTIONS) for every /api/* route, and stamps
// permissive CORS headers onto every response. http.js's json()/errorJson()
// helpers already set Access-Control-Allow-Origin on the responses a route
// handler produces, but a browser's CORS *preflight* OPTIONS request never
// reaches a route handler at all (no endpoint exports onRequestOptions) -
// without this, any "non-simple" cross-origin request (anything sending
// Content-Type: application/json or an Authorization header, which is
// every request this API takes) gets blocked by the browser before it ever
// reaches the Function, surfacing to the caller as a generic network
// failure ("Failed to fetch") with no server-side log at all.
//
// In normal production use the site and the API share an origin (the
// frontend is served from the same Pages project as these Functions), so
// this mostly matters for anything calling the API cross-origin - local
// test tools, a separately-hosted admin console, etc.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function onRequest({ request, next }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const response = await next();
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}
