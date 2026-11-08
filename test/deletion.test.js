import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { totalsOf } from '../public/merge.js';
import { SESSION_MAX_AGE_MS, SESSION_COOKIE, deletionHash, signSession } from '../src/session.js';
import { answers, baseEnv, call, callWith, login, racingDb, row, store } from './helpers/api.js';

const save = (cookie, n = 1, device = 'dev1') => call('PUT', '/api/progress', { cookie, body: store({ counters: answers(device, n) }) });
const remove = (cookie) => call('DELETE', '/api/progress', { cookie });
const markers = async () => (await env.DB.prepare('SELECT * FROM deletion_markers').all()).results;
const addMarker = (hash, at) => env.DB.prepare('INSERT INTO deletion_markers (sub_hash, deleted_at) VALUES (?, ?)').bind(hash, at).run();

async function expectDropInstruction(res) {
  expect(res.status).toBe(410);
  expect((await res.json()).code).toBe('account_deleted');
}

describe('deleting an account', () => {
  it('removes the row, adds a marker without the sub, and ends the session', async () => {
    const a = await login('sub-a');
    await save(a);
    const res = await remove(a);
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toMatch(/Max-Age=0/);
    expect(await row('sub-a')).toBeNull();
    const [marker] = await markers();
    expect(marker.sub_hash).toBe(await deletionHash(baseEnv(), 'sub-a'));
    expect(JSON.stringify(marker)).not.toContain('sub-a');
  });

  it('leaves other accounts alone', async () => {
    const a = await login('sub-a'), b = await login('sub-b');
    await save(a); await save(b);
    await remove(a);
    expect(await row('sub-b')).not.toBeNull();
    expect((await call('GET', '/api/progress', { cookie: b })).status).toBe(200);
  });

  it('marks an account that has no row yet, so its other devices cannot start one', async () => {
    const first = await login('sub-a');
    const second = await login('sub-a');
    expect((await remove(first)).status).toBe(200);
    await expectDropInstruction(await save(second));
    expect(await row('sub-a')).toBeNull();
  });

  it('needs a session', async () => {
    expect((await remove(undefined)).status).toBe(401);
  });
});

describe('an older session after a deletion', () => {
  it('cannot read, save or delete, and is told to drop its copy', async () => {
    const older = await login('sub-a');
    const deleter = await login('sub-a');
    await save(older);
    await remove(deleter);
    await expectDropInstruction(await save(older, 5));
    await expectDropInstruction(await call('GET', '/api/progress', { cookie: older }));
    await expectDropInstruction(await remove(older));
    expect(await row('sub-a')).toBeNull();
  });

  it('stays refused on repeat, so a browser that missed the first reply still hears it', async () => {
    const older = await login('sub-a');
    await remove(await login('sub-a'));
    await expectDropInstruction(await save(older));
    await expectDropInstruction(await save(older));
  });

  it('is refused when issued in the same millisecond as the deletion', async () => {
    const at = Date.now();
    await addMarker(await deletionHash(baseEnv(), 'sub-a'), at);
    const tied = await signSession(baseEnv(), { sub: 'sub-a', iat: at, exp: at + 1e6 });
    await expectDropInstruction(await save(`${SESSION_COOKIE}=${tied}`));
    const after = await signSession(baseEnv(), { sub: 'sub-a', iat: at + 1, exp: at + 1e6 });
    expect((await save(`${SESSION_COOKIE}=${after}`)).status).toBe(200);
  });

  it('cannot recreate the row when the deletion lands between its read and its first write', async () => {
    const older = await login('sub-a');
    const deleter = await login('sub-a');
    const DB = racingDb(() => remove(deleter));
    await expectDropInstruction(await callWith({ DB }, 'PUT', '/api/progress', { cookie: older, body: store({ counters: answers('dev1', 1) }) }));
    expect(await row('sub-a')).toBeNull();
  });

  it('cannot write into a new row that a later login created at the same version', async () => {
    const older = await login('sub-a');
    await save(older);
    const DB = racingDb(async () => {
      await remove(await login('sub-a'));
      await save(await login('sub-a'), 2, 'fresh');
    });
    await expectDropInstruction(await callWith({ DB }, 'PUT', '/api/progress', { cookie: older, body: store({ counters: answers('stale', 9) }) }));
    expect(Object.keys(JSON.parse((await row('sub-a')).data).counters)).toEqual(['fresh']);
  });
});

describe('logging in after a deletion', () => {
  it('starts empty and works', async () => {
    const a = await login('sub-a');
    await save(a, 5);
    await remove(a);
    const fresh = await login('sub-a');
    const read = await call('GET', '/api/progress', { cookie: fresh });
    expect(read.status).toBe(200);
    const body = await read.json();
    expect(body.version).toBe(0);
    expect(totalsOf(body.progress).scores.reading.n).toBe(0);
    expect((await save(fresh, 1)).status).toBe(200);
  });

  it('works even when the deletion time is at or past this clock reading', async () => {
    await addMarker(await deletionHash(baseEnv(), 'sub-a'), Date.now() + 60000);
    const fresh = await login('sub-a');
    expect((await call('GET', '/api/progress', { cookie: fresh })).status).toBe(200);
  });

  it('a second deletion ends a session issued just after the first', async () => {
    const first = await login('sub-a');
    await remove(first);
    await env.DB.prepare('UPDATE deletion_markers SET deleted_at = ?').bind(Date.now() + 60000).run();
    const second = await login('sub-a');
    expect((await remove(second)).status).toBe(200);
    await expectDropInstruction(await save(second));
    const third = await login('sub-a');
    expect((await save(third)).status).toBe(200);
  });
});

describe('naming the account on a delete', () => {
  const accountOf = async (cookie) => (await (await call('GET', '/api/progress', { cookie })).json()).account;

  it('refuses a mismatch and removes nothing', async () => {
    const a = await login('sub-named-a'), b = await login('sub-named-b');
    await save(b);
    const res = await call('DELETE', `/api/progress?account=${await accountOf(a)}`, { cookie: b });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('wrong_account');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(await row('sub-named-b')).not.toBeNull();
    expect((await markers()).map((m) => m.sub_hash)).not.toContain(await deletionHash(baseEnv(), 'sub-named-b'));
  });

  it('deletes when the account matches', async () => {
    const a = await login('sub-named-c');
    await save(a);
    expect((await call('DELETE', `/api/progress?account=${await accountOf(a)}`, { cookie: a })).status).toBe(200);
    expect(await row('sub-named-c')).toBeNull();
  });
});

describe('a copy older than a deletion, sent with a newer session', () => {
  const put = (cookie, query, device = 'stale', DB) => {
    const options = { cookie, body: store({ counters: answers(device, 9) }) };
    return DB ? callWith({ DB }, 'PUT', `/api/progress?${query}`, options) : call('PUT', `/api/progress?${query}`, options);
  };
  const read = async (cookie) => (await call('GET', '/api/progress', { cookie })).json();

  it('is refused, and writes nothing', async () => {
    const old = await login('sub-since-a');
    const { serverTime } = await (await save(old)).json();
    await remove(await login('sub-since-a'));
    await expectDropInstruction(await put(await login('sub-since-a'), `since=${serverTime}`));
    expect(await row('sub-since-a')).toBeNull();
  });

  it('is refused when the deletion lands between its read and its write', async () => {
    const session = await login('sub-since-race');
    const { serverTime } = await (await save(session)).json();
    await remove(session);
    const fresh = await login('sub-since-race');
    await save(fresh, 1, 'fresh');
    // A later deletion's marker is what the write's own condition has to catch.
    const DB = racingDb(() => env.DB.prepare('UPDATE deletion_markers SET deleted_at = ?').bind(serverTime + 1).run());
    await env.DB.prepare('UPDATE deletion_markers SET deleted_at = ?').bind(serverTime - 1).run();
    await expectDropInstruction(await put(fresh, `since=${serverTime}`, 'stale', DB));
    expect(Object.keys(JSON.parse((await row('sub-since-race')).data).counters)).toEqual(['fresh']);
  });

  it('is accepted once synced after the login that followed the deletion', async () => {
    await remove(await login('sub-since-b'));
    const fresh = await login('sub-since-b');
    const { serverTime } = await read(fresh);
    expect((await put(fresh, `since=${serverTime}`)).status).toBe(200);
    const later = await login('sub-since-b');
    expect((await put(later, `since=${serverTime}`)).status).toBe(200);
  });

  it('cannot use a since later than its session to escape a refusal', async () => {
    const older = await login('sub-since-c');
    await remove(await login('sub-since-c'));
    await expectDropInstruction(await put(older, `since=${Date.now() + 1e7}`));
  });

  it('applies only to a marker: an account with none is not affected', async () => {
    expect((await put(await login('sub-since-d'), 'since=0')).status).toBe(200);
  });

  it('adoption sends no since, so an ownerless copy can join after a deletion', async () => {
    await remove(await login('sub-since-e'));
    expect((await put(await login('sub-since-e'), 'adopt=1')).status).toBe(200);
  });

  it('refuses a since that is not a whole number rather than ignore it', async () => {
    const a = await login('sub-since-f');
    for (const bad of ['abc', '', '1.5', '-1', '1e3', '99999999999999999999']) {
      const res = await put(a, `since=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_since');
    }
    expect(await row('sub-since-f')).toBeNull();
  });
});

describe('old markers', () => {
  it('are removed during a later deletion once older than the longest session', async () => {
    const now = Date.now();
    await addMarker('old', now - SESSION_MAX_AGE_MS - 60000);
    await addMarker('recent', now - SESSION_MAX_AGE_MS + 60000);
    await remove(await login('sub-a'));
    const left = (await markers()).map((m) => m.sub_hash);
    expect(left).not.toContain('old');
    expect(left).toContain('recent');
    expect(left).toContain(await deletionHash(baseEnv(), 'sub-a'));
  });

  it('never outlive a session they must refuse', async () => {
    const now = Date.now();
    const iat = now - SESSION_MAX_AGE_MS + 120000;
    const session = await signSession(baseEnv(), { sub: 'sub-a', iat, exp: iat + SESSION_MAX_AGE_MS });
    await addMarker(await deletionHash(baseEnv(), 'sub-a'), iat + 1);
    await remove(await login('sub-b'));
    await expectDropInstruction(await save(`${SESSION_COOKIE}=${session}`));
  });
});

describe('deletions that overlap other requests', () => {
  const sessionCookie = async (sub, iat) => `${SESSION_COOKIE}=${await signSession(baseEnv(), { sub, iat, exp: iat + SESSION_MAX_AGE_MS })}`;

  it('refuses a login that overlapped the deletion, so it cannot recreate the row', async () => {
    const a = await login('sub-overlap');
    await save(a);
    const overlapping = await sessionCookie('sub-overlap', Date.now() + 1000);
    await remove(a);
    await expectDropInstruction(await save(overlapping));
    expect(await row('sub-overlap')).toBeNull();
  });

  it('a stale delete cannot remove the row of a login made after the deletion', async () => {
    const a = await login('sub-stale');
    await remove(a);
    const fresh = await login('sub-stale');
    await save(fresh);
    await expectDropInstruction(await remove(a));
    expect(await row('sub-stale')).not.toBeNull();
  });

  it('a login after a deletion still works and can delete again', async () => {
    const a = await login('sub-again');
    await remove(a);
    const fresh = await login('sub-again');
    expect((await save(fresh)).status).toBe(200);
    expect((await remove(fresh)).status).toBe(200);
    expect(await row('sub-again')).toBeNull();
  });
});

describe('telling a browser about a deletion it missed', () => {
  const read = async (cookie) => (await call('GET', '/api/progress', { cookie })).json();

  it('reports no deletion for an account that has none', async () => {
    expect((await read(await login('sub-never-deleted'))).deletedAt).toBeNull();
  });

  it('gives a new session the time of the deletion, later than anything the old copy recorded', async () => {
    const old = await login('sub-missed');
    await save(old);
    const syncedAt = (await read(old)).serverTime;
    expect((await remove(await login('sub-missed'))).status).toBe(200);
    const body = await read(await login('sub-missed'));
    expect(body.deletedAt).toBeGreaterThan(syncedAt);
  });

  it('never makes a copy synced after the deletion look older than it', async () => {
    // The marker is placed ahead of the clock, so the server time alone could fall behind it.
    await remove(await login('sub-after'));
    const body = await read(await login('sub-after'));
    expect(body.serverTime).toBeGreaterThan(body.deletedAt);
    const saved = await (await save(await login('sub-after'))).json();
    expect(saved.serverTime).toBeGreaterThan(body.deletedAt);
  });

  it('sees a later deletion even when the last sync used a session dated ahead of the clock', async () => {
    await remove(await login('sub-twice'));
    const first = await login('sub-twice');
    const syncedAt = (await read(first)).serverTime;
    expect((await remove(first)).status).toBe(200);
    expect((await read(await login('sub-twice'))).deletedAt).toBeGreaterThanOrEqual(syncedAt);
  });
});
