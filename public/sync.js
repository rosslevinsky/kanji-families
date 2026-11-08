// Syncing the browser copy with the account: the rules as plain functions, and the engine that
// talks to the API. It never decides what the page shows, and study never waits for it.
//
// The browser copy carries `sync`, {owner, syncedAt, dirty}, in the same stored value as the data,
// so the two always change together. An anonymous copy has none. owner is the account's opaque ID,
// syncedAt is the Worker's time when the copy last matched the account, and dirty means the copy
// may hold something the account doesn't. Merging drops `sync`, like `device`: both are local.
//
// It also carries `epoch`, a random ID for this life of the copy. Every request remembers the epoch
// it started under, and a reply that finds a different one is ignored, so nothing still on its way
// can act on a copy that has since been replaced. It sits beside `sync` rather than inside it because
// an anonymous copy needs one too: signing in and back out in another tab leaves a copy with no
// owner, just as it was, and a reply from before that must still be told apart.
import { adoptAnonymous, cleanStore, mergeStores, sameGeneration } from './merge.js';

// Browsers refuse a keepalive request over 64 KiB, counting all such requests still in flight.
export const CLOSE_SAVE_LIMIT = 60 * 1024;
const encoder = new TextEncoder();

export const SAVE_INTERVAL_MS = 30000;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_FLUSH_ROUNDS = 3;
const MAX_SIGN_OUT_ROUNDS = 3;

export function cleanSync(x) {
  if (!x || typeof x !== 'object' || typeof x.owner !== 'string' || !x.owner) return null;
  return { owner: x.owner, syncedAt: Number.isSafeInteger(x.syncedAt) ? x.syncedAt : 0, dirty: x.dirty === true };
}

export const ownerOf = (copy) => (copy.sync ? copy.sync.owner : null);

export const epochOf = (copy) => copy.epoch || null;

// The epoch a copy has after a change. Replaced when the copy is removed, its owner changes, or a
// generation is reset here, because any reply still on its way then describes data that is gone. A
// newer generation arriving in a reply is the account's own, so it leaves the epoch alone.
export function epochAfter(before, next, fromServer, newEpoch) {
  const replaced = fromServer === 'removed' || ownerOf(before) !== ownerOf(next)
    || (!fromServer && !sameGeneration(before.gen, next.gen));
  return replaced ? newEpoch() : epochOf(before);
}

export function isEmptyStore(s) {
  return !s.log.length && !s.tests.length && !Object.keys(s.srs).length && !Object.keys(s.counters).length;
}

// True when this owned copy last matched the account at or before the account was deleted, while
// this browser's session had already ended, so the server had no way to refuse it. Equal times count:
// a session dated ahead of the clock can record the time a later deletion by that session is given,
// and no copy synced after a deletion can match it, because later sessions are dated after it.
export function isDeletedElsewhere(copy, reply) {
  return reply.deletedAt !== null && reply.deletedAt !== undefined && reply.deletedAt >= copy.sync.syncedAt;
}

// What a login means for this copy. Decided before any save, so another account's data is never sent.
export function loginOutcome(copy, reply) {
  const owner = ownerOf(copy);
  if (owner === null) return isEmptyStore(copy) ? 'fresh' : 'adopt';
  if (owner !== reply.account) return 'foreign';
  return isDeletedElsewhere(copy, reply) ? 'deleted' : 'resume';
}

// Combines a reply into the copy as it is now, so answers made while the request was in flight
// stay. An ownerless copy joins the account's generation, as adoption does; an owned one merges
// normally. Returns null if the reply belongs to a different account from the copy.
export function mergeResponse(copy, reply) {
  const owner = ownerOf(copy);
  if (owner !== null && owner !== reply.account) return null;
  const merged = owner === null ? adoptAnonymous(reply.progress, copy) : mergeStores(copy, reply.progress);
  const before = copy.sync ? copy.sync.syncedAt : 0;
  const dirty = JSON.stringify(merged) !== JSON.stringify(cleanStore(reply.progress));
  return { ...merged, device: copy.device, sync: { owner: reply.account, syncedAt: Math.max(before, reply.serverTime), dirty } };
}

export function withoutSync(copy) {
  const { sync, epoch, ...rest } = copy;
  return rest;
}

export function saveBody(copy) {
  const { sync, epoch, device, ...rest } = copy;
  return JSON.stringify(rest);
}

export const canSaveOnClose = (body) => encoder.encode(body).byteLength < CLOSE_SAVE_LIMIT;

// Returns {status, body}, or {status: 0} if the server couldn't be reached. Never throws.
async function callApi(path, init = {}) {
  try {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
    const res = await fetch(path, { signal, ...init });
    let body = null;
    try { body = await res.json(); } catch (e) {}
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: null };
  }
}

// The page gives this its store: read() returns the latest browser copy, write(change) applies a
// change under the Web Lock and resolves once done, drop(applies) replaces the copy with an empty one
// under a new device ID if applies(copy) is true under the lock, resolving to whether it did, and
// changed() re-renders after any state change. notify(kind) shows a notice. exclusive(work) holds the
// lock while work runs, and dropHeld() is drop for use inside it.
export function createSync({ read, write, drop, dropHeld, exclusive, changed, notify }) {
  // The account state, from what the server last said:
  //   anon     no session, and the copy has no owner
  //   expired  no session, and the copy has an owner
  //   active   signed in and this copy belongs to the session's account
  //   unknown  can't tell yet, or there is a session and the first sync hasn't finished
  const s = { state: 'unknown', google: false, dev: false, problem: null, configLoaded: false };
  let inFlight = null, again = false, starting = null, lastPull = 0, pageClosing = false;

  const set = (fields) => { Object.assign(s, fields); changed(); };
  const isDirty = () => { const { sync } = read(); return !!sync && sync.dirty; };

  const unchangedSince = (epoch) => (copy) => epochOf(copy) === epoch;
  const changedSince = (epoch) => epochOf(read()) !== epoch;

  // Returns whether the copy was removed: not if applies says it has since changed hands.
  async function removeCopy(kind, applies) {
    const removed = await drop(applies);
    if (removed && kind) notify(kind);
    return removed;
  }

  // Saves soon, without waiting for it: this can run as part of the save in flight, which would then
  // be waiting for itself. That save picks this up as one more round.
  function scheduleSave() {
    if (inFlight) again = true;
    else save();
  }

  async function accountWasDeleted(epoch) {
    if (ownerOf(read()) !== null) await removeCopy('deleted', unchangedSince(epoch));
    // A deleted account's session is refused for the rest of its life, so end it here, or every visit
    // would ask again. If this fails, the next visit does the same, and an ownerless copy is left alone.
    callApi('/auth/logout', { method: 'POST' });
    set({ state: 'anon', problem: null });
  }

  function noSession() {
    set({ state: ownerOf(read()) === null ? 'anon' : 'expired', problem: null });
  }

  // Puts a reply into the copy. Returns false if the copy has changed since the request began, or
  // turned out to belong to someone else.
  async function applyReply(reply, epoch) {
    let ok = true;
    await write((copy) => {
      if (epochOf(copy) !== epoch) { ok = false; return null; }
      const next = mergeResponse(copy, reply);
      if (!next) ok = false;
      return next;
    });
    return ok;
  }

  // Reads the account, settles who owns the copy, and saves what the account is missing. Starts over
  // if the copy changed while a request was out, since the reply no longer describes it.
  async function connect() {
    const epoch = epochOf(read());
    const got = await callApi('/api/progress');
    if (changedSince(epoch)) { await connect(); return; }
    if (got.status === 401) { noSession(); return; }
    if (got.status === 410) { await accountWasDeleted(epoch); return; }
    if (got.status !== 200 || !got.body) { set({ problem: 'unreachable' }); return; }
    const reply = got.body;
    lastPull = Date.now();

    let outcome;
    await write((copy) => {
      if (epochOf(copy) !== epoch) { outcome = 'changed'; return null; }
      outcome = loginOutcome(copy, reply);
      return outcome === 'resume' || outcome === 'fresh' ? mergeResponse(copy, reply) : null;
    });
    if (outcome === 'changed') { await connect(); return; }
    if (outcome === 'foreign' || outcome === 'deleted') {
      await removeCopy(outcome, unchangedSince(epoch));
      await connect(); // the empty copy joins the account from a reply that began after it existed
      return;
    }
    if (outcome === 'adopt') {
      // The copy stays ownerless until the account has its data. If the reply is lost, the next try
      // sends it again, and merging takes the highest count per device, so nothing is counted twice.
      const copy = read();
      if (epochOf(copy) !== epoch) { await connect(); return; }
      const sent = await callApi(`/api/progress?adopt=1&account=${encodeURIComponent(reply.account)}`, putInit(saveBody(copy)));
      if (changedSince(epoch)) { await connect(); return; }
      if (sent.status === 401) { noSession(); return; }
      if (sent.status === 410) { await accountWasDeleted(epoch); return; }
      if (sent.status === 413) { set({ problem: 'too_large' }); return; }
      if (sent.status !== 200 || !sent.body) { set({ problem: 'unreachable' }); return; }
      if (!await applyReply(sent.body, epoch)) { await connect(); return; }
    }
    set({ state: 'active', problem: null });
    if (isDirty()) scheduleSave();
  }

  function putInit(body, keepalive = false) {
    return { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive };
  }

  // One round: send the copy if it needs it. Nothing is awaited before the fetch, because a save
  // started as the page closes must leave before the page does. Every save small enough uses
  // keepalive, since the page may close while it is on its way.
  async function saveRound() {
    const copy = read();
    if (!copy.sync || !copy.sync.dirty) return;
    const { owner, syncedAt } = copy.sync;
    const epoch = epochOf(copy);
    const body = saveBody(copy);
    const closing = pageClosing || document.visibilityState === 'hidden';
    if (closing && !canSaveOnClose(body)) return; // stays marked unsaved, for the next visit
    // since lets the server refuse a copy older than a deletion, whatever session carries it.
    const sent = await callApi(`/api/progress?account=${encodeURIComponent(owner)}&since=${syncedAt}`, putInit(body, canSaveOnClose(body)));
    if (changedSince(epoch)) await connect();
    else if (sent.status === 200 && sent.body) {
      if (await applyReply(sent.body, epoch)) set({ state: 'active', problem: null });
      else await connect();
    } else if (sent.status === 401) noSession();
    else if (sent.status === 410) {
      // This copy is finished, but the session may be a newer one with nothing wrong with it. connect
      // finds out, and ends it if it was refused too.
      await removeCopy('deleted', unchangedSince(epoch));
      await connect();
    } else if (sent.status === 409) await connect(); // this session is someone else's now
    else if (sent.status === 413) set({ problem: 'too_large' });
    else set({ problem: 'unreachable' });
  }

  // The page is closing with a save on its way, and that save may not hold the latest answers. No
  // round can follow it, so this sends them now. The server merges, so a repeat is harmless, and
  // nothing here handles the reply: the copy stays marked unsaved until a later visit syncs it.
  function saveLastAnswers() {
    const copy = read();
    if (!copy.sync || !copy.sync.dirty) return;
    const body = saveBody(copy);
    if (!canSaveOnClose(body)) return;
    const { owner, syncedAt } = copy.sync;
    callApi(`/api/progress?account=${encodeURIComponent(owner)}&since=${syncedAt}`, putInit(body, true));
  }

  // Saves if needed, with at most one save in flight in this tab. A request during a save adds one
  // more round after it. Two tabs can save at once: the server merges them.
  function save() {
    if (inFlight) { again = true; return inFlight; }
    inFlight = (async () => {
      try {
        do {
          again = false;
          await saveRound();
        } while (again && !s.problem);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  // Saves until nothing is left to save. Returns whether that was reached.
  async function flush() {
    for (let i = 0; i < MAX_FLUSH_ROUNDS; i++) {
      await save();
      if (!isDirty()) return true;
      if (s.problem || s.state === 'expired') return false;
    }
    return false;
  }

  async function runStart() {
    const got = await callApi('/api/config');
    if (got.status !== 200 || !got.body) {
      // No answer means nothing changes: the app works as it did, from the browser copy.
      const anon = ownerOf(read()) === null;
      set({ state: anon ? 'anon' : 'active', problem: anon ? null : 'unreachable', configLoaded: false });
      return;
    }
    Object.assign(s, { google: !!got.body.googleLogin, dev: !!got.body.devLogin, configLoaded: true });
    if (got.body.signedIn) await connect();
    else noSession();
  }

  // Finds out the session's state and syncs. Calls while one is running share it.
  function start() {
    if (!starting) starting = runStart().finally(() => { starting = null; });
    return starting;
  }

  function tick() {
    if (document.visibilityState !== 'visible') return;
    if (!s.configLoaded || s.state === 'unknown' || s.problem === 'unreachable') { start(); return; }
    if (s.state === 'active' && s.problem !== 'too_large' && isDirty()) save();
  }

  // Picks up what other devices saved. Runs alongside nothing else that reads the account.
  function pull() {
    if (!starting) starting = connect().finally(() => { starting = null; });
    return starting;
  }

  // ---------- actions from the page ----------
  async function devSignIn() {
    const got = await callApi('/auth/dev-login', { method: 'POST' });
    if (got.status !== 200) { notify('login_failed'); return; }
    await starting; // anything already running began before this session existed
    await start();
  }

  // Ends the session and removes the copy. The caller holds the lock, so no other tab can add an
  // answer between the two: its answer waits, then finds the new epoch and is dropped.
  async function finishSignOut() {
    const out = await callApi('/auth/logout', { method: 'POST' });
    if (out.status !== 200) { notify('sign_out_failed'); return 'failed'; }
    dropHeld();
    set({ state: 'anon', problem: null });
    return 'done';
  }

  // Returns 'done', 'failed', or 'unsaved' when the page must ask first. force skips the save.
  async function signOut(force = false) {
    if (force) return exclusive(finishSignOut);
    for (let i = 0; i < MAX_SIGN_OUT_ROUNDS; i++) {
      if (!await flush()) return 'unsaved';
      const outcome = await exclusive(() => (isDirty() ? null : finishSignOut()));
      if (outcome) return outcome;
    }
    return 'unsaved';
  }

  // Returns 'done' or 'failed'. Names the account the page shows, so a session changed by another
  // tab can't take a different account's data with it.
  async function deleteAccount() {
    const owner = ownerOf(read());
    if (owner === null) { await pull(); notify('delete_failed'); return 'failed'; }
    const syncedBefore = read().sync.syncedAt;
    const got = await callApi(`/api/progress?account=${encodeURIComponent(owner)}`, { method: 'DELETE' });
    if (got.status === 200 || got.status === 410) {
      // By owner, not epoch: the account is gone, so even a copy cleared meanwhile has to go. A copy
      // synced since is left alone, as it may come from a new sign-in. If it doesn't, its next save
      // is refused as older than the deletion and it goes then.
      const stale = (copy) => ownerOf(copy) === owner && copy.sync.syncedAt <= syncedBefore;
      if (await removeCopy('delete_done', stale)) set({ state: 'anon', problem: null });
      else await pull();
      return 'done';
    }
    if (got.status === 401) { noSession(); notify('delete_needs_session'); return 'failed'; }
    if (got.status === 409) { await pull(); return 'failed'; } // settling the owner tells the person
    notify('delete_failed');
    return 'failed';
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (s.state === 'active') save(); return; }
    if (s.state !== 'active') return;
    if (Date.now() - lastPull >= SAVE_INTERVAL_MS) pull();
    else if (isDirty()) save();
  });
  // A closing page isn't always reported as hidden first, so this is the sure sign of it.
  window.addEventListener('pagehide', () => {
    pageClosing = true;
    if (s.state !== 'active') return;
    if (inFlight) saveLastAnswers();
    else save();
  });
  window.addEventListener('pageshow', () => { pageClosing = false; });
  window.addEventListener('online', () => { if (s.problem) start(); });
  setInterval(tick, SAVE_INTERVAL_MS);

  return { status: s, start, save, devSignIn, signOut, deleteAccount };
}
