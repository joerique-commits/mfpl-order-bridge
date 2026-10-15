// GET /api/diag/crypto  -> isolates exactly which Web Crypto call EdgeOne's
// edge runtime rejects with "Param Invalid" during PBKDF2 password
// verification. TEMPORARY - no auth required, delete once the real
// authenticate()/verifyPassword() path is fixed and confirmed working.
export async function onRequestGet() {
  const results = {};

  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hello'));
    results.digest_SHA256 = { ok: true, byteLength: digest.byteLength };
  } catch (e) {
    results.digest_SHA256 = { ok: false, name: e && e.name, message: e && e.message };
  }

  try {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode('testpassword'),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    results.importKey_objectAlgo = { ok: true };

    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const derived = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        256
      );
      results.deriveBits_stringHash = { ok: true, byteLength: derived.byteLength };
    } catch (e2) {
      results.deriveBits_stringHash = { ok: false, name: e2 && e2.name, message: e2 && e2.message };
    }

    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const derived = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: 100000, hash: { name: 'SHA-256' } },
        keyMaterial,
        256
      );
      results.deriveBits_objectHash = { ok: true, byteLength: derived.byteLength };
    } catch (e3) {
      results.deriveBits_objectHash = { ok: false, name: e3 && e3.name, message: e3 && e3.message };
    }

    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const derived = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: salt.buffer, iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        256
      );
      results.deriveBits_arrayBufferSalt = { ok: true, byteLength: derived.byteLength };
    } catch (e4) {
      results.deriveBits_arrayBufferSalt = { ok: false, name: e4 && e4.name, message: e4 && e4.message };
    }

    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const derived = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-256' },
        keyMaterial,
        256
      );
      results.deriveBits_lowIterations = { ok: true, byteLength: derived.byteLength };
    } catch (e5) {
      results.deriveBits_lowIterations = { ok: false, name: e5 && e5.name, message: e5 && e5.message };
    }
  } catch (e) {
    results.importKey_objectAlgo = { ok: false, name: e && e.name, message: e && e.message };
  }

  try {
    const enc = new TextEncoder();
    const keyMaterial2 = await crypto.subtle.importKey(
      'raw',
      enc.encode('testpassword'),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    results.importKey_stringAlgo = { ok: true };
  } catch (e6) {
    results.importKey_stringAlgo = { ok: false, name: e6 && e6.name, message: e6 && e6.message };
  }

  return new Response(JSON.stringify(results, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' },
  });
}
