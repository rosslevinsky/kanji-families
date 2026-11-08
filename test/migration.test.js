import { describe, expect, it } from 'vitest';
import { DAY, GENESIS, INTERVALS, STORE_VERSION, adoptAnonymous, isUnreadable, mergeStores, migrateScores, migrateStore, restoredStore, totalsOf } from '../public/merge.js';

const H4 = 4 * 3600000;
const NOW = 1790000000000;
const b3due = NOW + 7 * DAY - H4; // what the artifact wrote for a right answer into box 3

// The shape the artifact's own code wrote.
const artifactStore = () => ({
  v: 2,
  scores: { reading: { c: 7, n: 10 }, words: { c: 1, n: 2 }, gloss: { c: 0, n: 0 }, odd: { c: 0, n: 0 }, meaning: { c: 3, n: 3 } },
  kanji: { 清: { c: 4, n: 6 }, 晴: { c: 3, n: 4 }, 青空: { c: 1, n: 2 }, 泳: { c: 3, n: 3 } },
  log: [
    { t: NOW - 3000, m: 'reading', k: '清', ok: true },
    { t: NOW - 2000, m: 'reading', k: '晴', ok: false },
    { t: NOW - 1000, m: 'words', k: '青空', ok: true },
  ],
  tests: [{ t: NOW - 1000, m: 'reading', c: 1, n: 2, f: 'due', miss: ['晴'] }],
  srs: {
    'reading:晴': { b: 0, d: NOW - 2000 },
    'reading:清': { b: 3, d: b3due },
    'words:青空': { b: 6, d: NOW + 90 * DAY - H4 },
  },
});

describe('a v2 store from the artifact', () => {
  const m = migrateStore(artifactStore(), 'devA');

  it('gets exact last-reviewed times by the artifact rule', () => {
    expect(m.srs['reading:晴']).toEqual({ b: 0, d: NOW - 2000, r: NOW - 2000 });
    expect(m.srs['reading:清']).toEqual({ b: 3, d: b3due, r: b3due - INTERVALS[3] * DAY + H4 });
    expect(m.srs['reading:清'].r).toBe(NOW);
    expect(m.srs['words:青空'].r).toBe(NOW);
  });

  it('keeps the totals, as the migrating device’s counters', () => {
    const s = artifactStore();
    const t = totalsOf(m);
    expect(t.scores.reading).toEqual(s.scores.reading);
    expect(t.scores.meaning).toEqual(s.scores.meaning);
    expect(t.scores.gloss).toEqual({ c: 0, n: 0 });
    for (const [k, v] of Object.entries(s.kanji)) expect(t.kanji[k]).toEqual(v);
    expect(Object.keys(m.counters)).toEqual(['devA']);
    expect(m.counters.devA.scores.gloss).toBeUndefined();
  });

  it('keeps the log and tests, marks the new version, and sets the shared first generation', () => {
    expect(m.v).toBe(STORE_VERSION);
    expect(STORE_VERSION).toBe(3);
    expect(m.gen).toEqual(GENESIS);
    expect(m.device).toBe('devA');
    expect(m.log).toEqual(artifactStore().log);
    expect(m.tests).toEqual(artifactStore().tests);
  });

  it('does not change on a second run', () => {
    const again = migrateStore(JSON.parse(JSON.stringify(m)), 'devB');
    expect(JSON.stringify(again)).toBe(JSON.stringify(m));
  });

  it('migrated on two devices at once, joins rather than replaces', () => {
    const other = migrateStore(artifactStore(), 'devB');
    const merged = mergeStores(m, other);
    expect(merged.gen).toEqual(GENESIS);
    expect(merged.log).toHaveLength(3);
  });

  it('accepts a store with no version number, as very old copies had', () => {
    const s = artifactStore();
    delete s.v;
    expect(JSON.stringify(migrateStore(s, 'devA'))).toBe(JSON.stringify(m));
  });

  it('drops schedule entries the cleaner refuses, and never crashes', () => {
    const x = migrateStore({ v: 2, srs: { 'reading:清': { b: 99, d: 5 }, 'reading:晴': { b: 3, d: 'x' } }, scores: 5, kanji: 'x', log: 1, tests: 2 }, 'devA');
    expect(x.srs).toEqual({});
    expect(x.counters).toEqual({});
    for (const v of [null, 3, 'x', [], true]) expect(migrateStore(v, 'devA').log).toEqual([]);
  });

  it('never gives a negative time', () => {
    const x = migrateStore({ v: 2, srs: { 'reading:清': { b: 6, d: 5 } } }, 'devA');
    expect(x.srs['reading:清'].r).toBe(0);
  });

  it('restores as a backup with its totals, apart from the browser’s own device', () => {
    const current = { ...migrateStore({ v: 2 }, 'devZ') };
    const r = restoredStore(current, migrateStore(artifactStore(), current.device), NOW + 5, 'g1');
    expect(r.device).toBe('devZ');
    expect(r.gen).toEqual({ t: NOW + 5, id: 'g1' });
    expect(Object.keys(r.counters)).toHaveLength(1);
    expect(r.counters.devZ).toBeUndefined();
    expect(totalsOf(r).scores.reading).toEqual({ c: 7, n: 10 });
    expect(r.srs['reading:清'].r).toBe(NOW);
  });

  it('restored in two browsers, counts once, though each migrated it under its own device', () => {
    const inBrowser = (dev) => restoredStore({ ...migrateStore({ v: 2 }, dev) }, migrateStore(artifactStore(), dev), NOW + 5, `g${dev}`);
    const a = inBrowser('devY'), b = inBrowser('devZ');
    expect(Object.keys(a.counters)).toEqual(Object.keys(b.counters));
    expect(totalsOf(adoptAnonymous(a, b)).scores.reading).toEqual({ c: 7, n: 10 });
  });
});

describe('a copy that cannot be read', () => {
  it('is anything that is not an object', () => {
    for (const v of [null, 3, 'x', [], true]) expect(isUnreadable(v, migrateStore(v, 'devA'))).toBe(true);
  });

  it('is an object whose data all fails cleaning', () => {
    for (const v of [{ v: 3, counters: 'x' }, { v: 3, log: [1] }, { v: 2, kanji: { 清: 5 } }, { v: 3, srs: { nope: 1 } }]) {
      expect(isUnreadable(v, migrateStore(v, 'devA'))).toBe(true);
    }
  });

  it('is not a store that is really empty, or that kept any data', () => {
    for (const v of [{}, { v: 3 }, { v: 3, counters: {}, srs: {}, log: [], tests: [] }, { v: 2, log: [] }]) {
      expect(isUnreadable(v, migrateStore(v, 'devA'))).toBe(false);
    }
    expect(isUnreadable(artifactStore(), migrateStore(artifactStore(), 'devA'))).toBe(false);
    expect(isUnreadable({ v: 3, log: [1, { t: 1, m: 'reading', k: '清' }] }, migrateStore({ v: 3, log: [1, { t: 1, m: 'reading', k: '清' }] }, 'devA'))).toBe(false);
  });
});

describe('the older kfd-scores value', () => {
  it('becomes the migrating device’s counters', () => {
    const m = migrateScores({ reading: { c: 5, n: 8 }, words: { c: 1, n: 1 } }, 'devA');
    expect(m.v).toBe(STORE_VERSION);
    expect(m.device).toBe('devA');
    expect(totalsOf(m).scores.reading).toEqual({ c: 5, n: 8 });
    expect(totalsOf(m).scores.words).toEqual({ c: 1, n: 1 });
    expect(m.log).toEqual([]);
    expect(JSON.stringify(migrateStore(JSON.parse(JSON.stringify(m)), 'devB'))).toBe(JSON.stringify(m));
  });

  it('survives garbage', () => {
    for (const v of [null, 3, 'x', [], { reading: 3 }]) expect(migrateScores(v, 'devA').counters).toEqual({});
  });
});

describe('a store already in the new shape', () => {
  it('keeps its own device and counters', () => {
    const s = { v: 3, gen: { t: 9, id: 'g' }, device: 'devQ', counters: { devQ: { scores: { reading: { c: 1, n: 1 } }, kanji: {} } }, srs: { 'reading:清': { b: 3, d: 500, r: 5 } }, log: [], tests: [] };
    const m = migrateStore(s, 'devA');
    expect(m.device).toBe('devQ');
    expect(m.gen).toEqual({ t: 9, id: 'g' });
    expect(m.srs['reading:清'].r).toBe(5);
    expect(Object.keys(m.counters)).toEqual(['devQ']);
  });

  it('takes the fallback device if it has none', () => {
    expect(migrateStore({ v: 3 }, 'devA').device).toBe('devA');
  });
});

describe('edge cases', () => {
  it('reads a cleared store as valid, so older scores do not come back', () => {
    const cleared = { v: 2, scores: { reading: { c: 0, n: 0 } }, kanji: {}, log: [], tests: [], srs: {} };
    expect(isUnreadable(cleared, migrateStore(cleared, 'devA'))).toBe(false);
  });

  it('keeps separate backups with equal totals apart, and the same backup together', () => {
    const backup = (t) => ({ v: 2, scores: { reading: { c: 1, n: 1 } }, kanji: { 清: { c: 1, n: 1 } }, log: [{ t, m: 'reading', k: '清', ok: true }], tests: [], srs: {} });
    const restore = (b, dev) => restoredStore(migrateStore({ v: 3, device: dev }, dev), migrateStore(b, dev), 5000, 'g' + dev);
    const idsOf = (s) => Object.keys(s.counters);
    expect(idsOf(restore(backup(1000), 'devA'))).toEqual(idsOf(restore(backup(1000), 'devB')));
    expect(idsOf(restore(backup(1000), 'devA'))).not.toEqual(idsOf(restore(backup(2000), 'devA')));
  });
});
