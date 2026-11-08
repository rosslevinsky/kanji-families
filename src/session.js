// Signed, expiring session cookies, and the keyed IDs derived from an account's sub.
//
// One secret, SESSION_KEY, gives a separate key for each use, so a value made for one use can
// never pass as another.

export const SESSION_COOKIE = 'kf_session';
export const SESSION_MAX_AGE_MS = 90 * 86400000;
export const MAX_SUB_LENGTH = 255; // Google's limit for sub
const MIN_KEY_LENGTH = 32;

const encoder = new TextEncoder();

export function hasSessionKey(env) {
  return typeof env.SESSION_KEY === 'string' && env.SESSION_KEY.length >= MIN_KEY_LENGTH;
}

async function keyFor(env, purpose) {
  const root = await crypto.subtle.importKey('raw', encoder.encode(env.SESSION_KEY), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode(purpose) },
    root,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

export function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function fromBase64Url(text) {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

async function keyedId(env, purpose, sub) {
  return toBase64Url(await crypto.subtle.sign('HMAC', await keyFor(env, purpose), encoder.encode(sub)));
}

// What the browser records as a copy's owner. It can't be turned back into the sub.
export const accountId = (env, sub) => keyedId(env, 'account-id', sub);

// What a deletion marker stores in place of the sub.
export const deletionHash = (env, sub) => keyedId(env, 'deletion-marker', sub);

// A JSON value and its signature. `purpose` picks the key, so a value made for one use fails as another.
export async function signValue(env, purpose, value) {
  const payload = toBase64Url(encoder.encode(JSON.stringify(value)));
  const signature = await crypto.subtle.sign('HMAC', await keyFor(env, purpose), encoder.encode(payload));
  return `${payload}.${toBase64Url(signature)}`;
}

// Returns the value if the signature is good, otherwise null.
export async function readSignedValue(env, purpose, signed) {
  const parts = (signed || '').split('.');
  if (parts.length !== 2) return null;
  try {
    const key = await keyFor(env, purpose);
    if (!await crypto.subtle.verify('HMAC', key, fromBase64Url(parts[1]), encoder.encode(parts[0]))) return null;
    return JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
  } catch {
    return null; // not valid base64
  }
}

export const signSession = (env, { sub, iat, exp }) => signValue(env, 'session-cookie', { sub, iat, exp });

export function cookieValue(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

// Returns {sub, iat, exp} for a valid, unexpired cookie, otherwise null. It doesn't look at
// deletion markers: the database writes do that, in the same statement that writes.
export async function readSession(request, env, now = Date.now()) {
  if (!hasSessionKey(env)) return null;
  const session = await readSignedValue(env, 'session-cookie', cookieValue(request, SESSION_COOKIE));
  return session && session.exp > now ? session : null;
}

// Secure whenever the site is https, and never on plain-HTTP local development.
export function cookieHeader(env, name, value, { path, maxAgeSeconds }) {
  const secure = String(env.APP_URL).startsWith('https:') ? '; Secure' : '';
  return `${name}=${value}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`;
}

const sessionCookieHeader = (env, value, maxAgeSeconds) => cookieHeader(env, SESSION_COOKIE, value, { path: '/', maxAgeSeconds });

export const clearedSessionCookie = (env) => sessionCookieHeader(env, '', 0);

// Issued strictly after any deletion of this account, so a login after a deletion always works
// even within the same millisecond, and a session at or before a deletion's time never does.
export async function startSession(env, sub, now = Date.now()) {
  const marker = await env.DB.prepare('SELECT deleted_at FROM deletion_markers WHERE sub_hash = ?')
    .bind(await deletionHash(env, sub)).first();
  const iat = marker ? Math.max(now, marker.deleted_at + 1) : now;
  const value = await signSession(env, { sub, iat, exp: iat + SESSION_MAX_AGE_MS });
  return sessionCookieHeader(env, value, SESSION_MAX_AGE_MS / 1000);
}
