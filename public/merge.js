// The progress store: cleaning, migration, merging and the changes an answer makes.
//
// Shared by the browser and the Worker, so it uses no browser or Worker features. Anything that
// would need the clock or randomness is passed in. The Worker runs this on untrusted input, so
// cleanStore must survive any JSON and keep only values it can vouch for.
//
// A store holds:
//   v         store version
//   gen       {t, id}: which generation this is. A newer generation replaces older data entirely.
//   device    this browser's ID. Local only: merging drops it.
//   counters  {deviceId: {scores: {mode: {c, n}}, kanji: {key: {c, n}}}}. Totals are their sum.
//   srs       {"mode:key": {b, d, r}}: box, due time and last-reviewed time.
//   log       [{t, m, k, ok, d, s}], oldest first. d and s are absent on entries from the artifact.
//   tests     [{t, m, c, n, f, miss, d, s}], oldest first.
//
// In log and tests, d is the device and s is that device's answer count for the mode at that
// moment. Together they tell apart two real answers that are otherwise identical, because a
// device's count rises with every answer, even when two tabs share the device.

export const STORE_VERSION = 3;
export const MODE_KEYS = ['reading', 'words', 'gloss', 'odd', 'meaning']; // keep in step with MODES in app.js
export const INTERVALS = [0, 1, 3, 7, 14, 30, 90]; // days per review box
export const DAY = 86400000;
const DUE_EARLY = 4 * 3600000; // due a few hours early so a daily habit doesn't slip a day

// Far above real use. They only bound what a hostile or broken client can send.
export const LIMITS = Object.freeze({ devices: 500, itemsPerDevice: 5000, srs: 10000, log: 400, tests: 100 });
const MAX_TIME = 8.64e15; // the largest time a JavaScript Date can hold
const MAX_COUNT = 1e9;
const MAX_KEY_LENGTH = 64;
const MAX_MISSES = 30;
const FOCUSES = ['due', 'weak', 'mixed', 'family'];

// Every store that has never been cleared or restored shares this generation, so that copies
// from two browsers merge instead of one replacing the other.
export const GENESIS = Object.freeze({ t: 0, id: '0' });

const FORBIDDEN_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Maps with untrusted keys have no prototype, so no key can reach Object.prototype.
const newMap = () => Object.create(null);
const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isKey = (k) => typeof k === 'string' && k.length >= 1 && k.length <= MAX_KEY_LENGTH && !FORBIDDEN_KEYS.has(k);
const isId = (x) => typeof x === 'string' && ID_PATTERN.test(x) && !FORBIDDEN_KEYS.has(x);
const isMode = (m) => typeof m === 'string' && MODE_KEYS.includes(m);
const isTime = (x) => Number.isSafeInteger(x) && x >= 0 && x <= MAX_TIME;
const isTally = (x) => isObject(x) && Number.isSafeInteger(x.c) && Number.isSafeInteger(x.n)
  && x.c >= 0 && x.c <= x.n && x.n > 0 && x.n <= MAX_COUNT;
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A log or test time that isn't a valid number sorts as oldest. Only numbers are read: converting
// anything else can throw on JSON such as {"toString":null}.
function looseTime(x) {
  if (typeof x !== 'number') return 0;
  const t = Math.trunc(x);
  return isTime(t) ? t + 0 : 0;
}

function cleanGeneration(g) {
  return isObject(g) && isTime(g.t) && isId(g.id) ? { t: g.t + 0, id: g.id } : { ...GENESIS };
}

// Items are capped in key order, not by count. A cap that looks at values could drop half of a
// device's counts in one merge order and keep them in another, and merge order must not matter.
function cleanTallies(src, allowed, cap) {
  const out = newMap();
  if (!isObject(src)) return out;
  const keys = Object.keys(src).filter((k) => allowed(k) && isTally(src[k])).sort(byCodeUnit).slice(0, cap);
  for (const k of keys) out[k] = { c: src[k].c + 0, n: src[k].n };
  return out;
}

function cleanCounters(src, limits) {
  const out = newMap();
  if (!isObject(src)) return out;
  const found = [];
  for (const id of Object.keys(src).filter(isId).sort(byCodeUnit)) {
    const dev = src[id];
    if (!isObject(dev)) continue;
    const scores = cleanTallies(dev.scores, isMode, MODE_KEYS.length);
    const kanji = cleanTallies(dev.kanji, isKey, limits.itemsPerDevice);
    if (Object.keys(scores).length || Object.keys(kanji).length) found.push([id, { scores, kanji }]);
  }
  for (const [id, dev] of found.slice(0, limits.devices)) out[id] = dev;
  return out;
}

function cleanSrs(src, limits) {
  const out = newMap();
  if (!isObject(src)) return out;
  const valid = Object.keys(src).filter((k) => {
    const v = src[k], i = k.indexOf(':');
    return i > 0 && isMode(k.slice(0, i)) && isKey(k.slice(i + 1)) && isObject(v)
      && Number.isInteger(v.b) && v.b >= 0 && v.b < INTERVALS.length && isTime(v.d) && isTime(v.r);
  });
  // The cap keeps the most recently reviewed. Only one side's entry survives a merge whole, so
  // an entry that is kept in the final result is kept at every step in any order.
  valid.sort((a, b) => src[b].r - src[a].r || byCodeUnit(a, b));
  for (const k of valid.slice(0, limits.srs).sort(byCodeUnit)) out[k] = { b: src[k].b + 0, d: src[k].d + 0, r: src[k].r + 0 };
  return out;
}

// Keeps the newest entries by a total order, dropping exact duplicates. An entry's identity is
// its whole value, so merging is plain set union, and the cap stays independent of merge order.
function newestUnique(entries, cap) {
  const seen = new Map();
  for (const e of entries) seen.set(JSON.stringify(e), e);
  const sorted = [...seen.entries()].sort(([ca, a], [cb, b]) => a.t - b.t || byCodeUnit(ca, cb));
  return sorted.slice(-cap).map(([, e]) => e);
}

// Adds d and s, when valid, in a fixed field order: the JSON of an entry is its identity.
function withSource(entry, x) {
  if (isId(x.d)) entry.d = x.d;
  if (Number.isSafeInteger(x.s) && x.s >= 0 && x.s <= MAX_COUNT) entry.s = x.s + 0;
  return entry;
}

function cleanLog(src, limits) {
  if (!Array.isArray(src)) return [];
  const entries = src.filter((e) => isObject(e) && isKey(e.k) && isMode(e.m))
    .map((e) => withSource({ t: looseTime(e.t), m: e.m, k: e.k, ok: !!e.ok }, e));
  return newestUnique(entries, limits.log);
}

function cleanTests(src, limits) {
  if (!Array.isArray(src)) return [];
  const entries = src.filter((x) => isTally(x) && isMode(x.m))
    .map((x) => withSource({
      t: looseTime(x.t), m: x.m, c: x.c + 0, n: x.n, f: FOCUSES.includes(x.f) ? x.f : 'mixed',
      miss: Array.isArray(x.miss) ? x.miss.filter(isKey).slice(0, MAX_MISSES) : [],
    }, x));
  return newestUnique(entries, limits.tests);
}

export function blankStore() {
  return { v: STORE_VERSION, gen: { ...GENESIS }, counters: newMap(), srs: newMap(), log: [], tests: [] };
}

// Validates a store in the current shape. It does not read older shapes: use migrateStore for
// anything that may be one. The result is in one canonical form, so equal stores have equal JSON.
export function cleanStore(d, limits = LIMITS) {
  const s = blankStore();
  if (!isObject(d)) return s;
  s.gen = cleanGeneration(d.gen);
  s.counters = cleanCounters(d.counters, limits);
  s.srs = cleanSrs(d.srs, limits);
  s.log = cleanLog(d.log, limits);
  s.tests = cleanTests(d.tests, limits);
  if (isId(d.device)) s.device = d.device;
  return s;
}

function compareGenerations(a, b) {
  return a.t - b.t || byCodeUnit(a.id, b.id);
}

export function sameGeneration(a, b) {
  return compareGenerations(a, b) === 0;
}

// A new generation always beats the one it follows, even if this device's clock is behind.
export function newGeneration(now, id, current = GENESIS) {
  return { t: Math.min(Math.max(now, current.t + 1), MAX_TIME), id };
}

function maxTally(a, b) {
  return a && b ? { c: Math.max(a.c, b.c), n: Math.max(a.n, b.n) } : a || b;
}

function joinTallies(a, b) {
  const out = newMap();
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = maxTally(a[k], b[k]);
  return out;
}

function laterReview(a, b) {
  if (!a || !b) return a || b;
  return (a.r - b.r || a.b - b.b || a.d - b.d) >= 0 ? a : b;
}

// Combines two clean stores item by item, in the given generation.
function joinInto(gen, a, b, limits) {
  const counters = newMap();
  for (const id of new Set([...Object.keys(a.counters), ...Object.keys(b.counters)])) {
    const x = a.counters[id] || { scores: newMap(), kanji: newMap() };
    const y = b.counters[id] || { scores: newMap(), kanji: newMap() };
    counters[id] = { scores: joinTallies(x.scores, y.scores), kanji: joinTallies(x.kanji, y.kanji) };
  }
  const srs = newMap();
  for (const k of new Set([...Object.keys(a.srs), ...Object.keys(b.srs)])) srs[k] = laterReview(a.srs[k], b.srs[k]);
  return cleanStore({ gen, counters, srs, log: [...a.log, ...b.log], tests: [...a.tests, ...b.tests] }, limits);
}

// The ordinary merge between copies of one account. The result is the same in any order, and
// syncing the same data again changes nothing. It carries no device ID: that belongs to a browser.
export function mergeStores(a, b, limits = LIMITS) {
  const x = cleanStore(a, limits), y = cleanStore(b, limits);
  const order = compareGenerations(x.gen, y.gen);
  if (order === 0) return joinInto(x.gen, x, y, limits);
  const { device, ...newer } = order > 0 ? x : y;
  return newer;
}

// The one-time step at first login: anonymous data joins the account's current generation, and
// its own generation is ignored. It can't replace the account or be thrown away by it.
export function adoptAnonymous(account, anonymous, limits = LIMITS) {
  const x = cleanStore(account, limits), y = cleanStore(anonymous, limits);
  return joinInto(x.gen, x, y, limits);
}

function lastReviewed(v) {
  if (!isObject(v) || !Number.isInteger(v.b) || !Number.isFinite(INTERVALS[v.b]) || !isTime(v.d)) return null;
  return { b: v.b, d: v.d, r: v.b === 0 ? v.d : Math.max(0, v.d - INTERVALS[v.b] * DAY + DUE_EARLY) };
}

// Reads any store the app has written. Stores from the artifact get last-reviewed times computed
// from its rule, which depends on today's INTERVALS, so this happens once: a store already at
// STORE_VERSION is only cleaned. Their flat counts become the migrating device's counters.
export function migrateStore(raw, device, limits = LIMITS) {
  if (isObject(raw) && typeof raw.v === 'number' && raw.v >= STORE_VERSION) {
    const s = cleanStore(raw, limits);
    if (!s.device && isId(device)) s.device = device;
    return s;
  }
  const old = isObject(raw) ? raw : {};
  const srs = newMap();
  if (isObject(old.srs)) {
    for (const k of Object.keys(old.srs)) {
      const v = lastReviewed(old.srs[k]);
      if (v) srs[k] = v;
    }
  }
  const counters = newMap();
  if (isId(device)) counters[device] = { scores: old.scores, kanji: old.kanji };
  return cleanStore({ gen: GENESIS, device, counters, srs, log: old.log, tests: old.tests }, limits);
}

// True when a parsed browser copy holds something this code can't read, so that writing over it
// would destroy it: it isn't an object, or it has data and none of that data survived cleaning.
export function isUnreadable(raw, migrated) {
  if (!isObject(raw)) return true;
  const kept = migrated.log.length || migrated.tests.length || Object.keys(migrated.srs).length || Object.keys(migrated.counters).length;
  if (kept) return false;
  return ['counters', 'srs', 'log', 'tests', 'scores', 'kanji'].some((f) => hasData(raw[f]));
}

// A cleared store is all zeros and is valid, so zeros and empty containers aren't data.
function hasData(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (isObject(v)) return Object.values(v).some(hasData);
  return v !== undefined && v !== null && v !== 0;
}

// The older key held only the flat scores.
export function migrateScores(flat, device, limits = LIMITS) {
  return migrateStore({ v: 2, scores: flat }, device, limits);
}

export function clearedStore(current, now, genId) {
  return { ...blankStore(), gen: newGeneration(now, genId, current.gen), device: current.device };
}

// 64-bit FNV-1a. It only has to tell apart backups by accident, not resist an attacker: a forged
// collision can only lower the forger's own counts.
function contentHash(text) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h = BigInt.asUintN(64, (h ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, '0');
}

const capTally = (x) => ({ c: Math.min(x.c, MAX_COUNT), n: Math.min(x.n, MAX_COUNT) });
const capTallies = (map) => Object.fromEntries(Object.entries(map).map(([k, x]) => [k, capTally(x)]));

// Moves all of a backup's counters onto one ID derived from its content. The backup's history
// then can't share an ID with its source device's later, separate answers, and the same backup
// adopted from two browsers has the same ID, so it counts once. The answer times keep separate
// histories with equal totals apart. Device names stay out of the hash: migrating an artifact
// backup names the restoring browser, which differs per browser.
function restoredCounters(store, limits) {
  const totals = totalsOf(store);
  const moved = {
    scores: cleanTallies(capTallies(totals.scores), isMode, MODE_KEYS.length),
    kanji: cleanTallies(capTallies(totals.kanji), isKey, limits.itemsPerDevice),
  };
  const out = newMap();
  if (Object.keys(moved.scores).length || Object.keys(moved.kanji).length) {
    out['backup-' + contentHash(JSON.stringify({
      moved,
      log: store.log.map((e) => [e.t, e.m, e.k, e.ok]),
      tests: store.tests.map((x) => [x.t, x.m, x.c, x.n]),
    }))] = moved;
  }
  return out;
}

// Backup data becomes a new generation with all its data, totals included. It keeps this
// browser's device ID, not one recorded in the backup.
export function restoredStore(current, backup, now, genId, limits = LIMITS) {
  const clean = cleanStore(backup, limits);
  return { ...clean, counters: restoredCounters(clean, limits), gen: newGeneration(now, genId, current.gen), device: current.device };
}

// Sums every device's counters. The maps have no prototype, so any key is safe to look up.
export function totalsOf(store) {
  const scores = newMap(), kanji = newMap();
  for (const m of MODE_KEYS) scores[m] = { c: 0, n: 0 };
  const add = (to, k, x) => {
    const t = to[k] || (to[k] = { c: 0, n: 0 });
    t.c += x.c; t.n += x.n;
  };
  for (const dev of Object.values(store.counters)) {
    for (const [m, x] of Object.entries(dev.scores)) add(scores, m, x);
    for (const [k, x] of Object.entries(dev.kanji)) add(kanji, k, x);
  }
  return { scores, kanji };
}

function ownCounters(store) {
  return store.counters[store.device] || (store.counters[store.device] = { scores: newMap(), kanji: newMap() });
}

function bump(map, k, ok) {
  const t = map[k] || (map[k] = { c: 0, n: 0 });
  t.n++;
  if (ok) t.c++;
  return t;
}

// Changes the store in place.
export function recordAnswer(store, mode, key, ok, now) {
  const mine = ownCounters(store);
  const seq = bump(mine.scores, mode, ok).n;
  bump(mine.kanji, key, ok);

  const k = mode + ':' + key;
  const prev = store.srs[k] || { b: 0, d: 0, r: -1 };
  const b = ok ? Math.min(prev.b + 1, INTERVALS.length - 1) : 0;
  store.srs[k] = {
    b,
    d: b === 0 ? now : now + INTERVALS[b] * DAY - DUE_EARLY,
    r: Math.max(now, prev.r + 1), // a later answer is the later review, even if the clock went back
  };

  store.log.push({ t: now, m: mode, k: key, ok, d: store.device, s: seq });
  if (store.log.length > LIMITS.log) store.log = store.log.slice(-LIMITS.log);
}

// Changes the store in place. test is {t, m, c, n, f, miss}.
export function recordTest(store, test) {
  const counted = ownCounters(store).scores[test.m];
  store.tests.push({ ...test, d: store.device, s: counted ? counted.n : 0 });
  if (store.tests.length > LIMITS.tests) store.tests = store.tests.slice(-LIMITS.tests);
}
