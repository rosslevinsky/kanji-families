import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answers, baseEnv, callWith, login, ORIGIN, store } from './helpers/api.js';
import { signValue } from '../src/session.js';
import worker from '../src/worker.js';

const GOOGLE = { GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret' };
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LOGIN_COOKIE = 'kf_login';
const SESSION_COOKIE = 'kf_session';
const REDIRECT_URI = `${ORIGIN}/auth/callback`;

const base64Url = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))
  .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims) => `${base64Url('{"alg":"RS256"}')}.${base64Url(JSON.stringify(claims))}.fake-signature`;
const decodeBase64Url = (text) => new TextDecoder().decode(
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

const cookiesOf = (res) => res.headers.getSetCookie();
const cookieLine = (res, name) => cookiesOf(res).find((c) => c.startsWith(`${name}=`));
const pair = (line) => line.split(';')[0];

// Stands in for Google's token endpoint. A test can replace `tokenReply`.
let tokenReply;
let fakeFetch;

beforeEach(() => {
  tokenReply = null;
  fakeFetch = vi.fn(async (url) => {
    if (String(url) !== TOKEN_URL) throw new Error(`unexpected network call to ${url}`);
    return tokenReply();
  });
  vi.stubGlobal('fetch', fakeFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const startLogin = () => callWith(GOOGLE, 'GET', '/auth/login', { origin: null });

async function begin() {
  const res = await startLogin();
  expect(res.status).toBe(302);
  const url = new URL(res.headers.get('Location'));
  return { res, url, cookie: pair(cookieLine(res, LOGIN_COOKIE)), state: url.searchParams.get('state'), nonce: url.searchParams.get('nonce') };
}

const replyWith = (idToken, status = 200) => {
  tokenReply = () => new Response(JSON.stringify({ access_token: 'unused', id_token: idToken }), { status });
};

const goodClaims = (nonce, fields = {}) => ({
  iss: 'https://accounts.google.com',
  aud: GOOGLE.GOOGLE_CLIENT_ID,
  exp: Math.floor(Date.now() / 1000) + 3600,
  sub: 'google-sub-1',
  nonce,
  ...fields,
});

const callback = (query, cookie) => callWith(GOOGLE, 'GET', `/auth/callback?${new URLSearchParams(query)}`, { cookie, origin: null });

// One whole login, with the token's claims changed as the test asks.
async function finish(fields = {}) {
  const { cookie, state, nonce } = await begin();
  replyWith(jwt(goodClaims(nonce, fields)));
  return callback({ code: 'the-code', state }, cookie);
}

function expectRefused(res, code) {
  expect(res.status).toBe(302);
  expect(res.headers.get('Location')).toBe(`/?login_error=${code}`);
  expect(cookieLine(res, SESSION_COOKIE)).toBeUndefined();
  expect(cookieLine(res, LOGIN_COOKIE)).toMatch(/Max-Age=0/);
}

const sessionPayload = (res) => JSON.parse(decodeBase64Url(pair(cookieLine(res, SESSION_COOKIE)).split('=')[1].split('.')[0]));

describe('starting a login', () => {
  it('sends the browser to Google with the code flow, PKCE, state and nonce', async () => {
    const { url, state, nonce } = await begin();
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(GOOGLE.GOOGLE_CLIENT_ID);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(state).toMatch(/^[\w-]{43}$/);
    expect(nonce).toMatch(/^[\w-]{43}$/);
    expect(nonce).not.toBe(state);
  });

  it('asks only for openid', async () => {
    const { url } = await begin();
    expect(url.searchParams.get('scope')).toBe('openid');
  });

  it('uses new values each time', async () => {
    const one = await begin(), two = await begin();
    expect(one.state).not.toBe(two.state);
    expect(one.nonce).not.toBe(two.nonce);
    expect(one.url.searchParams.get('code_challenge')).not.toBe(two.url.searchParams.get('code_challenge'));
  });

  it('keeps its state in a short-lived HttpOnly cookie limited to /auth', async () => {
    const { res } = await begin();
    const line = cookieLine(res, LOGIN_COOKIE);
    expect(line).toMatch(/; HttpOnly/);
    expect(line).toMatch(/; SameSite=Lax/);
    expect(line).toMatch(/; Path=\/auth(;|$)/);
    expect(Number(/Max-Age=(\d+)/.exec(line)[1])).toBeLessThanOrEqual(600);
    expect(line).not.toMatch(/Secure/);
  });

  it('marks the cookie Secure when APP_URL is https', async () => {
    const res = await callWith({ ...GOOGLE, APP_URL: 'https://app.test' }, 'GET', '/auth/login', { origin: null });
    expect(cookieLine(res, LOGIN_COOKIE)).toMatch(/; Secure/);
  });

  it('builds the redirect URL from APP_URL, ignoring a forged Host', async () => {
    const forged = new Request('http://evil.test/auth/login', { headers: { Host: 'evil.test', 'X-Forwarded-Host': 'evil.test' } });
    const res = await worker.fetch(forged, { ...baseEnv(), ...GOOGLE });
    expect(new URL(res.headers.get('Location')).searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
  });
});

describe('finishing a login', () => {
  it('starts a session, clears the login cookie and goes home', async () => {
    const res = await finish();
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');
    expect(cookieLine(res, LOGIN_COOKIE)).toMatch(/Max-Age=0/);
    const session = pair(cookieLine(res, SESSION_COOKIE));
    const read = await callWith(GOOGLE, 'GET', '/api/progress', { cookie: session });
    expect(read.status).toBe(200);
  });

  it('accepts the issuer without the scheme too', async () => {
    const res = await finish({ iss: 'accounts.google.com' });
    expect(cookieLine(res, SESSION_COOKIE)).toBeDefined();
  });

  it('sends Google the code, secret, verifier and the APP_URL redirect, even with a forged Host', async () => {
    const { url, cookie, state, nonce } = await begin();
    replyWith(jwt(goodClaims(nonce)));
    const forged = new Request(`http://evil.test/auth/callback?code=the-code&state=${state}`, { headers: { Host: 'evil.test', Cookie: cookie } });
    await worker.fetch(forged, { ...baseEnv(), ...GOOGLE });

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [target, init] = fakeFetch.mock.calls[0];
    expect(target).toBe(TOKEN_URL);
    expect(init.method).toBe('POST');
    const sent = new URLSearchParams(init.body);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code')).toBe('the-code');
    expect(sent.get('client_id')).toBe(GOOGLE.GOOGLE_CLIENT_ID);
    expect(sent.get('client_secret')).toBe(GOOGLE.GOOGLE_CLIENT_SECRET);
    expect(sent.get('redirect_uri')).toBe(REDIRECT_URI);
    // The verifier really is the one the challenge sent to Google was made from.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sent.get('code_verifier')));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    expect(challenge).toBe(url.searchParams.get('code_challenge'));
  });

  it('keeps only sub: no email or name reaches the session or the database', async () => {
    const res = await finish({ email: 'person@example.test', name: 'Some Person', picture: 'https://example.test/p', given_name: 'Some' });
    const payload = sessionPayload(res);
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sub']);
    expect(payload.sub).toBe('google-sub-1');

    const cookie = pair(cookieLine(res, SESSION_COOKIE));
    const saved = await callWith(GOOGLE, 'PUT', '/api/progress', { cookie, body: store({ counters: answers('dev1', 1) }) });
    expect(saved.status).toBe(200);
    const { results } = await env.DB.prepare('SELECT * FROM progress').all();
    expect(results).toHaveLength(1);
    expect(results[0].sub).toBe('google-sub-1');
    expect(JSON.stringify(results)).not.toMatch(/person@example|Some Person|example\.test/);
  });

  it('logging in after a deletion gives a session that works', async () => {
    const first = pair(cookieLine(await finish(), SESSION_COOKIE));
    expect((await callWith(GOOGLE, 'DELETE', '/api/progress', { cookie: first })).status).toBe(200);
    const fresh = pair(cookieLine(await finish(), SESSION_COOKIE));
    expect((await callWith(GOOGLE, 'GET', '/api/progress', { cookie: fresh })).status).toBe(200);
  });
});

describe('a login is refused', () => {
  it('with the wrong state', async () => {
    const { cookie, nonce } = await begin();
    replyWith(jwt(goodClaims(nonce)));
    expectRefused(await callback({ code: 'c', state: 'x'.repeat(43) }, cookie), 'bad_state');
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('with a state of a different length', async () => {
    const { cookie, state } = await begin();
    expectRefused(await callback({ code: 'c', state: state + 'x' }, cookie), 'bad_state');
  });

  it('with no state', async () => {
    const { cookie } = await begin();
    expectRefused(await callback({ code: 'c' }, cookie), 'bad_state');
  });

  it('with no login cookie', async () => {
    const { state } = await begin();
    expectRefused(await callback({ code: 'c', state }), 'bad_state');
  });

  it('with a tampered login cookie', async () => {
    const { cookie, state } = await begin();
    const [name, value] = cookie.split('=');
    const [payload, signature] = value.split('.');
    const forged = JSON.parse(decodeBase64Url(payload));
    forged.nonce = 'attacker-nonce';
    expectRefused(await callback({ code: 'c', state }, `${name}=${base64Url(JSON.stringify(forged))}.${signature}`), 'bad_state');
  });

  it('with a login cookie signed with the session key rather than its own', async () => {
    const value = { state: 'chosen', nonce: 'chosen', verifier: 'chosen', exp: Date.now() + 60000 };
    const forged = await signValue({ ...baseEnv(), ...GOOGLE }, 'session-cookie', value);
    expectRefused(await callback({ code: 'c', state: 'chosen' }, `${LOGIN_COOKIE}=${forged}`), 'bad_state');
  });

  it('when the login cookie has expired', async () => {
    const { cookie, state } = await begin();
    const later = Date.now() + 11 * 60000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    expectRefused(await callback({ code: 'c', state }, cookie), 'bad_state');
  });

  it('with no code', async () => {
    const { cookie, state } = await begin();
    expectRefused(await callback({ state }, cookie), 'bad_request');
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('with the wrong nonce', async () => {
    expectRefused(await finish({ nonce: 'someone-elses-nonce' }), 'bad_token');
  });

  it('with no nonce', async () => {
    expectRefused(await finish({ nonce: undefined }), 'bad_token');
  });

  it('with the wrong issuer', async () => {
    expectRefused(await finish({ iss: 'https://accounts.evil.test' }), 'bad_token');
  });

  it('with no issuer', async () => {
    expectRefused(await finish({ iss: undefined }), 'bad_token');
  });

  it('with the wrong audience', async () => {
    expectRefused(await finish({ aud: 'another-client' }), 'bad_token');
  });

  it('with several audiences', async () => {
    expectRefused(await finish({ aud: [GOOGLE.GOOGLE_CLIENT_ID, 'another-client'] }), 'bad_token');
  });

  it('with an expired token', async () => {
    expectRefused(await finish({ exp: Math.floor(Date.now() / 1000) - 1 }), 'bad_token');
  });

  it.each([[undefined], ['9999999999'], [null]])('with an expiry of %j', async (exp) => {
    expectRefused(await finish({ exp }), 'bad_token');
  });

  it.each([[undefined], [''], [5], [null], ['x'.repeat(256)]])('with a sub of %j', async (sub) => {
    expectRefused(await finish({ sub }), 'bad_token');
  });

  it.each([
    ['no parts', ''],
    ['one part', 'abc'],
    ['two parts', 'abc.def'],
    ['four parts', 'a.b.c.d'],
    ['an empty signature', `${base64Url('{}')}.${base64Url('{}')}.`],
    ['a payload that is not base64', 'abc.!!!.def'],
    ['a payload that is not JSON', `abc.${base64Url('not json')}.def`],
    ['a payload that is an array', `abc.${base64Url('[]')}.def`],
    ['a payload that is null', `abc.${base64Url('null')}.def`],
    ['a number', 12345],
  ])('with a token that has %s', async (_name, idToken) => {
    const { cookie, state } = await begin();
    replyWith(idToken);
    expectRefused(await callback({ code: 'c', state }, cookie), 'bad_token');
  });

  it('when Google refuses the code', async () => {
    const { cookie, state } = await begin();
    tokenReply = () => new Response('{"error":"invalid_grant"}', { status: 400 });
    expectRefused(await callback({ code: 'c', state }, cookie), 'google_failed');
  });

  it('logs the reason Google gave, and not the secret or the code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { cookie, state } = await begin();
      tokenReply = () => new Response('{"error":"invalid_client","error_description":"Unauthorized"}', { status: 401 });
      expectRefused(await callback({ code: 'the-code', state }, cookie), 'google_failed');
      expect(warn).toHaveBeenCalledWith('Google refused the sign-in code: 401 invalid_client');
      const logged = warn.mock.calls.flat().join(' ');
      expect(logged).not.toContain('the-code');
      expect(logged).not.toContain(GOOGLE.GOOGLE_CLIENT_SECRET);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['a value that is not an error code', `{"error":"${GOOGLE.GOOGLE_CLIENT_SECRET} the-code"}`],
    ['a word that is not a standard error code', '{"error":"private_authorization_code"}'],
    ['no error code', '{}'],
    ['a reply that is not JSON', '<html>busy</html>'],
    ['a JSON null', 'null'],
  ])('logs only a placeholder when Google sends %s', async (_name, body) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { cookie, state } = await begin();
      tokenReply = () => new Response(body, { status: 400 });
      expectRefused(await callback({ code: 'the-code', state }, cookie), 'google_failed');
      expect(warn).toHaveBeenCalledWith('Google refused the sign-in code: 400 unexpected error code');
    } finally {
      warn.mockRestore();
    }
  });

  it('when Google replies with something other than JSON', async () => {
    const { cookie, state } = await begin();
    tokenReply = () => new Response('<html>busy</html>', { status: 200 });
    expectRefused(await callback({ code: 'c', state }, cookie), 'google_failed');
  });

  it('when Google cannot be reached', async () => {
    const { cookie, state } = await begin();
    tokenReply = () => { throw new TypeError('network down'); };
    expectRefused(await callback({ code: 'c', state }, cookie), 'google_failed');
  });
});

describe('canceling at Google', () => {
  it('returns home with no session and clears the login cookie', async () => {
    const { cookie, state } = await begin();
    const res = await callback({ error: 'access_denied', state }, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');
    expect(cookieLine(res, SESSION_COOKIE)).toBeUndefined();
    expect(cookieLine(res, LOGIN_COOKIE)).toMatch(/Max-Age=0/);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('never redirects anywhere a query names', async () => {
    const res = await callback({ error: 'access_denied', next: 'https://evil.test', redirect: '//evil.test', returnTo: 'https://evil.test' });
    expect(res.headers.get('Location')).toBe('/');
  });
});

describe('signing out', () => {
  it('clears the session cookie', async () => {
    const res = await callWith(GOOGLE, 'POST', '/auth/logout');
    expect(res.status).toBe(200);
    const line = cookieLine(res, SESSION_COOKIE);
    expect(line).toMatch(/Max-Age=0/);
    expect(line).toMatch(/; Path=\/(;|$)/);
    expect(line).toMatch(/; HttpOnly/);
  });

  it('works without Google settings, for the fake login', async () => {
    expect((await callWith({}, 'POST', '/auth/logout')).status).toBe(200);
  });

  it('refuses a cross-origin request and leaves the cookie alone', async () => {
    const res = await callWith(GOOGLE, 'POST', '/auth/logout', { origin: 'http://evil.test' });
    expect(res.status).toBe(403);
    expect(cookieLine(res, SESSION_COOKIE)).toBeUndefined();
  });

  it('refuses a request with no Origin', async () => {
    expect((await callWith(GOOGLE, 'POST', '/auth/logout', { origin: null })).status).toBe(403);
  });

  it('cannot be done by following a link', async () => {
    expect((await callWith(GOOGLE, 'GET', '/auth/logout', { origin: null })).status).toBe(405);
  });
});

describe('config endpoint', () => {
  const config = async (overrides) => {
    const res = await callWith(overrides, 'GET', '/api/config', { origin: null });
    expect(res.status).toBe(200);
    return res.json();
  };

  it('needs no session and reports both logins when they are set up', async () => {
    expect(await config(GOOGLE)).toEqual({ googleLogin: true, devLogin: true, signedIn: false });
  });

  it('reports the fake login off unless DEV_LOGIN is 1', async () => {
    expect(await config({ ...GOOGLE, DEV_LOGIN: undefined })).toEqual({ googleLogin: true, devLogin: false, signedIn: false });
  });

  it('says whether this request carries a valid session', async () => {
    const cookie = await login('sub-config');
    const seen = await callWith(GOOGLE, 'GET', '/api/config', { origin: null, cookie });
    expect((await seen.json()).signedIn).toBe(true);
    const bad = await callWith(GOOGLE, 'GET', '/api/config', { origin: null, cookie: cookie + 'x' });
    expect((await bad.json()).signedIn).toBe(false);
  });

  it('reports the fake login off with no signing key, because it could not work', async () => {
    expect((await config({ SESSION_KEY: '' })).devLogin).toBe(false);
  });

  it.each([
    ['GOOGLE_CLIENT_ID', { ...GOOGLE, GOOGLE_CLIENT_ID: undefined }],
    ['GOOGLE_CLIENT_SECRET', { ...GOOGLE, GOOGLE_CLIENT_SECRET: '' }],
    ['SESSION_KEY', { ...GOOGLE, SESSION_KEY: undefined }],
    ['a long enough SESSION_KEY', { ...GOOGLE, SESSION_KEY: 'short' }],
    ['APP_URL', { ...GOOGLE, APP_URL: undefined }],
    ['a valid APP_URL', { ...GOOGLE, APP_URL: 'not a url' }],
  ])('reports Google login unavailable without %s', async (_name, overrides) => {
    expect((await config(overrides)).googleLogin).toBe(false);
  });
});

describe('with no Google settings', () => {
  it('reports login as unavailable', async () => {
    expect((await callWith({}, 'GET', '/api/config', { origin: null }).then((r) => r.json())).googleLogin).toBe(false);
  });

  it.each([['/auth/login'], ['/auth/callback?code=c&state=s']])('%s says it is not set up, and calls nobody', async (path) => {
    const res = await callWith({}, 'GET', path, { origin: null });
    expect(res.status).toBe(503);
    expect(cookiesOf(res)).toEqual([]);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('changes nothing else', async () => {
    expect((await callWith({}, 'GET', '/api/progress')).status).toBe(401);
    const login = await callWith({}, 'POST', '/auth/dev-login', { body: { sub: 'x' } });
    expect(login.status).toBe(200);
  });
});
