// Small response helpers so every endpoint returns consistent JSON shapes
// and CORS headers (the Pages site and the Functions API share an origin in
// production, but keeping CORS permissive here matches the existing local
// build's pattern of calling plain fetch() from the client).

const JSON_HEADERS = {
  'content-type': 'application/json; charset=UTF-8',
  'Access-Control-Allow-Origin': '*',
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function errorJson(message, status = 400) {
  return json({ error: message }, status);
}

export function bearerToken(request) {
  const header = request.headers.get('Authorization') || request.headers.get('authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function readJsonBody(request) {
  try {
    return await request.json();
  } catch (e) {
    throw new Error('Request body must be valid JSON');
  }
}
