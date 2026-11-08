import { describe, expect, it } from 'vitest';
import { compare, parseJmdict, parseKanjidic, readingsInData, wordsInData } from '../scripts/check-dictionary.js';

const JMDICT = `<JMdict>
<entry><k_ele><keb>青空</keb></k_ele><r_ele><reb>あおぞら</reb></r_ele></entry>
<entry><k_ele><keb>工夫</keb></k_ele><k_ele><keb>功夫</keb></k_ele>
<r_ele><reb>くふう</reb><re_restr>工夫</re_restr></r_ele><r_ele><reb>クンフー</reb><re_restr>功夫</re_restr></r_ele></entry>
<entry><r_ele><reb>まあ</reb></r_ele></entry>
</JMdict>`;
const KANJIDIC = `<kanjidic2><character><literal>清</literal><reading_meaning><rmgroup>
<reading r_type="pinyin">qing1</reading><reading r_type="ja_on">セイ</reading><reading r_type="ja_on">ショウ</reading>
<reading r_type="ja_kun">きよ.い</reading></rmgroup></reading_meaning></character></kanjidic2>`;
const DATA = {
  families: [{ head: '青', on: 'セイ', members: [{ k: '清', on: 'セイ' }] }],
  compounds: { 青: [{ w: '青空', r: 'あおぞら', m: 'blue sky' }] },
  alt: { 清: [['ショウ', 'shō']] },
};

describe('reading the data', () => {
  it('finds every word and reading pair', () => {
    expect(wordsInData(DATA)).toEqual([{ w: '青空', r: 'あおぞら' }]);
  });
  it('splits a head with two readings', () => {
    const data = { families: [{ head: '生', on: 'セイ・ショウ', members: [] }], alt: {} };
    expect(readingsInData(data)).toEqual([{ k: '生', on: 'セイ' }, { k: '生', on: 'ショウ' }]);
  });
  it('finds family, member and alternate readings', () => {
    expect(readingsInData(DATA)).toEqual(expect.arrayContaining([
      { k: '青', on: 'セイ' }, { k: '清', on: 'セイ' }, { k: '清', on: 'ショウ' },
    ]));
  });
});

describe('reading the dictionaries', () => {
  it('pairs each word with its readings', () => {
    const pairs = parseJmdict(JMDICT);
    expect(pairs.has('青空|あおぞら')).toBe(true);
    expect(pairs.has('まあ|まあ')).toBe(true);
  });
  it('keeps a restricted reading to the word it names', () => {
    const pairs = parseJmdict(JMDICT);
    expect(pairs.has('工夫|くふう')).toBe(true);
    expect(pairs.has('功夫|くふう')).toBe(false);
  });
  it('reads on-readings only', () => {
    const readings = parseKanjidic(KANJIDIC);
    expect([...readings.get('清')]).toEqual(['セイ', 'ショウ']);
  });
});

describe('comparing', () => {
  const words = () => parseJmdict(JMDICT);
  const readings = () => parseKanjidic(KANJIDIC);
  it('finds nothing when all match', () => {
    const data = { ...DATA, families: [{ head: '清', on: 'セイ', members: [] }] };
    expect(compare(data, words(), readings())).toEqual({ words: [], readings: [] });
  });
  it('reports a word and a reading the dictionaries no longer have', () => {
    const data = { families: [{ head: '清', on: 'コウ', members: [] }], compounds: { 清: [{ w: '清空', r: 'せいくう' }] }, alt: {} };
    expect(compare(data, words(), readings())).toEqual({ words: [{ w: '清空', r: 'せいくう' }], readings: [{ k: '清', on: 'コウ' }] });
  });
  it('accepts a difference listed as known', () => {
    const data = { families: [{ head: '清', on: 'コウ', members: [] }], compounds: {}, alt: {} };
    expect(compare(data, words(), readings(), { readings: ['清|コウ'] }).readings).toEqual([]);
  });
});

describe('a bad download', () => {
  it('is refused rather than reported as differences', () => {
    expect(() => compare(DATA, new Set(), new Map(), {}, { minWords: 1 })).toThrow(/too small/);
  });
});
