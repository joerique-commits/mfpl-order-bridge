// Password hashing + token generation, built on the standard Web Crypto API
// (globalThis.crypto.subtle) so this exact code runs unchanged in EdgeOne's
// edge runtime and in Node (used by scripts/seed-users.mjs for local seeding
// and by scripts/test-auth-crypto.mjs for verification).
//
// Scheme: PBKDF2-HMAC-SHA256, 100,000 iterations, 16-byte random salt,
// 32-byte derived key. Not bcrypt/scrypt/argon2 because those aren't part of
// Web Crypto and EdgeOne's edge runtime is assumed Workers-like (no native
// Node crypto module) - PBKDF2 via SubtleCrypto is the portable choice.

const PBKDF2_ITERATIONS = 100000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function pbkdf2(password, saltBytes, iterations, keyBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    keyMaterial,
    keyBytes * 8
  );
  return new Uint8Array(derived);
}

// Returns {hash, salt, iterations} - all hex strings / number, safe to store as JSON.
export async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await pbkdf2(password, saltBytes, PBKDF2_ITERATIONS, KEY_BYTES);
  return {
    hash: toHex(derived),
    salt: toHex(saltBytes),
    iterations: PBKDF2_ITERATIONS,
  };
}

// stored: {hash, salt, iterations} as read back from a user record.
export async function verifyPassword(password, stored) {
  if (!stored || !stored.hash || !stored.salt) return false;
  const saltBytes = fromHex(stored.salt);
  const iterations = stored.iterations || PBKDF2_ITERATIONS;
  const derived = await pbkdf2(password, saltBytes, iterations, fromHex(stored.hash).length);
  const derivedHex = toHex(derived);
  return constantTimeEqual(derivedHex, stored.hash);
}

// Plain === on secrets leaks timing info; compare every char regardless of an
// early mismatch. Still short-circuits on length (lengths aren't secret here).
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 256-bit random token, hex-encoded (64 chars) - used for session tokens and
// for approval-link tokens (SO Revision, Dispatch Day) per the platform spec.
export function randomToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

// Short random id for records, e.g. randomId('u') -> 'u_3f9a1c7b2e4d'.
export function randomId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}_${toHex(bytes)}`;
}
