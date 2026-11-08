import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GENESIS, LIMITS, MODE_KEYS, blankStore, cleanStore, clearedStore, mergeStores, migrateStore, newGeneration, recordAnswer, recordTest,
  restoredStore, totalsOf,
} from '../public/merge.js';

// Small pools on purpose: random stores then collide on devices, keys and times, so ties and
// duplicates are common rather than rare.
const device = fc.constantFrom('devA', 'devB', 'devC', 'devD');
const mode = fc.constantFrom('reading', 'words', 'gloss', 'odd', 'meaning');
const key = fc.constantFrom('清', '晴', '精', '静', '青', '請');
const time = fc.integer({ min: 0, max: 6 });
const count = fc.record({ c: fc.integer({ min: 0, max: 3 }), n: fc.integer({ min: 3, max: 6 }) });

const counters = fc.record({
  scores: fc.dictionary(mode, count, { maxKeys: 3 }),
  kanji: fc.dictionary(key, count, { maxKeys: 4 }),
});
const srsEntry = fc.record({ b: fc.integer({ min: 0, max: 6 }), d: time, r: time });
const logEntry = fc.record({
  t: time, m: mode, k: key, ok: fc.boolean(), d: fc.option(device, { nil: undefined }), s: fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
});
const testEntry = fc.record({
  t: time, m: mode, c: fc.integer({ min: 0, max: 2 }), n: fc.constant(2), f: fc.constantFrom('due', 'weak', 'mixed', 'family'),
  miss: fc.array(key, { maxLength: 2 }),
});
const generation = fc.oneof(
  { weight: 3, arbitrary: fc.constant(GENESIS) },
  { weight: 2, arbitrary: fc.record({ t: fc.integer({ min: 1, max: 3 }), id: fc.constantFrom('g1', 'g2') }) },
);
const store = fc.record({
  v: fc.constant(3),
  gen: generation,
  counters: fc.dictionary(device, counters, { maxKeys: 4 }),
  srs: fc.dictionary(fc.tuple(mode, key).map(([m, k]) => `${m}:${k}`), srsEntry, { maxKeys: 6 }),
  log: fc.array(logEntry, { maxLength: 8 }),
  tests: fc.array(testEntry, { maxLength: 6 }),
});
const sameGenStore = store.map((s) => ({ ...s, gen: GENESIS }));

const SMALL = { devices: 2, itemsPerDevice: 2, srs: 3, log: 3, tests: 2 };
const json = (x) => JSON.stringify(x);

describe.each([
  ['default caps', undefined],
  ['small caps, so that they bite', SMALL],
])('ordinary merge with %s', (_name, limits) => {
  const merge = (a, b) => mergeStores(a, b, limits);

  it('is commutative', () => {
    fc.assert(fc.property(store, store, (a, b) => json(merge(a, b)) === json(merge(b, a))), { numRuns: 500 });
  });

  it('is associative', () => {
    fc.assert(fc.property(store, store, store, (a, b, c) => json(merge(merge(a, b), c)) === json(merge(a, merge(b, c)))), { numRuns: 500 });
  });

  it('is associative within one generation, where every field really merges', () => {
    fc.assert(fc.property(sameGenStore, sameGenStore, sameGenStore, (a, b, c) => json(merge(merge(a, b), c)) === json(merge(a, merge(b, c)))), { numRuns: 500 });
  });

  it('is idempotent, and syncing the same data again changes nothing', () => {
    fc.assert(fc.property(store, store, (a, b) => {
      const once = merge(a, b);
      return json(merge(a, a)) === json(cleanStore(a, limits))
        && json(merge(once, b)) === json(once) && json(merge(once, a)) === json(once) && json(merge(once, once)) === json(once);
    }), { numRuns: 500 });
  });
});

describe('review schedule', () => {
  const withSrs = (entry) => ({ ...blankStore(), srs: { 'reading:清': entry } });

  it('keeps the most recent review, including a newer miss over an older success', () => {
    const olderSuccess = withSrs({ b: 5, d: 9000, r: 100 });
    const newerMiss = withSrs({ b: 0, d: 200, r: 200 });
    expect(mergeStores(olderSuccess, newerMiss).srs['reading:清']).toEqual({ b: 0, d: 200, r: 200 });
    expect(mergeStores(newerMiss, olderSuccess).srs['reading:清']).toEqual({ b: 0, d: 200, r: 200 });
  });

  it('breaks a tie on the full value, whichever side it came from', () => {
    const a = withSrs({ b: 1, d: 5, r: 100 });
    const b = withSrs({ b: 2, d: 3, r: 100 });
    expect(mergeStores(a, b).srs['reading:清']).toEqual({ b: 2, d: 3, r: 100 });
    expect(mergeStores(b, a).srs['reading:清']).toEqual({ b: 2, d: 3, r: 100 });
  });

  it('a later answer on a device with a slow clock still counts as the later review', () => {
    const s = { ...blankStore(), device: 'devA' };
    recordAnswer(s, 'reading', '清', true, 5000);
    recordAnswer(s, 'reading', '清', false, 1000);
    expect(s.srs['reading:清'].r).toBe(5001);
    expect(s.srs['reading:清'].b).toBe(0);
  });
});

describe('counts', () => {
  it('two devices add up exactly, and repeated syncing never inflates them', () => {
    let a = { ...blankStore(), device: 'devA' };
    let b = { ...blankStore(), device: 'devB' };
    for (let i = 0; i < 3; i++) recordAnswer(a, 'reading', '清', i !== 0, 1000 + i);
    for (let i = 0; i < 2; i++) recordAnswer(b, 'reading', '清', true, 2000 + i);

    let synced = mergeStores(a, b);
    for (let i = 0; i < 5; i++) synced = mergeStores(mergeStores(synced, a), b);
    const totals = totalsOf(synced);
    expect(totals.scores.reading).toEqual({ c: 4, n: 5 });
    expect(totals.kanji['清']).toEqual({ c: 4, n: 5 });
    expect(totals.scores.words).toEqual({ c: 0, n: 0 });
    expect(synced.log).toHaveLength(5);
  });

  it('a device continues counting from what a sync gave it', () => {
    const a = { ...blankStore(), device: 'devA' };
    recordAnswer(a, 'reading', '清', true, 1000);
    const b = { ...mergeStores(a, blankStore()), device: 'devB' };
    recordAnswer(b, 'reading', '清', true, 1001);
    const again = { ...mergeStores(a, b), device: 'devA' };
    recordAnswer(again, 'reading', '清', false, 1002);
    expect(totalsOf(mergeStores(again, b)).scores.reading).toEqual({ c: 2, n: 3 });
  });
});

describe('log and tests', () => {
  it('combine and drop exact duplicates', () => {
    const e1 = { t: 1, m: 'reading', k: '清', ok: true };
    const e2 = { t: 2, m: 'reading', k: '晴', ok: false };
    const m = mergeStores({ ...blankStore(), log: [e1] }, { ...blankStore(), log: [e1, e2] });
    expect(m.log).toEqual([e1, e2]);
  });

  it('keep two different answers in the same millisecond, on one device or two', () => {
    const a = { ...blankStore(), device: 'devA' };
    const b = { ...blankStore(), device: 'devB' };
    recordAnswer(a, 'reading', '清', true, 1000);
    recordAnswer(b, 'reading', '清', true, 1000);
    expect(mergeStores(a, b).log).toHaveLength(2);

    recordAnswer(a, 'reading', '清', true, 1000);
    expect(cleanStore(a).log).toHaveLength(2);
  });

  it('keep two finished tests that look alike in the same millisecond on different devices', () => {
    const a = { ...blankStore(), device: 'devA' };
    const b = { ...blankStore(), device: 'devB' };
    recordTest(a, { t: 5, m: 'reading', c: 1, n: 2, f: 'due', miss: ['清'] });
    recordTest(b, { t: 5, m: 'reading', c: 1, n: 2, f: 'due', miss: ['清'] });
    expect(mergeStores(a, b).tests).toHaveLength(2);
  });

  it('hold the newest 400 and 100, the limits the app has always had', () => {
    const log = (from) => Array.from({ length: 400 }, (_, i) => ({ t: from + i, m: 'reading', k: '清', ok: true }));
    const tests = (from) => Array.from({ length: 100 }, (_, i) => ({ t: from + i, m: 'reading', c: 1, n: 1, f: 'due', miss: [] }));
    const m = mergeStores({ ...blankStore(), log: log(1), tests: tests(1) }, { ...blankStore(), log: log(201), tests: tests(51) });
    expect(m.log).toHaveLength(400);
    expect(m.log[0].t).toBe(201);
    expect(m.log[399].t).toBe(600);
    expect(m.tests).toHaveLength(100);
    expect(m.tests[0].t).toBe(51);
    expect(m.tests[99].t).toBe(150);
    expect(LIMITS.log).toBe(400);
    expect(LIMITS.tests).toBe(100);
  });
});

describe('generations', () => {
  const answered = (dev, t) => {
    const s = { ...blankStore(), device: dev };
    recordAnswer(s, 'reading', '清', true, t);
    recordTest(s, { t, m: 'reading', c: 1, n: 1, f: 'due', miss: [] });
    return s;
  };

  it('a newer generation replaces older data entirely, and exactly', () => {
    const newer = cleanStore({ ...answered('devB', 50), gen: { t: 100, id: 'g1' } });
    delete newer.device;
    const older = answered('devA', 999999);
    expect(json(mergeStores(older, newer))).toBe(json(newer));
    expect(json(mergeStores(newer, older))).toBe(json(newer));
  });

  it('breaks a tie on time with the random ID, in either order', () => {
    const a = cleanStore({ ...answered('devA', 1), gen: { t: 100, id: 'aaa' } });
    const b = cleanStore({ ...answered('devB', 2), gen: { t: 100, id: 'bbb' } });
    expect(mergeStores(a, b).gen.id).toBe('bbb');
    expect(mergeStores(b, a).gen.id).toBe('bbb');
    expect(Object.keys(mergeStores(a, b).counters)).toEqual(['devB']);
  });

  it('a device holding older data cannot bring cleared data back', () => {
    const old = answered('devA', 1000);
    const cleared = clearedStore(old, 2000, 'g1');
    expect(cleared.log).toEqual([]);
    expect(totalsOf(cleared).scores.reading).toEqual({ c: 0, n: 0 });

    const offline = answered('devB', 3000); // answered later by the clock, but on the old generation
    const m = mergeStores(mergeStores(cleared, offline), old);
    expect(m.gen).toEqual({ t: 2000, id: 'g1' });
    expect(m.log).toEqual([]);
    expect(Object.keys(m.counters)).toEqual([]);
  });

  it('a device with counters from a past generation starts fresh in the new one', () => {
    const b = answered('devB', 1000);
    const newer = clearedStore(answered('devA', 1000), 2000, 'g1');
    const synced = { ...mergeStores(b, newer), device: 'devB' };
    recordAnswer(synced, 'reading', '清', false, 3000);
    expect(synced.counters.devB.scores.reading).toEqual({ c: 0, n: 1 });
    expect(totalsOf(synced).scores.reading).toEqual({ c: 0, n: 1 });
  });

  it('a clear from a device whose clock is behind still beats the generation it saw', () => {
    const fromFastClock = { ...blankStore(), gen: { t: 9000, id: 'zz' } };
    const g = newGeneration(100, 'aa', fromFastClock.gen);
    expect(g).toEqual({ t: 9001, id: 'aa' });
    expect(mergeStores(fromFastClock, clearedStore(fromFastClock, 100, 'aa')).gen).toEqual({ t: 9001, id: 'aa' });
  });

  it('restore starts a new generation that keeps its data and totals', () => {
    const backup = cleanStore(answered('devA', 1000));
    const current = answered('devB', 5000);
    const r = restoredStore(current, backup, 6000, 'g2');
    expect(r.gen).toEqual({ t: 6000, id: 'g2' });
    expect(r.device).toBe('devB');
    expect(r.log).toEqual(backup.log);
    expect(totalsOf(r).scores.reading).toEqual({ c: 1, n: 1 });
    const m = mergeStores(current, r);
    expect(totalsOf(m).scores.reading).toEqual({ c: 1, n: 1 });
    expect(m.gen).toEqual({ t: 6000, id: 'g2' });
  });
});

describe('restored counters', () => {
  const browser = { ...blankStore(), device: 'browser' };
  const restore = (backup) => restoredStore(browser, backup, 6000, 'g2');
  const tally = (c, n) => ({ scores: { reading: { c, n } }, kanji: { 清: { c, n } } });
  const backupOf = (counters) => ({ v: 3, counters });
  const idOf = (backup) => Object.keys(restore(backup).counters)[0];

  it('move onto one new ID, keeping the totals the user sees', () => {
    fc.assert(fc.property(store, (s) => {
      const before = cleanStore(s);
      const r = restore(s);
      expect(Object.keys(r.counters).length).toBe(Object.keys(before.counters).length ? 1 : 0);
      expect(r.counters.browser).toBeUndefined();
      expect(totalsOf(r)).toEqual(totalsOf(before));
      expect(totalsOf(cleanStore(JSON.parse(json(r))))).toEqual(totalsOf(before));
    }), { numRuns: 300 });
  });

  it('get an ID that depends on the counts, not on device names or the order they were saved in', () => {
    const id = idOf(backupOf({ devA: tally(1, 1), devB: tally(2, 3) }));
    expect(idOf(backupOf({ devB: tally(2, 3), devA: tally(1, 1) }))).toBe(id);
    expect(idOf(backupOf({ devC: tally(3, 4) }))).toBe(id);
    expect(idOf(backupOf({ devA: tally(1, 2) }))).not.toBe(id);
    expect(idOf(backupOf({ devA: { scores: {}, kanji: { 清: { c: 3, n: 4 } } } }))).not.toBe(id);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(id).not.toBe('devC');
  });

  it('keep their ID when a restored store is backed up and restored again', () => {
    const once = restore(backupOf({ devA: tally(1, 1), devB: tally(2, 3) }));
    expect(idOf(JSON.parse(json(once)))).toBe(Object.keys(once.counters)[0]);
  });

  it('add a browser’s later answers beside them, on its own device', () => {
    const r = restore(backupOf({ devA: tally(1, 1) }));
    recordAnswer(r, 'reading', '清', false, 7000);
    expect(Object.keys(r.counters)).toHaveLength(2);
    expect(r.counters.browser.scores.reading).toEqual({ c: 0, n: 1 });
    expect(totalsOf(r).scores.reading).toEqual({ c: 1, n: 2 });
  });

  it('stay valid when their sum passes the largest count cleaning accepts', () => {
    const r = restore(backupOf({ devA: tally(1e9, 1e9), devB: tally(5, 1e9) }));
    expect(totalsOf(cleanStore(r)).scores.reading).toEqual({ c: 1e9, n: 1e9 });
  });

  it('add nothing when the backup has no counters', () => {
    expect(restore({ v: 3, log: [{ t: 1, m: 'reading', k: '清', ok: true }] }).counters).toEqual({});
  });
});

describe('cleaning untrusted input', () => {
  it('never crashes on any JSON, and its result is stable', () => {
    fc.assert(fc.property(fc.jsonValue(), (v) => {
      const once = cleanStore(v);
      expect(json(cleanStore(once))).toBe(json(once));
    }), { numRuns: 500 });
  });

  it('never crashes when store fields hold any JSON', () => {
    const field = fc.jsonValue();
    fc.assert(fc.property(fc.record({ gen: field, counters: field, srs: field, log: field, tests: field, device: field }), fc.dictionary(fc.string(), fc.jsonValue()), fc.boolean(), (r, d, nested) => {
      const once = cleanStore({ v: 3, ...r, counters: nested ? { devA: { scores: d, kanji: d } } : r.counters });
      expect(json(cleanStore(once))).toBe(json(once));
      mergeStores(once, r);
    }), { numRuns: 300 });
  });

  // +x throws on these two, and returned a number on the rest, which cleaning must not accept.
  const badTime = fc.oneof(
    fc.constantFrom({ toString: null }, { toString: null, valueOf: null }, { valueOf: 5 }, '12', true, [7], null, {}),
    fc.jsonValue(),
  );

  it('never crashes on times no value can be made from', () => {
    const bad = JSON.parse('{"toString":null}');
    const log = [{ t: bad, m: 'reading', k: '清', ok: true }];
    const tests = [{ t: bad, m: 'reading', c: 1, n: 1, f: 'due', miss: [] }];
    for (const s of [cleanStore({ v: 3, log, tests }), migrateStore({ v: 3, log, tests }, 'devA'), migrateStore({ v: 2, log, tests }, 'devA')]) {
      expect(s.log[0].t).toBe(0);
      expect(s.tests[0].t).toBe(0);
    }
  });

  it('does not turn a value that is not a number into a time', () => {
    for (const t of ['12', true, [7], { valueOf: 5 }]) {
      expect(cleanStore({ log: [{ t, m: 'reading', k: '清', ok: true }] }).log[0].t).toBe(0);
    }
    expect(cleanStore({ log: [{ t: 12.5, m: 'reading', k: '清', ok: true }] }).log[0].t).toBe(12);
  });

  it('cleanStore and migrateStore never throw on arbitrary JSON, at the top or in a time', () => {
    const entry = (t) => ({ t, m: 'reading', k: '清', ok: true, c: 1, n: 1 });
    fc.assert(fc.property(fc.jsonValue(), badTime, fc.constantFrom(2, 3, undefined), (v, t, version) => {
      const input = JSON.parse(json({ v: version, log: [entry(t)], tests: [entry(t)] }));
      for (const raw of [v, input]) {
        expect(() => cleanStore(raw)).not.toThrow();
        expect(() => migrateStore(raw, 'devA')).not.toThrow();
      }
      expect(() => migrateStore({ v: version, srs: v, scores: v, kanji: v, log: v, tests: v }, 'devA')).not.toThrow();
    }), { numRuns: 500 });
  });

  it('drops prototype-pollution keys everywhere and leaves Object.prototype alone', () => {
    const evil = JSON.parse(`{
      "v": 3,
      "gen": {"t": 1, "id": "__proto__"},
      "device": "__proto__",
      "counters": {
        "__proto__": {"scores": {"reading": {"c": 1, "n": 1}}, "kanji": {}},
        "constructor": {"scores": {"reading": {"c": 1, "n": 1}}, "kanji": {}},
        "devA": {
          "scores": {"__proto__": {"c": 1, "n": 1}, "polluted": {"c": 1, "n": 1}},
          "kanji": {"__proto__": {"c": 1, "n": 1}, "constructor": {"c": 1, "n": 1}, "prototype": {"c": 1, "n": 1}, "清": {"c": 1, "n": 1}}
        }
      },
      "srs": {"__proto__": {"b": 1, "d": 1, "r": 1}, "reading:__proto__": {"b": 1, "d": 1, "r": 1}, "__proto__:清": {"b": 1, "d": 1, "r": 1}},
      "log": [{"t": 1, "m": "__proto__", "k": "清", "ok": true}, {"t": 1, "m": "reading", "k": "__proto__", "ok": true}],
      "tests": [{"t": 1, "m": "constructor", "c": 1, "n": 1, "f": "due", "miss": []}, {"t": 1, "m": "reading", "c": 1, "n": 1, "f": "due", "miss": ["__proto__", "清"]}]
    }`);
    const s = mergeStores(evil, evil);
    expect(s.gen).toEqual(GENESIS);
    expect(Object.keys(s.counters)).toEqual(['devA']);
    expect(Object.keys(s.counters.devA.kanji)).toEqual(['清']);
    expect(Object.keys(s.counters.devA.scores)).toEqual([]);
    expect(Object.keys(s.srs)).toEqual([]);
    expect(s.log).toEqual([]);
    expect(s.tests).toEqual([{ t: 1, m: 'reading', c: 1, n: 1, f: 'due', miss: ['清'] }]);
    expect({}.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(totalsOf(s).kanji)).toBe(null);
    expect(totalsOf(s).kanji.constructor).toBeUndefined();
    expect(cleanStore(evil).device).toBeUndefined();
  });

  it('drops invalid values', () => {
    const s = cleanStore({
      v: 3,
      gen: { t: -1, id: 'x' },
      counters: {
        'bad id!': { scores: { reading: { c: 1, n: 1 } } },
        devA: { scores: { reading: { c: 5, n: 1 }, words: { c: 1.5, n: 2 }, gloss: { c: -1, n: 2 }, odd: { c: 0, n: 0 }, meaning: { c: 1, n: 2 } }, kanji: [{ c: 1, n: 1 }] },
      },
      srs: { 'reading:清': { b: 99, d: 1, r: 1 }, 'reading:晴': { b: 1, d: 1 }, 'reading:青': { b: 1, d: 1, r: 'x' }, 'nope:青': { b: 1, d: 1, r: 1 }, 'reading:静': { b: 1, d: 2, r: 3 } },
      log: [null, 5, { k: 5, m: 'reading' }, { t: 'x', m: 'reading', k: '清', ok: 1 }],
      tests: [{ t: 1, m: 'reading', c: 1, n: 0, f: 'due' }, { t: 1, m: 'reading', c: 3, n: 2 }, { t: 1, m: 'reading', c: 1, n: 2, f: 'bad', miss: 'x' }],
    });
    expect(s.gen).toEqual(GENESIS);
    expect(s.counters).toEqual({ devA: { scores: { meaning: { c: 1, n: 2 } }, kanji: {} } });
    expect(Object.keys(s.srs)).toEqual(['reading:静']);
    expect(s.log).toEqual([{ t: 0, m: 'reading', k: '清', ok: true }]);
    expect(s.tests).toEqual([{ t: 1, m: 'reading', c: 1, n: 2, f: 'mixed', miss: [] }]);
  });

  it('caps devices, items, schedule entries and over-long keys', () => {
    const many = (n, f) => Object.fromEntries(Array.from({ length: n }, (_, i) => f(i)));
    const limits = { ...LIMITS, devices: 3, itemsPerDevice: 2, srs: 2 };
    const s = cleanStore({
      v: 3,
      counters: many(10, (i) => [`dev${i}`, { scores: {}, kanji: many(5, (j) => [`k${j}`, { c: 0, n: 1 }]) }]),
      srs: many(5, (i) => [`reading:k${i}`, { b: 0, d: i, r: i }]),
    }, limits);
    expect(Object.keys(s.counters)).toEqual(['dev0', 'dev1', 'dev2']);
    expect(Object.keys(s.counters.dev0.kanji)).toEqual(['k0', 'k1']);
    expect(Object.keys(s.srs).sort()).toEqual(['reading:k3', 'reading:k4']);

    const long = cleanStore({ v: 3, counters: { devA: { kanji: { ['x'.repeat(100)]: { c: 0, n: 1 } } } }, log: [{ t: 1, m: 'reading', k: 'x'.repeat(100) }] });
    expect(long.counters).toEqual({});
    expect(long.log).toEqual([]);
  });
});

describe('recording', () => {
  it('sets the last-reviewed time and the schedule the artifact used', () => {
    const s = { ...blankStore(), device: 'devA' };
    recordAnswer(s, 'reading', '清', true, 1000);
    expect(s.srs['reading:清']).toEqual({ b: 1, d: 1000 + 86400000 - 4 * 3600000, r: 1000 });
    recordAnswer(s, 'reading', '清', false, 2000);
    expect(s.srs['reading:清']).toEqual({ b: 0, d: 2000, r: 2000 });
  });

  it('leaves a recorded store valid under cleaning', () => {
    const s = { ...blankStore(), device: 'devA' };
    recordAnswer(s, 'reading', '清', true, 1000);
    recordTest(s, { t: 1000, m: 'reading', c: 1, n: 1, f: 'due', miss: [] });
    const c = cleanStore(s);
    expect(c.log).toEqual(s.log);
    expect(c.tests).toEqual(s.tests);
    expect(c.srs).toEqual(s.srs);
    expect(c.counters).toEqual(s.counters);
    expect(c.device).toBe('devA');
  });
});

describe('the module', () => {
  it('knows the same quiz types as the app', async () => {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const block = app.slice(app.indexOf('const MODES = {'), app.indexOf('const MODE_NAMES'));
    expect([...block.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1])).toEqual(MODE_KEYS);
  });

  it('reads no browser or Worker globals', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../public/merge.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    expect(text).not.toMatch(/\b(window|document|localStorage|navigator|crypto|Date\.now|Math\.random|caches|fetch)\b/);
    expect(text).not.toMatch(/^import /m);
  });
});
