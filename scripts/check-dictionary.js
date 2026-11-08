// Compares the words and readings in public/data.js with the latest JMdict and KANJIDIC.
// Exits 0 if they match, 1 if they differ, and 2 if the check itself couldn't run. Meanings are
// hand-edited and are not compared.
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const JMDICT_URL = 'https://www.edrdg.org/pub/Nihongo/JMdict_e.gz';
const KANJIDIC_URL = 'https://www.edrdg.org/kanjidic/kanjidic2.xml.gz';
const KNOWN_FILE = new URL('./dictionary-known.json', import.meta.url);
// The real files are far larger than this, so anything smaller is a broken download.
const SIZES = { minWords: 100000, minKanji: 10000 };

const all = (text, re) => [...text.matchAll(re)].map((m) => m[1]);

export function wordsInData(data) {
  return Object.values(data.compounds).flat().map(({ w, r }) => ({ w, r }));
}

export function readingsInData(data) {
  const found = [];
  for (const family of data.families) {
    // A family's head can show two readings joined with a dot.
    for (const on of family.on.split('・')) found.push({ k: family.head, on });
    for (const m of family.members) found.push({ k: m.k, on: m.on });
  }
  for (const [k, readings] of Object.entries(data.alt)) {
    for (const [on] of readings) found.push({ k, on });
  }
  return found;
}

export function parseJmdict(xml) {
  const pairs = new Set();
  for (const [entry] of xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)) {
    const words = all(entry, /<keb>([^<]+)<\/keb>/g);
    for (const [element] of entry.matchAll(/<r_ele>[\s\S]*?<\/r_ele>/g)) {
      const reading = all(element, /<reb>([^<]+)<\/reb>/g)[0];
      const only = all(element, /<re_restr>([^<]+)<\/re_restr>/g);
      if (element.includes('<re_nokanji')) { pairs.add(`${reading}|${reading}`); continue; }
      for (const word of only.length ? only : words) pairs.add(`${word}|${reading}`);
      pairs.add(`${reading}|${reading}`); // a word written in kana
    }
  }
  return pairs;
}

export function parseKanjidic(xml) {
  const readings = new Map();
  for (const [character] of xml.matchAll(/<character>[\s\S]*?<\/character>/g)) {
    const literal = all(character, /<literal>([^<]+)<\/literal>/g)[0];
    readings.set(literal, new Set(all(character, /<reading r_type="ja_on">([^<]+)<\/reading>/g)));
  }
  return readings;
}

const unique = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()];

// known holds differences already reviewed by hand, so each is reported only once.
export function compare(data, words, readings, known = {}, sizes = { minWords: 0, minKanji: 0 }) {
  if (words.size < sizes.minWords || readings.size < (sizes.minKanji ?? 0)) {
    throw new Error(`The dictionary download looks too small: ${words.size} words, ${readings.size} kanji.`);
  }
  const knownWords = new Set(known.words), knownReadings = new Set(known.readings);
  return {
    words: unique(wordsInData(data), (x) => `${x.w}|${x.r}`)
      .filter(({ w, r }) => !words.has(`${w}|${r}`) && !knownWords.has(`${w}|${r}`)),
    readings: unique(readingsInData(data), (x) => `${x.k}|${x.on}`)
      .filter(({ k, on }) => !readings.get(k)?.has(on) && !knownReadings.has(`${k}|${on}`)),
  };
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
}

function report({ words, readings }) {
  return [
    `The latest dictionary files differ from \`public/data.js\` in ${words.length + readings.length} places.`,
    '',
    'For each one, correct the data, or add it to `scripts/dictionary-known.json` if the data is right as it is.',
    '',
    ...words.map(({ w, r }) => `- Word not in JMdict: ${w} (${r})`),
    ...readings.map(({ k, on }) => `- Reading not in KANJIDIC: ${k} (${on})`),
  ].join('\n');
}

async function main() {
  const { DATA } = await import('../public/data.js');
  const known = JSON.parse(readFileSync(KNOWN_FILE, 'utf8'));
  const [jmdict, kanjidic] = await Promise.all([download(JMDICT_URL), download(KANJIDIC_URL)]);
  const result = compare(DATA, parseJmdict(jmdict), parseKanjidic(kanjidic), known, SIZES);
  if (result.words.length + result.readings.length === 0) {
    console.log('The words and readings match the latest dictionary files.');
    return 0;
  }
  const text = report(result);
  console.log(text);
  if (process.argv[2]) writeFileSync(process.argv[2], text);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(e.message); process.exit(2); });
}
