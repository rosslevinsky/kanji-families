import { describe, expect, it } from 'vitest';
import { adoptAnonymous, blankStore, clearedStore, mergeStores, recordAnswer, recordTest, restoredStore, totalsOf } from '../public/merge.js';

const at = (dev, answers) => {
  const s = { ...blankStore(), device: dev };
  for (const [k, ok, t] of answers) recordAnswer(s, 'reading', k, ok, t);
  return s;
};

describe('first login', () => {
  it('combines anonymous progress with the account by the normal rules', () => {
    const account = at('acct', [['清', true, 1000], ['晴', true, 3000]]);
    const anon = at('anon', [['清', false, 2000], ['晴', false, 2500], ['青', true, 2600]]);
    recordTest(anon, { t: 2600, m: 'reading', c: 1, n: 3, f: 'due', miss: ['清', '晴'] });

    const m = adoptAnonymous(account, anon);
    expect(totalsOf(m).scores.reading).toEqual({ c: 3, n: 5 });
    expect(m.srs['reading:清'].r).toBe(2000); // the newer anonymous miss wins
    expect(m.srs['reading:清'].b).toBe(0);
    expect(m.srs['reading:晴'].r).toBe(3000); // the newer account review wins
    expect(m.srs['reading:青'].r).toBe(2600);
    expect(m.log).toHaveLength(5);
    expect(m.tests).toHaveLength(1);
  });

  it('keeps the account generation, even if the account generation is older', () => {
    const account = at('acct', [['清', true, 1000]]);
    const anon = clearedStore(at('anon', []), 50000, 'anongen');
    recordAnswer(anon, 'reading', '晴', true, 60000);
    const m = adoptAnonymous(account, anon);
    expect(m.gen).toEqual(account.gen);
    expect(totalsOf(m).scores.reading).toEqual({ c: 2, n: 2 });
  });

  it('is not discarded because the account has a newer generation', () => {
    const account = clearedStore(at('acct', [['清', true, 1000]]), 90000, 'acctgen');
    recordAnswer(account, 'reading', '清', true, 91000);
    const anon = at('anon', [['晴', true, 2000]]);
    const m = adoptAnonymous(account, anon);
    expect(m.gen).toEqual({ t: 90000, id: 'acctgen' });
    expect(totalsOf(m).scores.reading).toEqual({ c: 2, n: 2 });
    expect(m.srs['reading:晴'].r).toBe(2000);
    // the ordinary merge alone would have thrown the anonymous data away
    expect(totalsOf(mergeStores(account, anon)).scores.reading).toEqual({ c: 1, n: 1 });
  });

  it('combines with an anonymous restore rather than replacing the account', () => {
    const account = at('acct', [['清', true, 1000]]);
    const backup = at('old', [['晴', true, 500], ['青', false, 600]]);
    const restored = restoredStore(at('anon', []), backup, 70000, 'restoregen');
    const m = adoptAnonymous(account, restored);
    expect(m.gen).toEqual(account.gen);
    expect(totalsOf(m).scores.reading).toEqual({ c: 2, n: 3 });
    expect(Object.keys(m.srs).sort()).toEqual(['reading:晴', 'reading:清', 'reading:青'].sort());
  });

  it('counts a backup and its source device’s later, separate history as two histories', () => {
    // Device A backs up 1/1, clears, then records one miss, so the account holds A at 0/1.
    const sourceDevice = at('devA', [['清', true, 1000]]);
    const backup = JSON.parse(JSON.stringify(sourceDevice));
    const account = clearedStore(sourceDevice, 2000, 'cleared');
    recordAnswer(account, 'reading', '清', false, 3000);
    expect(totalsOf(account).scores.reading).toEqual({ c: 0, n: 1 });

    const restored = restoredStore(at('other', []), backup, 4000, 'restoregen');
    const m = adoptAnonymous(account, restored);
    expect(totalsOf(m).scores.reading).toEqual({ c: 1, n: 2 });
    expect(totalsOf(m).kanji['清']).toEqual({ c: 1, n: 2 });
  });

  it('counts the same backup once when two browsers restore and adopt it', () => {
    const backup = JSON.parse(JSON.stringify(at('devA', [['清', true, 1000], ['晴', false, 1100]])));
    const account = at('acct', [['青', true, 500]]);
    const first = restoredStore(at('browser1', []), backup, 4000, 'gen1');
    const second = restoredStore(at('browser2', []), backup, 5000, 'gen2');

    const m = adoptAnonymous(adoptAnonymous(account, first), second);
    expect(totalsOf(m).scores.reading).toEqual({ c: 2, n: 3 });
    expect(totalsOf(m).kanji['清']).toEqual({ c: 1, n: 1 });
    expect(JSON.stringify(m)).toBe(JSON.stringify(adoptAnonymous(adoptAnonymous(account, second), first)));
  });

  it('into an empty account, keeps everything', () => {
    const anon = at('anon', [['清', true, 1000]]);
    const m = adoptAnonymous(blankStore(), anon);
    expect(totalsOf(m).scores.reading).toEqual({ c: 1, n: 1 });
    expect(m.log).toHaveLength(1);
  });

  it('then the ordinary merge with another device of the account loses nothing', () => {
    const account = at('acct', [['清', true, 1000]]);
    const adopted = adoptAnonymous(account, at('anon', [['晴', true, 2000]]));
    const other = at('acct', [['清', true, 1000], ['青', true, 3000]]);
    const m = mergeStores(adopted, other);
    expect(totalsOf(m).scores.reading).toEqual({ c: 3, n: 3 });
  });

  it('survives garbage from either side', () => {
    expect(adoptAnonymous(null, 'x')).toEqual(blankStore());
  });
});
