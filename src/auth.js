// Google login: the OpenID Connect authorization-code flow with PKCE, state and nonce, using only
// Web Crypto. It asks for the openid scope, so Google sends no email or name, and only sub is kept.
//
// Endpoints and issuers checked on 2026-11-02 against
// https://developers.google.com/identity/openid-connect/openid-connect and
// https://accounts.google.com/.well-known/openid-configuration. They are fixed here rather than
// fetched at runtime, so a login costs one request to Google.
import { error, json, redirect } from './http.js';
import {
  clearedSessionCookie, cookieHeader, cookieValue, fromBase64Url, hasSessionKey, MAX_SUB_LENGTH, readSignedValue, signValue, startSession, toBase64Url,
} from './session.js';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
// The error codes a token endpoint may return (RFC 6749, section 5.2).
const TOKEN_ERRORS = new Set(['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope']);
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const LOGIN_COOKIE = 'kf_login';
const LOGIN_COOKIE_PATH = '/auth';
const LOGIN_MAX_AGE_SECONDS = 600;
const LOGIN_PURPOSE = 'login-transaction';

const encoder = new TextEncoder();

function appUrlIsValid(env) {
  try {
    return ['http:', 'https:'].includes(new URL(env.APP_URL).protocol);
  } catch {
    return false;
  }
}

export const googleLoginAvailable = (env) => appUrlIsValid(env) && hasSessionKey(env) && !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET;

const notConfigured = () => error(503, 'not_configured', 'Google login is not set up on this site.');

// From APP_URL and never from the request, so a forged Host can't redirect the login elsewhere.
const redirectUri = (env) => new URL('/auth/callback', env.APP_URL).href;

const randomToken = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

// Takes the same time wherever the first difference is. Only the length can show.
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = encoder.encode(a), y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}

const loginCookie = (env, value, maxAgeSeconds) => cookieHeader(env, LOGIN_COOKIE, value, { path: LOGIN_COOKIE_PATH, maxAgeSeconds });

export async function startLogin(request, env) {
  if (!googleLoginAvailable(env)) return notConfigured();
  const state = randomToken(), nonce = randomToken(), verifier = randomToken();
  const challenge = toBase64Url(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    response_type: 'code',
    scope: 'openid',
    redirect_uri: redirectUri(env),
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const exp = Date.now() + LOGIN_MAX_AGE_SECONDS * 1000;
  const signed = await signValue(env, LOGIN_PURPOSE, { state, nonce, verifier, exp });
  return redirect(url.href, [loginCookie(env, signed, LOGIN_MAX_AGE_SECONDS)]);
}

// Returns the token's claims, or null if it isn't a well-formed JWT holding a JSON object.
function decodeIdToken(idToken) {
  if (typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  try {
    const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(parts[1])));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

// The token comes straight from Google's token endpoint over TLS, in reply to a request carrying
// our client secret. OpenID Connect allows skipping the signature check in that case, and Google's
// documentation says the same, so the signature isn't checked. Everything else is. Returns the sub,
// or null. Any email or name in the token is ignored.
function subFromIdToken(idToken, env, nonce, now) {
  const claims = decodeIdToken(idToken);
  if (!claims) return null;
  if (!ISSUERS.includes(claims.iss)) return null;
  if (claims.aud !== env.GOOGLE_CLIENT_ID) return null; // a list of audiences is refused too
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
  if (!constantTimeEqual(claims.nonce, nonce)) return null;
  const { sub } = claims;
  return typeof sub === 'string' && sub && sub.length <= MAX_SUB_LENGTH ? sub : null;
}

// Returns the reply's id_token, or undefined if Google refused or couldn't be reached.
async function exchangeCode(code, verifier, env) {
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(env),
        code_verifier: verifier,
      }).toString(),
    });
    if (!res.ok) {
      // Google's error code says which setting is wrong, such as invalid_client for a bad secret.
      // Only the standard OAuth codes are logged, so nothing else Google echoes can reach the log.
      const reply = await res.json().catch(() => null);
      const shown = TOKEN_ERRORS.has(reply?.error) ? reply.error : 'unexpected error code';
      console.warn(`Google refused the sign-in code: ${res.status} ${shown}`);
      return undefined;
    }
    return (await res.json()).id_token;
  } catch (err) {
    console.warn(`Couldn't finish the sign-in with Google: ${String(err?.name ?? 'error')}`);
    return undefined;
  }
}

export async function loginCallback(request, env) {
  if (!googleLoginAvailable(env)) return notConfigured();
  const clear = loginCookie(env, '', 0);
  // Every way out goes to a fixed path on this site, so nothing here can redirect elsewhere. The
  // codes are a fixed list, which the page can use to say what happened.
  const refuse = (code) => redirect(`/?login_error=${code}`, [clear]);

  const query = new URL(request.url).searchParams;
  if (query.has('error')) return redirect('/', [clear]); // the person canceled at Google

  const now = Date.now();
  const login = await readSignedValue(env, LOGIN_PURPOSE, cookieValue(request, LOGIN_COOKIE));
  if (!login || !(login.exp > now) || !constantTimeEqual(query.get('state'), login.state)) return refuse('bad_state');

  const code = query.get('code');
  if (!code) return refuse('bad_request');

  const idToken = await exchangeCode(code, login.verifier, env);
  if (idToken === undefined) return refuse('google_failed');

  const sub = subFromIdToken(idToken, env, login.nonce, now);
  if (!sub) return refuse('bad_token');

  return redirect('/', [clear, await startSession(env, sub)]);
}

// Only ends this browser's session. The cookie is stateless, so a copy of it stays valid until it
// expires. That is accepted: a session holds only an account ID. Offered with the fake login too,
// so it needs no Google settings.
export const logout = (request, env) => json(200, { signedOut: true }, { 'Set-Cookie': clearedSessionCookie(env) });
