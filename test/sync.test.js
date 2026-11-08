import { afterEach, describe, expect, it, vi } from 'vitest';
import { blankStore, clearedStore, recordAnswer, totalsOf } from '../public/merge.js';
import { CLOSE_SAVE_LIMIT, canSaveOnClose, cleanSync, createSync, epochAfter, epochOf, isEmptyStore, isDeletedElsewhere, loginOutcome, mergeResponse, saveBody, withoutSync } from '../public/sync.js';

const copy = (device = 'dev1', sync, answers = 0) => {
  const s = { ...blankStore(), device };
  for (let i = 0; i < answers; i++) recordAnswer(s, 'reading', '清', true, 1000 + i);
  if (sync) s.sync = sync;
  return s;
};
const reply = (progress = blankStore(), fields = {}) => ({ account: 'acct-a', version: 1, progress, serverTime: 5000, deletedAt: null, ...fields });
const count = (s) => totalsOf(s).scores.reading.n;

describe('what a login does to the browser copy', () => {
  it('adopts an ownerless copy with data', () => {
    expect(loginOutcome(copy('d', null, 1), reply())).toBe('adopt');
  });

  it('has nothing to adopt from an empty ownerless copy', () => {
    expect(loginOutcome(copy(), reply())).toBe('fresh');
    expect(isEmptyStore(copy())).toBe(true);
    expect(isEmptyStore(copy('d', null, 1))).toBe(false);
  });

  it('resumes when the owner matches', () => {
    expect(loginOutcome(copy('d', { owner: 'acct-a', syncedAt: 4000, dirty: true }, 1), reply())).toBe('resume');
  });

  it('removes a copy owned by another account, whatever it holds', () => {
    expect(loginOutcome(copy('d', { owner: 'acct-b', syncedAt: 4000, dirty: true }, 1), reply())).toBe('foreign');
  });

  it('drops an owned copy last synced before a deletion', () => {
    const owned = copy('d', { owner: 'acct-a', syncedAt: 4000, dirty: true }, 1);
    expect(loginOutcome(owned, reply(blankStore(), { deletedAt: 4500 }))).toBe('deleted');
    expect(loginOutcome(owned, reply(blankStore(), { deletedAt: 4000 }))).toBe('deleted');
  });

  it('keeps an owned copy last synced after a deletion', () => {
    const owned = copy('d', { owner: 'acct-a', syncedAt: 4000, dirty: true }, 1);
    expect(isDeletedElsewhere(owned, reply(blankStore(), { deletedAt: 3999 }))).toBe(false);
    expect(loginOutcome(owned, reply(blankStore(), { deletedAt: 3999 }))).toBe('resume');
  });

  it('never drops an ownerless copy over a deletion: nothing in it came from the account', () => {
    expect(loginOutcome(copy('d', null, 1), reply(blankStore(), { deletedAt: 4500 }))).toBe('adopt');
  });

  it('treats another account\'s copy as foreign even when this account has a deletion on record', () => {
    expect(loginOutcome(copy('d', { owner: 'acct-b', syncedAt: 1, dirty: false }, 1), reply(blankStore(), { deletedAt: 4500 }))).toBe('foreign');
  });
});

describe('merging a server reply into the browser copy', () => {
  it('keeps answers made while the save was in flight, and stays marked unsaved', () => {
    const sent = copy('d', { owner: 'acct-a', syncedAt: 1, dirty: true }, 1);
    const server = saveBody(sent);
    const now = JSON.parse(JSON.stringify(sent));
    recordAnswer(now, 'reading', '晴', true, 2000);
    const next = mergeResponse(now, reply(JSON.parse(server)));
    expect(count(next)).toBe(2);
    expect(next.sync).toEqual({ owner: 'acct-a', syncedAt: 5000, dirty: true });
    expect(next.device).toBe('d');
  });

  it('is clean when the server holds everything here', () => {
    const sent = copy('d', { owner: 'acct-a', syncedAt: 1, dirty: true }, 1);
    const next = mergeResponse(sent, reply(JSON.parse(saveBody(sent))));
    expect(next.sync.dirty).toBe(false);
  });

  it('takes a newer generation from the server and drops older local answers', () => {
    const sent = copy('d', { owner: 'acct-a', syncedAt: 1, dirty: true }, 3);
    const next = mergeResponse(sent, reply({ ...blankStore(), gen: { t: 9, id: 'g' } }));
    expect(next.gen).toEqual({ t: 9, id: 'g' });
    expect(count(next)).toBe(0);
    expect(next.sync.dirty).toBe(false);
  });

  it('joins an ownerless copy to the account generation when adopting, keeping answers made meanwhile', () => {
    const anon = { ...copy('d', null, 2), gen: { t: 99, id: 'anon' } };
    const next = mergeResponse(anon, reply({ ...blankStore(), gen: { t: 5, id: 'acct' } }));
    expect(next.gen).toEqual({ t: 5, id: 'acct' });
    expect(count(next)).toBe(2);
    expect(next.sync.owner).toBe('acct-a');
    expect(next.sync.dirty).toBe(true);
  });

  it('never lets the recorded sync time go backward', () => {
    const owned = copy('d', { owner: 'acct-a', syncedAt: 9000, dirty: false });
    expect(mergeResponse(owned, reply()).sync.syncedAt).toBe(9000);
  });

  it('returns null rather than mix a reply for another account into this copy', () => {
    expect(mergeResponse(copy('d', { owner: 'acct-b', syncedAt: 1, dirty: true }, 1), reply())).toBeNull();
  });
});

describe('what is saved', () => {
  it('sends neither the device ID field nor the local sync state', () => {
    const body = JSON.parse(saveBody(copy('d', { owner: 'acct-a', syncedAt: 1, dirty: true }, 1)));
    expect(body).not.toHaveProperty('sync');
    expect(body).not.toHaveProperty('device');
    expect(Object.keys(body.counters)).toEqual(['d']); // counters stay per device
  });

  it('keeps the account ID out of a backup', () => {
    expect(withoutSync(copy('d', { owner: 'acct-a', syncedAt: 1, dirty: true }))).not.toHaveProperty('sync');
  });

  it('keeps the epoch out of a save and a backup', () => {
    const owned = { ...copy('d', { owner: 'acct-a', syncedAt: 1, dirty: true }, 1), epoch: 'e1' };
    expect(JSON.parse(saveBody(owned))).not.toHaveProperty('epoch');
    expect(withoutSync(owned)).not.toHaveProperty('epoch');
  });

  it('allows a save during page close only under the browser limit, counting bytes', () => {
    expect(CLOSE_SAVE_LIMIT).toBe(60 * 1024);
    expect(canSaveOnClose('x'.repeat(CLOSE_SAVE_LIMIT - 1))).toBe(true);
    expect(canSaveOnClose('x'.repeat(CLOSE_SAVE_LIMIT))).toBe(false);
    expect(canSaveOnClose('清'.repeat(CLOSE_SAVE_LIMIT / 2))).toBe(false); // 3 bytes each
  });
});

describe('reading the stored sync state', () => {
  it('keeps only well-formed values', () => {
    expect(cleanSync({ owner: 'acct-a', syncedAt: 7, dirty: true, extra: 1 })).toEqual({ owner: 'acct-a', syncedAt: 7, dirty: true });
    expect(cleanSync({ owner: 'acct-a' })).toEqual({ owner: 'acct-a', syncedAt: 0, dirty: false });
    for (const bad of [null, undefined, 'x', [], {}, { owner: 7 }, { owner: '' }]) expect(cleanSync(bad)).toBeNull();
  });
});

describe('when the epoch is replaced', () => {
  const owned = { ...copy('d', { owner: 'acct-a', syncedAt: 1, dirty: false }), epoch: 'old' };
  const anon = { ...copy('d'), epoch: 'old' };
  const fresh = () => 'new';

  it('on removal, even of an ownerless copy', () => {
    expect(epochAfter(owned, copy('e'), 'removed', fresh)).toBe('new');
    expect(epochAfter(anon, copy('e'), 'removed', fresh)).toBe('new');
  });

  it('when the owner changes, in either direction', () => {
    expect(epochAfter(anon, owned, true, fresh)).toBe('new');
    expect(epochAfter(owned, anon, true, fresh)).toBe('new');
  });

  it('when a generation is reset locally, but not when a reply brings a newer one', () => {
    const cleared = { ...owned, gen: { t: 9, id: 'g' } };
    expect(epochAfter(owned, cleared, false, fresh)).toBe('new');
    expect(epochAfter(owned, cleared, true, fresh)).toBe('old');
  });

  it('not for an answer or a reply within the same copy', () => {
    expect(epochAfter(owned, { ...owned }, false, fresh)).toBe('old');
    expect(epochAfter(owned, { ...owned }, true, fresh)).toBe('old');
    expect(epochAfter(copy('d'), copy('d'), false, fresh)).toBeNull();
  });
});

// The engine against a stand-in page: a store with a real lock queue and a scripted server.
const answerTotal = (c) => c.log.length;

function harness(initial, respond) {
  let stored = initial, tail = Promise.resolve(), n = 0;
  const h = {
    requests: [], notices: [], held: false,
    get copy() { return stored; },
    // A change made through the lock, by this tab or another.
    change(fn, fromServer = false) { return lock(() => apply(fn, fromServer)); },
    removeElsewhere() { return h.change(() => copy(`dev${++n}`), 'removed'); },
    answerElsewhere() { return h.change((c) => { recordAnswer(c, 'reading', '清', true, 3000 + n++); return c; }); },
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  function apply(fn, fromServer) {
    const was = stored, fresh = clone(stored), next = fn(fresh);
    if (!next) return;
    if (!fromServer && was.sync) next.sync = { ...was.sync, dirty: true };
    const epoch = epochAfter(was, next, fromServer, () => `epoch-${++n}`);
    if (epoch) next.epoch = epoch; else delete next.epoch;
    stored = next;
  }
  function lock(work) {
    const run = tail.then(work);
    tail = run.catch(() => {});
    return run;
  }
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener() {} });
  vi.stubGlobal('window', { addEventListener() {} });
  vi.stubGlobal('setInterval', () => 0);
  vi.stubGlobal('fetch', async (url, init = {}) => {
    const req = { method: init.method || 'GET', url, heldLock: h.held, body: init.body };
    h.requests.push(req);
    const res = await respond(req, h);
    return res === 'offline' ? Promise.reject(new TypeError('offline')) : new Response(JSON.stringify(res.body ?? {}), { status: res.status ?? 200 });
  });
  const removal = (applies) => { let removed = false; return lock(() => { if (!applies || applies(stored)) { removed = true; apply(() => copy(`dev${++n}`), 'removed'); } }).then(() => removed); };
  h.sync = createSync({
    read: () => clone(stored),
    write: (fn) => h.change(fn, true),
    drop: removal,
    dropHeld: () => apply(() => copy(`dev${++n}`), 'removed'),
    exclusive: async (work) => { if (h.beforeLock) { const hook = h.beforeLock; h.beforeLock = null; await hook(); } return lock(async () => { h.held = true; try { return await work(); } finally { h.held = false; } }); },
    changed() {},
    notify: (kind) => h.notices.push(kind),
  });
  return h;
}

// A promise and the means to settle it, for holding a reply open.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const dirtyOwned = (answers = 1, owner = 'acct-a') => ({ ...copy('d', { owner, syncedAt: 4000, dirty: true }, answers), epoch: 'e1' });
const serverReply = (progress, fields = {}) => ({ body: { account: 'acct-a', version: 1, progress, serverTime: 5000, deletedAt: null, ...fields } });
const within = (promise) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error('did not settle')), 2000))]);
const puts = (h) => h.requests.filter((r) => r.method === 'PUT');

describe('the sync engine', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('deleting', () => {
    it('a late delete reply leaves the copy of a sign-in made since', async () => {
      const h = harness(dirtyOwned(), async (req, self) => {
        if (req.method === 'DELETE') {
          await self.change((c) => {
            recordAnswer(c, 'reading', '清', true, 9000);
            c.sync = { ...c.sync, syncedAt: c.sync.syncedAt + 1000, dirty: true };
            return c;
          }, true);
          return { body: { deleted: true } };
        }
        return { body: serverReply(blankStore()).body };
      });
      await h.sync.deleteAccount();
      expect(answerTotal(h.copy)).toBeGreaterThan(0);
      expect(h.notices).not.toContain('delete_done');
    });

    it('always names the account the page shows', async () => {
      const h = harness(dirtyOwned(), () => ({ body: { deleted: true } }));
      expect(await h.sync.deleteAccount()).toBe('done');
      expect(h.requests[0].method).toBe('DELETE');
      expect(h.requests[0].url).toBe('/api/progress?account=acct-a');
      expect(h.copy.sync).toBeUndefined();
    });

    it('removes nothing on a mismatch, then settles who owns the copy', async () => {
      const h = harness(dirtyOwned(), (req) => (req.method === 'DELETE' ? { status: 409, body: { code: 'wrong_account' } } : serverReply(blankStore(), { account: 'acct-b' })));
      expect(await h.sync.deleteAccount()).toBe('failed');
      expect(h.notices).not.toContain('delete_done');
      expect(h.notices).toContain('foreign'); // the normal rule for another account's session
      expect(puts(h)).toEqual([]);
    });

    it('does not remove a different owner\'s copy when a late reply arrives', async () => {
      const gate = deferred();
      const h = harness(dirtyOwned(), async (req) => (req.method === 'DELETE' ? (await gate.promise, { body: { deleted: true } }) : { status: 401 }));
      const done = h.sync.deleteAccount();
      await h.change(() => ({ ...copy('e', { owner: 'acct-b', syncedAt: 1, dirty: false }, 2) }), true);
      gate.resolve();
      await done;
      expect(h.copy.sync.owner).toBe('acct-b');
      expect(h.notices).not.toContain('delete_done');
    });
  });

  describe('a reply outstanding when the copy changes', () => {
    it('cannot restore a removed copy', async () => {
      const gate = deferred();
      const first = dirtyOwned(3);
      const h = harness(first, async (req) => {
        if (req.method === 'PUT') { await gate.promise; return serverReply(JSON.parse(saveBody(first))); }
        return { status: 401 };
      });
      const saving = h.sync.save();
      await vi.waitFor(() => expect(puts(h)).toHaveLength(1));
      await h.removeElsewhere();
      gate.resolve();
      await within(saving);
      expect(count(h.copy)).toBe(0);
      expect(h.copy.sync).toBeUndefined();
    });

    it('cannot restore a copy removed and signed back in to the same account', async () => {
      const gate = deferred();
      const first = dirtyOwned(3);
      const h = harness(first, async (req) => {
        if (req.method === 'PUT') { await gate.promise; return serverReply(JSON.parse(saveBody(first))); }
        return serverReply(blankStore());
      });
      const saving = h.sync.save();
      await vi.waitFor(() => expect(puts(h)).toHaveLength(1));
      await h.removeElsewhere();
      await h.change((c) => ({ ...c, sync: { owner: 'acct-a', syncedAt: 6000, dirty: false } }), true);
      gate.resolve();
      await within(saving);
      expect(count(h.copy)).toBe(0);
    });

    it('cannot bring back answers a local clear removed', async () => {
      const gate = deferred();
      const first = dirtyOwned(3);
      const h = harness(first, async (req) => {
        if (req.method === 'PUT' && puts(h).length === 1) { await gate.promise; return serverReply(JSON.parse(saveBody(first))); }
        return { status: 200, body: { account: 'acct-a', version: 2, progress: JSON.parse(saveBody(h.copy)), serverTime: 6000, deletedAt: null } };
      });
      const saving = h.sync.save();
      await vi.waitFor(() => expect(puts(h)).toHaveLength(1));
      await h.change((c) => clearedStore(c, 9000, 'cleared'));
      gate.resolve();
      await within(saving);
      expect(count(h.copy)).toBe(0);
      expect(h.copy.gen.id).toBe('cleared');
    });

    it('does not let a late refusal remove the copy that replaced it', async () => {
      const gate = deferred();
      const h = harness(dirtyOwned(), async (req) => {
        if (req.method === 'PUT') { await gate.promise; return { status: 410 }; }
        return serverReply(JSON.parse(saveBody(h.copy)), { account: 'acct-b' });
      });
      const saving = h.sync.save();
      await vi.waitFor(() => expect(puts(h)).toHaveLength(1));
      await h.change(() => copy('e', { owner: 'acct-b', syncedAt: 1, dirty: false }, 2), true);
      gate.resolve();
      await within(saving);
      expect(h.copy.sync.owner).toBe('acct-b');
      expect(count(h.copy)).toBe(2);
    });

    it('ignores a read that started before another tab signed in and out', async () => {
      const gate = deferred();
      let reads = 0;
      const h = harness(copy('d'), async (req) => {
        if (req.url === '/api/config') return { body: { signedIn: true } };
        if (++reads === 1) { await gate.promise; return serverReply(blankStore()); }
        return { status: 401 };
      });
      const starting = h.sync.start();
      await vi.waitFor(() => expect(reads).toBe(1));
      await h.change((c) => ({ ...c, sync: { owner: 'acct-z', syncedAt: 1, dirty: false } }), true);
      await h.change(() => copy('e'), 'removed');
      gate.resolve();
      await within(starting);
      expect(h.copy.sync).toBeUndefined();
    });
  });

  describe('saving from an owned copy', () => {
    it('sends the last sync time, and adoption does not', async () => {
      const owned = harness(dirtyOwned(), () => serverReply(JSON.parse(saveBody(dirtyOwned()))));
      await owned.sync.save();
      expect(puts(owned)[0].url).toBe('/api/progress?account=acct-a&since=4000');
      vi.unstubAllGlobals();

      const anon = harness(copy('d', null, 1), (req) => (req.url === '/api/config' ? { body: { signedIn: true } } : serverReply(req.method === 'PUT' ? JSON.parse(req.body) : blankStore())));
      await anon.sync.start();
      expect(puts(anon)[0].url).toBe('/api/progress?adopt=1&account=acct-a');
    });

    it('drops itself on a refusal and keeps a session that is still good', async () => {
      const h = harness(dirtyOwned(3), (req) => (req.method === 'PUT' ? { status: 410 } : serverReply(blankStore(), { serverTime: 7000, deletedAt: 6000 })));
      await within(h.sync.save());
      expect(count(h.copy)).toBe(0);
      expect(h.copy.sync.owner).toBe('acct-a');
      expect(h.copy.sync.syncedAt).toBe(7000);
      expect(h.notices).toEqual(['deleted']);
      expect(h.requests.some((r) => r.url === '/auth/logout')).toBe(false);
      expect(h.sync.status.state).toBe('active');
    });

    it('ends the session too when the session itself is refused', async () => {
      const h = harness(dirtyOwned(3), (req) => (req.url === '/auth/logout' ? {} : { status: 410 }));
      await within(h.sync.save());
      expect(count(h.copy)).toBe(0);
      expect(h.copy.sync).toBeUndefined();
      await vi.waitFor(() => expect(h.requests.some((r) => r.url === '/auth/logout')).toBe(true));
      expect(h.sync.status.state).toBe('anon');
    });
  });

  describe('recovery during a save', () => {
    it('settles when a mismatch sends the save back through connect with the copy still unsaved', async () => {
      let refused = false;
      const h = harness(dirtyOwned(2), (req) => {
        if (req.method === 'PUT' && !refused) { refused = true; return { status: 409 }; }
        if (req.method === 'PUT') return serverReply(JSON.parse(req.body));
        return serverReply(blankStore()); // the account lacks this copy's answers, so it stays dirty
      });
      await within(h.sync.save());
      expect(puts(h)).toHaveLength(2); // the save scheduled by recovery ran, after the first finished
      expect(h.copy.sync.dirty).toBe(false);
    });

    it('settles sign-out through the same path', async () => {
      let refused = false;
      const h = harness(dirtyOwned(2), (req) => {
        if (req.url === '/auth/logout') return {};
        if (req.method === 'PUT' && !refused) { refused = true; return { status: 409 }; }
        if (req.method === 'PUT') return serverReply(JSON.parse(req.body));
        return serverReply(blankStore());
      });
      expect(await within(h.sync.signOut())).toBe('done');
    });
  });

  describe('signing out', () => {
    it('logs out and removes while holding the lock, so another tab\'s answer waits and finds the new epoch', async () => {
      const gate = deferred();
      const owned = { ...copy('d', { owner: 'acct-a', syncedAt: 4000, dirty: false }, 1), epoch: 'e1' };
      const h = harness(owned, async (req) => {
        if (req.url === '/auth/logout') { await gate.promise; return {}; }
        return { status: 500 };
      });
      const out = h.sync.signOut();
      await vi.waitFor(() => expect(h.requests.some((r) => r.url === '/auth/logout')).toBe(true));
      expect(h.requests.find((r) => r.url === '/auth/logout').heldLock).toBe(true);

      let seenEpoch;
      const answering = h.change((c) => { seenEpoch = epochOf(c); return null; });
      gate.resolve();
      expect(await out).toBe('done');
      await answering;
      expect(seenEpoch).not.toBe('e1');
      expect(h.copy.sync).toBeUndefined();
    });

    it('saves again when an answer arrives between the save and the lock', async () => {
      const h = harness(dirtyOwned(1), (req) => (req.url === '/auth/logout' ? {} : serverReply(JSON.parse(req.body))));
      h.beforeLock = () => h.answerElsewhere(); // after the flush has finished, before the lock is held
      expect(await within(h.sync.signOut())).toBe('done');
      expect(puts(h)).toHaveLength(2);
      expect(count(JSON.parse(puts(h)[1].body))).toBe(2);
      expect(h.requests.at(-1).url).toBe('/auth/logout');
    });

    it('warns after a bounded number of tries when answers keep arriving', async () => {
      const h = harness(dirtyOwned(1), async (req, self) => {
        if (req.url === '/auth/logout') throw new Error('must not log out');
        const body = serverReply(JSON.parse(req.body));
        await self.answerElsewhere();
        return body;
      });
      expect(await within(h.sync.signOut())).toBe('unsaved');
      expect(h.requests.some((r) => r.url === '/auth/logout')).toBe(false);
      expect(h.copy.sync.owner).toBe('acct-a');
    });

    it('keeps the copy when logout fails', async () => {
      const owned = { ...copy('d', { owner: 'acct-a', syncedAt: 4000, dirty: false }, 1), epoch: 'e1' };
      const h = harness(owned, () => 'offline');
      expect(await h.sync.signOut()).toBe('failed');
      expect(h.notices).toEqual(['sign_out_failed']);
      expect(count(h.copy)).toBe(1);
      expect(h.copy.epoch).toBe('e1');
    });

    it('holds the lock for a forced sign-out as well', async () => {
      const h = harness(dirtyOwned(1), () => ({}));
      expect(await h.sync.signOut(true)).toBe('done');
      expect(h.requests.map((r) => [r.url, r.heldLock])).toEqual([['/auth/logout', true]]);
      expect(h.copy.sync).toBeUndefined();
    });
  });
});
