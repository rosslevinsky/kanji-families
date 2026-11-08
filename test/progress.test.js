import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { LIMITS, totalsOf } from '../public/merge.js';
import { MAX_PROGRESS_BYTES } from '../src/progress.js';
import { SESSION_COOKIE, signSession } from '../src/session.js';
import { answers, baseEnv, call, callWith, login, racingDb, request, review, row, store } from './helpers/api.js';
import worker from '../src/worker.js';

const put = (cookie, body, options = {}) => call('PUT', options.path || '/api/progress', { cookie, body, ...options });
const count = (progress) => totalsOf(progress).scores.reading.n;

// Keys near the longest allowed, so a store gets large with few entries.
function bigSrs(prefix, n) {
  const out = {};
  for (let i = 0; i < n; i++) out[`reading:${prefix}${String(i).padStart(60, '0')}`] = { b: 1, d: 2e12, r: 1e12 };
  return out;
}

describe('reading progress', () => {
  it('needs a session', async () => {
    const res = await call('GET', '/api/progress');
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('not_signed_in');
  });

  it('gives a new account an empty store and an opaque, stable account ID', async () => {
    const a = await login('sub-a');
    const res = await call('GET', '/api/progress', { cookie: a });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(0);
    expect(body.progress).toEqual(store());
    expect(body.account).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.account).not.toContain('sub-a');
    const again = await (await call('GET', '/api/progress', { cookie: await login('sub-a') })).json();
    expect(again.account).toBe(body.account);
    const other = await (await call('GET', '/api/progress', { cookie: await login('sub-b') })).json();
    expect(other.account).not.toBe(body.account);
  });

  it('marks responses as private and not to be sniffed', async () => {
    const res = await call('GET', '/api/progress');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

describe('sessions', () => {
  it('refuses a tampered cookie', async () => {
    const good = await login('sub-a');
    const [name, value] = good.split('=');
    const [payload, signature] = value.split('.');
    const forged = btoa(JSON.stringify({ sub: 'sub-b', iat: Date.now(), exp: Date.now() + 1e6 })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    for (const bad of [`${name}=${forged}.${signature}`, `${name}=${payload}.AAAA${signature.slice(4)}`, `${name}=${payload}`, `${name}=...`, `${name}=`]) {
      expect((await call('GET', '/api/progress', { cookie: bad })).status).toBe(401);
    }
  });

  it('refuses an expired session, and a session signed with another key', async () => {
    const now = Date.now();
    const expired = await signSession(baseEnv(), { sub: 'sub-a', iat: now - 1000, exp: now - 1 });
    expect((await call('GET', '/api/progress', { cookie: `${SESSION_COOKIE}=${expired}` })).status).toBe(401);
    const foreign = await signSession({ SESSION_KEY: 'a-completely-different-session-key-here' }, { sub: 'sub-a', iat: now, exp: now + 1e6 });
    expect((await call('GET', '/api/progress', { cookie: `${SESSION_COOKIE}=${foreign}` })).status).toBe(401);
  });

  it('refuses every session when the signing key is missing or too short', async () => {
    const a = await login('sub-a');
    for (const SESSION_KEY of [undefined, '', 'short']) {
      expect((await callWith({ SESSION_KEY }, 'GET', '/api/progress', { cookie: a })).status).toBe(401);
    }
  });

  it('sets the cookie HttpOnly and Lax, and Secure only on https', async () => {
    const plain = (await call('POST', '/auth/dev-login', { body: { sub: 'x' } })).headers.get('Set-Cookie');
    expect(plain).toMatch(/HttpOnly/);
    expect(plain).toMatch(/SameSite=Lax/);
    expect(plain).toMatch(/Path=\//);
    expect(plain).toMatch(/Max-Age=7776000/);
    expect(plain).not.toMatch(/Secure/);
    const secure = (await worker.fetch(
      new Request('https://site.test/auth/dev-login', { method: 'POST', headers: { Origin: 'https://site.test' }, body: '{}' }),
      { ...baseEnv(), APP_URL: 'https://site.test' },
    )).headers.get('Set-Cookie');
    expect(secure).toMatch(/Secure/);
  });
});

describe('saving progress', () => {
  it('merges with what is stored and returns the merged result', async () => {
    const a = await login('sub-a');
    const first = await put(a, store({ counters: answers('dev1', 3), srs: review('x', 100) }));
    expect(first.status).toBe(200);
    expect((await first.json()).version).toBe(1);
    const second = await (await put(a, store({ counters: answers('dev2', 4), srs: review('x', 50) }))).json();
    expect(second.version).toBe(2);
    expect(count(second.progress)).toBe(7);
    expect(second.progress.srs['reading:x'].r).toBe(100);
    const read = await (await call('GET', '/api/progress', { cookie: a })).json();
    expect({ account: read.account, version: read.version, progress: read.progress })
      .toEqual({ account: second.account, version: second.version, progress: second.progress });
  });

  it('does not store the device field', async () => {
    const a = await login('sub-a');
    const body = await (await put(a, store({ device: 'dev1', counters: answers('dev1', 1) }))).json();
    expect(body.progress.device).toBeUndefined();
    expect(JSON.parse((await row('sub-a')).data).device).toBeUndefined();
  });

  it('writes nothing when a save changes nothing', async () => {
    const a = await login('sub-a');
    const blank = await (await put(a, store())).json();
    expect(blank.version).toBe(0);
    expect(await row('sub-a')).toBeNull();
    await put(a, store({ counters: answers('dev1', 2) }));
    const again = await (await put(a, store({ counters: answers('dev1', 2) }))).json();
    expect(again.version).toBe(1);
    expect((await row('sub-a')).version).toBe(1);
  });

  it('keeps a newer generation over an older one', async () => {
    const a = await login('sub-a');
    await put(a, store({ gen: { t: 5, id: 'new' }, counters: answers('dev1', 1) }));
    const body = await (await put(a, store({ counters: answers('old', 9) }))).json();
    expect(body.progress.gen.id).toBe('new');
    expect(count(body.progress)).toBe(1);
  });

  it('with the adoption flag, joins data into the account whatever its generation', async () => {
    const a = await login('sub-a');
    await put(a, store({ gen: { t: 5, id: 'new' }, counters: answers('dev1', 1) }));
    const body = await (await put(a, store({ counters: answers('anon', 9) }), { path: '/api/progress?adopt=1' })).json();
    expect(body.progress.gen.id).toBe('new');
    expect(count(body.progress)).toBe(10);
  });

  it('adoption into an account with no row keeps the data', async () => {
    const a = await login('sub-a');
    const body = await (await put(a, store({ gen: { t: 9, id: 'anon' }, counters: answers('anon', 2) }), { path: '/api/progress?adopt=1' })).json();
    expect(body.progress.gen).toEqual({ t: 0, id: '0' });
    expect(count(body.progress)).toBe(2);
  });

  it('keeps each user to their own row', async () => {
    const a = await login('sub-a'), b = await login('sub-b');
    await put(a, store({ counters: answers('deva', 1) }));
    await put(b, store({ counters: answers('devb', 2) }));
    const readA = await (await call('GET', '/api/progress', { cookie: a })).json();
    const readB = await (await call('GET', '/api/progress', { cookie: b })).json();
    expect(Object.keys(readA.progress.counters)).toEqual(['deva']);
    expect(Object.keys(readB.progress.counters)).toEqual(['devb']);
  });
});

describe('simultaneous saves', () => {
  it('keeps both when sent at once', async () => {
    const a = await login('sub-a');
    await put(a, store({ counters: answers('start', 1) }));
    const results = await Promise.all([
      put(a, store({ counters: answers('dev1', 2) })),
      put(a, store({ counters: answers('dev2', 3) })),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const read = await (await call('GET', '/api/progress', { cookie: a })).json();
    expect(count(read.progress)).toBe(6);
  });

  it('keeps both when another save lands between the read and the write', async () => {
    const a = await login('sub-a');
    await put(a, store({ counters: answers('start', 1) }));
    const DB = racingDb(() => put(a, store({ counters: answers('other', 2) })));
    const res = await callWith({ DB }, 'PUT', '/api/progress', { cookie: a, body: store({ counters: answers('mine', 3) }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(count(body.progress)).toBe(6);
    expect(body.version).toBe(3);
    expect(count(JSON.parse((await row('sub-a')).data))).toBe(6);
  });

  it('keeps both when two first saves race to create the row', async () => {
    const a = await login('sub-a');
    const DB = racingDb(() => put(a, store({ counters: answers('other', 2) })));
    const res = await callWith({ DB }, 'PUT', '/api/progress', { cookie: a, body: store({ counters: answers('mine', 3) }) });
    expect(res.status).toBe(200);
    expect(count((await res.json()).progress)).toBe(5);
  });

  it('gives up after a bounded number of tries with an error the browser can retry', async () => {
    const a = await login('sub-a');
    await put(a, store({ counters: answers('start', 1) }));
    let n = 0;
    const DB = racingDb(() => put(a, store({ counters: answers(`other${++n}`, 1) })), { every: true });
    const res = await callWith({ DB }, 'PUT', '/api/progress', { cookie: a, body: store({ counters: answers('mine', 1) }) });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('busy');
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(n).toBeLessThan(10);
    expect(Object.keys(JSON.parse((await row('sub-a')).data).counters)).not.toContain('mine');
  });
});

describe('refused saves leave the data unchanged', () => {
  async function seeded() {
    const a = await login('sub-a');
    await put(a, store({ counters: answers('dev1', 1) }));
    return { a, before: await row('sub-a') };
  }

  it.each([
    ['not JSON', '{nope'],
    ['an array', '[]'],
    ['a number', '3'],
    ['null', 'null'],
    ['no version', JSON.stringify(store({ v: undefined }))],
    ['an older version', JSON.stringify(store({ v: 2 }))],
    ['a newer version', JSON.stringify(store({ v: 4 }))],
    ['counters of the wrong type', JSON.stringify(store({ counters: [] }))],
    ['a missing review map', JSON.stringify(store({ srs: undefined }))],
    ['a log of the wrong type', JSON.stringify(store({ log: {} }))],
    ['tests of the wrong type', JSON.stringify(store({ tests: 'x' }))],
    ['a generation of the wrong type', JSON.stringify(store({ gen: 1 }))],
    ['deeply nested JSON', '['.repeat(400000)],
  ])('a malformed save: %s', async (_name, body) => {
    const { a, before } = await seeded();
    const res = await put(a, body);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_progress');
    expect(await row('sub-a')).toEqual(before);
  });

  it('refuses invalid UTF-8', async () => {
    const { a, before } = await seeded();
    const stream = new Blob([new Uint8Array([0x7b, 0xff, 0x7d])]).stream();
    const res = await worker.fetch(request('PUT', '/api/progress', { cookie: a, body: stream }), baseEnv());
    expect(res.status).toBe(400);
    expect(await row('sub-a')).toEqual(before);
  });

  it('an oversized save, by its declared length', async () => {
    const { a, before } = await seeded();
    const res = await put(a, 'x'.repeat(MAX_PROGRESS_BYTES + 1));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('too_large');
    expect(await row('sub-a')).toEqual(before);
  });

  it('an oversized save with no declared length, by its actual bytes', async () => {
    const { a, before } = await seeded();
    const stream = new Blob(['x'.repeat(MAX_PROGRESS_BYTES + 1)]).stream();
    const req = request('PUT', '/api/progress', { cookie: a, body: stream });
    expect(req.headers.get('Content-Length')).toBeNull();
    const res = await worker.fetch(req, baseEnv());
    expect(res.status).toBe(413);
    expect(await row('sub-a')).toEqual(before);
  });

  it('refuses by the declared length without reading the body', async () => {
    const { a } = await seeded();
    let pulled = false;
    const stream = new ReadableStream({ pull(c) { pulled = true; c.close(); } }, { highWaterMark: 0 });
    const req = request('PUT', '/api/progress', { cookie: a, body: stream, headers: { 'Content-Length': String(MAX_PROGRESS_BYTES + 1) } });
    const res = await worker.fetch(req, baseEnv());
    expect(res.status).toBe(413);
    expect(pulled).toBe(false);
  });

  it('two valid saves whose merged result is over the cap', async () => {
    const a = await login('sub-a');
    const first = store({ srs: bigSrs('a', 6000) }), second = store({ srs: bigSrs('b', 6000) });
    expect(JSON.stringify(first).length).toBeLessThan(MAX_PROGRESS_BYTES);
    expect(JSON.stringify(second).length).toBeLessThan(MAX_PROGRESS_BYTES);
    expect(LIMITS.srs).toBeLessThan(12000);
    expect((await put(a, first)).status).toBe(200);
    const before = await row('sub-a');
    const res = await put(a, second);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('progress_too_large');
    expect(await row('sub-a')).toEqual(before);
  });

  it('a retry that would go over the cap, even though the first try fit', async () => {
    const a = await login('sub-a');
    await put(a, store({ srs: bigSrs('a', 3200) }));
    let racerStatus;
    const DB = racingDb(async () => { racerStatus = (await put(a, store({ srs: bigSrs('r', 3200) }))).status; });
    const res = await callWith({ DB }, 'PUT', '/api/progress', { cookie: a, body: store({ srs: bigSrs('b', 3200) }) });
    expect(racerStatus).toBe(200);
    expect(res.status).toBe(413);
    const stored = await row('sub-a');
    expect(stored.version).toBe(2);
    expect(Object.keys(JSON.parse(stored.data).srs).some((k) => k.startsWith('reading:b'))).toBe(false);
  });

  it.each([
    ['another origin', 'http://evil.test'],
    ['a different scheme', 'https://app.test'],
    ['a different port', 'http://app.test:8080'],
    ['the null origin', 'null'],
  ])('a write from %s', async (_name, origin) => {
    const { a, before } = await seeded();
    const res = await put(a, store({ counters: answers('evil', 9) }), { origin });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('bad_origin');
    expect((await call('DELETE', '/api/progress', { cookie: a, origin })).status).toBe(403);
    expect(await row('sub-a')).toEqual(before);
  });

  it('a write with no Origin header', async () => {
    const { a, before } = await seeded();
    const req = new Request('http://app.test/api/progress', { method: 'PUT', headers: { Cookie: a }, body: JSON.stringify(store()) });
    expect((await worker.fetch(req, baseEnv())).status).toBe(403);
    expect(await row('sub-a')).toEqual(before);
  });

  it('a write when APP_URL is missing or invalid', async () => {
    const { a, before } = await seeded();
    for (const APP_URL of [undefined, 'not a url']) {
      expect((await callWith({ APP_URL }, 'PUT', '/api/progress', { cookie: a, body: store() })).status).toBe(403);
    }
    expect(await row('sub-a')).toEqual(before);
  });

  it('a save without a session', async () => {
    const res = await put(undefined, store({ counters: answers('dev1', 1) }));
    expect(res.status).toBe(401);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM progress').first()).n).toBe(0);
  });
});

describe('routing', () => {
  it('answers unknown paths and methods with errors, without caching', async () => {
    expect((await call('GET', '/api/nothing')).status).toBe(404);
    const res = await call('POST', '/api/progress');
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toContain('GET');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

});

describe('what the browser needs to sync', () => {
  it('reports the server time on reads and saves', async () => {
    const a = await login('sub-time');
    const before = Date.now();
    const read = await (await call('GET', '/api/progress', { cookie: a })).json();
    const saved = await (await put(a, store({ counters: answers('dev1', 1) }))).json();
    expect(read.serverTime).toBeGreaterThanOrEqual(before);
    expect(saved.serverTime).toBeGreaterThanOrEqual(read.serverTime);
    expect(saved.serverTime).toBeLessThanOrEqual(Date.now());
  });

  it('refuses a save meant for another account, before reading or changing anything', async () => {
    const a = await login('sub-owner-a'), b = await login('sub-owner-b');
    const accountA = (await (await call('GET', '/api/progress', { cookie: a })).json()).account;
    const res = await put(b, store({ counters: answers('dev1', 3) }), { path: `/api/progress?account=${accountA}` });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('wrong_account');
    expect(await row('sub-owner-b')).toBeNull();
    const adopted = await put(b, store({ counters: answers('dev1', 3) }), { path: `/api/progress?adopt=1&account=${accountA}` });
    expect(adopted.status).toBe(409);
    expect(await row('sub-owner-b')).toBeNull();
    const own = await put(a, store({ counters: answers('dev1', 3) }), { path: `/api/progress?account=${accountA}` });
    expect(own.status).toBe(200);
    expect(count((await own.json()).progress)).toBe(3);
  });
});
