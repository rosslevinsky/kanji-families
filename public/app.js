import { DATA } from './data.js';
import {
  STORE_VERSION, blankStore, clearedStore, isUnreadable, mergeStores, migrateScores, migrateStore, recordAnswer, recordTest,
  restoredStore, sameGeneration, totalsOf,
} from './merge.js';
import { cleanSync, createSync, epochAfter, epochOf, ownerOf, withoutSync } from './sync.js';

const FAMILIES = DATA.families;
const MEANINGS = DATA.meanings;
const COMPOUNDS = DATA.compounds;
const ALT = DATA.alt;

// ---------- kana → romaji ----------
const KANA = {};
'あa いi うu えe おo かka きki くku けke こko さsa しshi すsu せse そso たta ちchi つtsu てte とto なna にni ぬnu ねne のno はha ひhi ふfu へhe ほho まma みmi むmu めme もmo やya ゆyu よyo らra りri るru れre ろro わwa をo んn がga ぎgi ぐgu げge ごgo ざza じji ずzu ぜze ぞzo だda ぢji づzu でde どdo ばba びbi ぶbu べbe ぼbo ぱpa ぴpi ぷpu ぺpe ぽpo ぁa ぃi ぅu ぇe ぉo'
  .split(' ').forEach(p => KANA[p[0]] = p.slice(1));
function romaji(s) {
  s = s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const out = []; let gem = false;
  for (const ch of s) {
    if (ch === 'っ') { gem = true; continue; }
    if ('ゃゅょ'.includes(ch) && out.length) {
      const v = {ゃ:'a', ゅ:'u', ょ:'o'}[ch], t = out.pop();
      out.push(/(shi|chi|ji)$/.test(t) ? t.slice(0, -1) + v : t.slice(0, -1) + 'y' + v);
      continue;
    }
    let t = KANA[ch];
    if (t === undefined) { out.push(ch === 'ー' ? (out.length ? out[out.length - 1].slice(-1) : '') : ch); continue; }
    if (gem) { t = (t.startsWith('ch') ? 't' : t[0]) + t; gem = false; }
    if (out.length && out[out.length - 1] === 'n' && /^[aiueoy]/.test(t)) out[out.length - 1] = "n'";
    out.push(t);
  }
  return out.join('').replace(/ou|oo/g, 'ō').replace(/uu/g, 'ū');
}

// ---------- lookup ----------
const INFO = {};
FAMILIES.forEach(f => {
  INFO[f.head] = Object.assign(INFO[f.head] || {k: f.head}, {headOf: f});
  if (!INFO[f.head].g) INFO[f.head].g = f.gloss;
  f.members.forEach(m => INFO[m.k] = Object.assign(INFO[m.k] || {}, {k: m.k, g: m.g, on: m.on, ro: m.ro, fam: f, m: m.m}));
});
MEANINGS.forEach(c => c.items.forEach(i => {
  INFO[i.k] = INFO[i.k] || {k: i.k, g: i.g};
  INFO[i.k].cat = c;
}));
Object.entries(DATA.traps).forEach(([k, g]) => { INFO[k] = INFO[k] || {k}; if (!INFO[k].g) INFO[k].g = g; });
Object.entries(ALT).forEach(([k, a]) => { if (INFO[k]) INFO[k].alt = a; });

const WORDS = [];
const WORD_INFO = {};
Object.entries(COMPOUNDS).forEach(([k, list]) => list.forEach(c => {
  if (WORD_INFO[c.w]) return;
  const wd = {w: c.w, r: c.r, m: c.m, src: k};
  WORD_INFO[c.w] = wd; WORDS.push(wd);
}));

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const rand = a => a[Math.floor(Math.random() * a.length)];
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const headOns = f => f.on.split('・');
const headOn1 = f => headOns(f)[0];
const headRo1 = f => f.ro.split(' / ')[0];
const glossOf = k => (WORD_INFO[k] && k.length > 1 ? WORD_INFO[k].m : INFO[k] && INFO[k].g) || '';
const altText = k => (INFO[k] && INFO[k].alt || []).map(([a, r]) => `${a} (${r})`).join(', ');

const MODES = {
  reading: {name: 'Sound → reading', blurb: 'See a kanji, pick its on’yomi using the sound part.'},
  words:   {name: 'Read the word', blurb: 'See a common word, pick how it’s read.'},
  gloss:   {name: 'Kanji → meaning', blurb: 'See a kanji, pick its English meaning.'},
  odd:     {name: 'Odd one out', blurb: 'Four kanji share a sound part. Find the one that reads differently.'},
  meaning: {name: 'Meaning component', blurb: 'Pick the category the kanji’s meaning part points to. Always 10 questions.', fixedLen: 10}
};
const MODE_NAMES = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, v.name]));

function compoundsHTML(k) {
  const list = COMPOUNDS[k];
  if (!list) return '';
  return `<ul class="comps">${list.map(c => `
    <li><button class="w" lang="ja" data-k="${esc(c.w)}">${esc(c.w)}</button>
    <span class="rd"><span lang="ja">${esc(c.r)}</span><span>${esc(romaji(c.r))}</span></span>
    <span class="mn">${esc(c.m)}</span></li>`).join('')}</ul>`;
}

// ---------- progress store ----------
// The browser copy is the shared truth between tabs. Every change re-reads it, applies the change
// and writes it back, inside a Web Lock where there is one, so no tab overwrites another's answers.
// `store` and `totals` are this tab's view of it, for display only.
const STORE_KEY = 'kfd-progress';
const LEGACY_SCORES_KEY = 'kfd-scores';
const UNREADABLE_KEY = 'kfd-progress-unreadable';
const LOCK_NAME = 'kfd-progress';
// Tabs in separate processes see a write a moment after it happens, and a Web Lock doesn't wait
// for that. Holding the lock this long lets the write arrive before the next tab reads.
const WRITE_SETTLE_MS = 40;

function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
}

// True while the browser copy can't be read and couldn't be set aside, so it mustn't be written over.
let unreadableAtRisk = false;

// Sets aside a copy that can't be read, before the next write replaces it. Each different copy
// gets its own key, and reading the same one again adds nothing.
function keepUnreadable(raw) {
  try {
    for (let i = 0; ; i++) {
      const key = i ? `${UNREADABLE_KEY}-${i}` : UNREADABLE_KEY;
      const held = localStorage.getItem(key);
      if (held === raw) return;
      if (held === null) { localStorage.setItem(key, raw); return; }
    }
  } catch (e) { unreadableAtRisk = true; }
}

function readLocal(device) {
  unreadableAtRisk = false;
  let raw = null;
  try { raw = localStorage.getItem(STORE_KEY); } catch (e) {}
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const s = migrateStore(parsed, device);
      if (!isUnreadable(parsed, s)) {
        const sync = cleanSync(parsed.sync);
        if (sync) s.sync = sync;
        if (typeof parsed.epoch === 'string' && parsed.epoch) s.epoch = parsed.epoch;
        return s;
      }
    } catch (e) {}
    keepUnreadable(raw);
  }
  try {
    const old = JSON.parse(localStorage.getItem(LEGACY_SCORES_KEY) || 'null');
    if (old) return migrateScores(old, device);
  } catch (e) {}
  return null;
}
const blankFor = device => ({...blankStore(), device});

let store, totals;
function setStore(s) { store = s; totals = totalsOf(s); }
setStore(readLocal(randomId()) || blankFor(randomId()));

// True while this tab holds changes the browser copy couldn't take, such as when storage is full.
let unwritten = false;

// The latest browser copy, plus anything only this tab holds.
function latest() {
  const fresh = readLocal(store.device) || blankFor(store.device);
  // What this tab holds belongs to its owner. If another tab has changed the owner, it is gone.
  if (unwritten && ownerOf(fresh) !== ownerOf(store)) unwritten = false;
  if (!unwritten) return fresh;
  const merged = {...mergeStores(fresh, store), device: fresh.device};
  if (fresh.sync) merged.sync = fresh.sync;
  if (fresh.epoch) merged.epoch = fresh.epoch;
  return merged;
}

// change(copy) changes the copy and returns it, or returns null to change nothing. A change made
// here keeps the copy's owner and marks it as unsaved. Sync passes fromServer (true, or 'removed'
// when it replaces the copy with an empty one) and sets those itself.
function applyChange(change, fromServer) {
  const before = store.gen;
  const fresh = latest();
  const owned = fresh.sync;
  const was = {...fresh};
  const next = change(fresh);
  if (next) {
    if (!fromServer) {
      if (owned) next.sync = {...owned, dirty: true};
      else delete next.sync;
    }
    const epoch = epochAfter(was, next, fromServer, randomId);
    if (epoch) next.epoch = epoch;
    else delete next.epoch;
    if (unreadableAtRisk) unwritten = true;
    else {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); unwritten = false; }
      catch (e) { unwritten = true; }
    }
  }
  setStore(next || fresh);
  if (!sameGeneration(before, store.gen)) {
    // Only for an account's own copy: adopting or removing a copy changes its generation too.
    if (fromServer === true && owned && hasActiveTest()) showNotice('generation');
    resetActiveTests();
  }
}

function commit(change, fromServer = false) {
  if (!navigator.locks) { applyChange(change, fromServer); return Promise.resolve(); }
  let applied = false;
  return new Promise(resolve => {
    navigator.locks.request(LOCK_NAME, () => {
      applied = true;
      applyChange(change, fromServer);
      resolve(); // the page goes on at once; only the next writer waits for the settle time
      return new Promise(done => setTimeout(done, WRITE_SETTLE_MS));
    }).catch(() => { // the lock was refused: this is the same as having no locks
      if (applied) return;
      applyChange(change, fromServer);
      resolve();
    });
  });
}

// A copy in an older format is written back once, so its migration is never run again.
function upgradeLocal() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const old = raw ? JSON.parse(raw).v !== STORE_VERSION : localStorage.getItem(LEGACY_SCORES_KEY) !== null;
    if (old) commit(copy => copy);
  } catch (e) {}
}

// ---------- spaced repetition ----------
const srsKey = (mode, key) => mode + ':' + key;
function srsOf(mode, key) { return store.srs[srsKey(mode, key)]; }
function dueCands(mode) {
  const now = Date.now();
  return CANDS[mode].filter(c => { const s = srsOf(mode, c.key); return s && s.d <= now; })
    .sort((a, b) => srsOf(mode, a.key).b - srsOf(mode, b.key).b || srsOf(mode, a.key).d - srsOf(mode, b.key).d);
}
function newCands(mode) { return CANDS[mode].filter(c => !srsOf(mode, c.key)); }
function nextDue(mode) {
  let min = Infinity;
  CANDS[mode].forEach(c => { const s = srsOf(mode, c.key); if (s && s.d < min) min = s.d; });
  return min;
}
function untilText(t) {
  const s = (t - Date.now()) / 1000;
  if (s <= 0) return 'now';
  if (s < 3600) return 'in ' + Math.ceil(s / 60) + ' min';
  if (s < 86400) return 'in ' + Math.round(s / 3600) + ' h';
  const d = Math.round(s / 86400);
  return d === 1 ? 'tomorrow' : 'in ' + d + ' days';
}

// ---------- study view ----------
$('#families').innerHTML = FAMILIES.map(f => `
  <article class="fam">
    <div class="fam-head">
      <button class="cell" lang="ja" data-k="${f.head}" aria-label="${f.head}: ${esc(f.gloss)}">${f.head}</button>
      <div class="meta">
        <div class="rd" lang="ja">${f.on}<small>${esc(f.ro)}</small></div>
        <div class="gl">${esc(f.gloss)}</div>
      </div>
      <button class="famtest" data-fam="${f.head}">Test me</button>
    </div>
    <div class="members">
      ${f.members.map(m => `
        <button class="mem m-${m.m}" data-k="${m.k}" aria-label="${m.k}: ${esc(m.g)}">
          <span class="k" lang="ja">${m.k}</span>
          <span class="r"><span lang="ja">${m.on}</span> ${esc(m.ro)}</span>
          <span class="g">${esc(m.g)}</span>
        </button>`).join('')}
    </div>
  </article>`).join('');
$('#fam-count').textContent = `${FAMILIES.length} sound families, ${FAMILIES.reduce((s, f) => s + f.members.length, 0)} kanji`;

$('#meanings').innerHTML = MEANINGS.map(m => `
  <tr><td class="rad" lang="ja">${m.rad}</td><td class="lbl">${esc(m.label)}</td>
  <td class="ex">${m.items.map(i => `<button class="kbtn" data-k="${i.k}" title="${esc(i.g)}"><span lang="ja">${i.k}</span><small>${esc(i.g)}</small></button>`).join('')}</td></tr>`).join('');

// ---------- search ----------
const SEARCH_KANJI = Object.values(INFO).filter(i => i.g);
function runSearch(q) {
  const out = $('#search-results');
  q = q.trim();
  if (!q) { out.innerHTML = ''; return; }
  const lq = q.toLowerCase();
  const hira = q.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const kanjiHits = [], seen = new Set();
  const add = i => { if (!seen.has(i.k)) { seen.add(i.k); kanjiHits.push(i); } };
  [...q].forEach(ch => { if (INFO[ch]) add(INFO[ch]); });
  if (/[a-z]/i.test(q) || /[ぁ-んァ-ン]/.test(q)) {
    SEARCH_KANJI.forEach(i => {
      const ro = (i.ro || '').toLowerCase(), on = i.on ? i.on.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)) : '';
      if ((lq.length >= 2 && i.g.toLowerCase().includes(lq)) || ro === lq || romaji(on) === lq || (on && on === hira)) add(i);
    });
  }
  const wordHits = WORDS.filter(w => w.w.includes(q) || w.r === hira || romaji(w.r) === lq || (lq.length >= 3 && w.m.toLowerCase().includes(lq))).slice(0, 12);
  if (!kanjiHits.length && !wordHits.length) { out.innerHTML = `<p class="empty">Nothing found for “${esc(q)}”. Try a kanji, an English word, or a reading like “sei”.</p>`; return; }
  out.innerHTML = `
    ${kanjiHits.length ? `<div class="hits">${kanjiHits.slice(0, 24).map(i => `
      <button class="hit" data-k="${esc(i.k)}"><span class="k" lang="ja">${esc(i.k)}</span>
      <span class="t">${esc(i.g)}${i.on ? `<span class="r" lang="ja"> · ${i.on} ${esc(i.ro)}</span>` : ''}</span></button>`).join('')}</div>` : ''}
    ${wordHits.length ? `<div class="hits">${wordHits.map(w => `
      <button class="hit" data-k="${esc(w.w)}"><span class="k" lang="ja">${esc(w.w)}</span>
      <span class="t">${esc(w.m)}<span class="r"> · <span lang="ja">${esc(w.r)}</span> ${esc(romaji(w.r))}</span></span></button>`).join('')}</div>` : ''}`;
}
let searchTimer = null;
$('#search').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(e.target.value), 150); });
$('#search-form').addEventListener('submit', e => { e.preventDefault(); runSearch($('#search').value); });

// ---------- detail sheet ----------
let lastFocus = null;
function detailHTML(k) {
  if (k.length > 1) {
    const w = WORD_INFO[k];
    const parts = [...k].filter(ch => INFO[ch]);
    return `
      <div class="sheet-top">
        <div class="cell wide" lang="ja">${esc(k)}</div>
        <div class="info">
          <div class="g" id="sheet-title">${esc(w ? w.m : '')}</div>
          ${w ? `<div class="o"><span lang="ja">${esc(w.r)}</span> · ${esc(romaji(w.r))}</div>` : ''}
        </div>
        <button class="close" id="close" aria-label="Close">×</button>
      </div>
      ${parts.length ? `<h3>Kanji in this word</h3><div class="hits">${parts.map(ch => `
        <button class="hit" data-k="${ch}"><span class="k" lang="ja">${ch}</span><span class="t">${esc(INFO[ch].g || '')}${INFO[ch].on ? `<span class="r" lang="ja"> · ${INFO[ch].on}</span>` : ''}</span></button>`).join('')}</div>` : ''}
      ${recordLine(k)}`;
  }
  const info = INFO[k] || {k};
  let reading = '';
  if (info.on) reading = `On'yomi <span lang="ja">${info.on}</span> (${esc(info.ro)})${info.alt ? `, also <span lang="ja">${esc(altText(k))}</span>` : ''}`;
  else if (info.headOf) reading = `On'yomi <span lang="ja">${info.headOf.on}</span> (${esc(info.headOf.ro)})`;
  const famLine = info.fam
    ? `Sound family <span lang="ja">${info.fam.head}</span> (${info.fam.on}). ${info.m === 'e' ? 'Same reading as the sound part.' : info.m === 'n' ? 'Close to the sound part’s reading.' : 'Reads differently from the sound part.'}`
    : info.headOf ? `Sound part for ${info.headOf.members.length} kanji in this guide.` : '';
  const catLine = info.cat ? `Meaning part <span lang="ja">${info.cat.rad.split(' ')[0]}</span>: ${esc(info.cat.label)}.` : '';
  return `
    <div class="sheet-top">
      <div class="cell" lang="ja">${esc(k)}</div>
      <div class="info">
        <div class="g" id="sheet-title">${esc(info.g || '')}</div>
        ${reading ? `<div class="o">${reading}</div>` : ''}
      </div>
      <button class="close" id="close" aria-label="Close">×</button>
    </div>
    ${famLine ? `<p class="fam-link">${famLine}</p>` : ''}
    ${catLine ? `<p class="fam-link">${catLine}</p>` : ''}
    ${COMPOUNDS[k] ? `<h3>Common words</h3>${compoundsHTML(k)}` : ''}
    ${recordLine(k)}`;
}
function recordLine(k) {
  const rec = totals.kanji[k];
  return `<p class="record">${rec ? `Your record: ${rec.c} of ${rec.n} correct.` : 'Not practiced yet.'}</p>`;
}
function openDetail(k) {
  $('#sheet').innerHTML = detailHTML(k);
  if ($('#overlay').hidden) lastFocus = document.activeElement;
  $('#overlay').hidden = false;
  $('#close').onclick = closeDetail;
  $('#close').focus();
}
function closeDetail() {
  $('#overlay').hidden = true;
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
$('#overlay').addEventListener('click', e => { if (e.target.id === 'overlay') closeDetail(); });
document.addEventListener('click', e => {
  const ft = e.target.closest('[data-fam]');
  if (ft) { startFamilyTest(ft.dataset.fam); return; }
  const t = e.target.closest('[data-k]');
  if (t) openDetail(t.dataset.k);
});

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', on);
    $('#' + t.dataset.tab).hidden = !on;
  });
  if (name === 'history') renderHistory();
  if (name === 'practice') renderStage();
}
document.querySelectorAll('.tab').forEach(t => t.onclick = () => showTab(t.dataset.tab));

// ---------- question builders ----------
const ALL_MEMBERS = FAMILIES.flatMap(f => f.members.map(m => ({...m, fam: f})));
const ALL_READINGS = (() => {
  const map = new Map();
  FAMILIES.forEach(f => map.set(headOn1(f), headRo1(f)));
  ALL_MEMBERS.forEach(m => map.set(m.on, m.ro));
  return [...map].map(([on, ro]) => ({on, ro}));
})();
const altKanas = k => (ALT[k] || []).map(a => a[0]);

const ODD_SETS = FAMILIES.flatMap(f => {
  const groups = {};
  f.members.forEach(m => (groups[m.on] = groups[m.on] || []).push(m));
  return Object.entries(groups)
    .map(([on, g]) => ({fam: f, on, same: g, odd: f.members.filter(m => m.on !== on && !altKanas(m.k).includes(on))}))
    .filter(s => s.same.length >= 3 && s.odd.length);
});

function buildReading(m) {
  const opts = [{on: m.on, ro: m.ro}];
  const avoid = new Set([m.on, ...altKanas(m.k)]);
  const h = headOn1(m.fam);
  if (!avoid.has(h)) { opts.push({on: h, ro: headRo1(m.fam)}); avoid.add(h); }
  for (const r of shuffle(ALL_READINGS)) {
    if (opts.length >= 4) break;
    if (!avoid.has(r.on)) { opts.push(r); avoid.add(r.on); }
  }
  const f = m.fam;
  let why;
  if (m.m === 'e') why = `The sound part ${f.head} reads ${f.on} (${f.ro}), and so does ${m.k}.`;
  else if (m.m === 'n') why = `Close: the sound part ${f.head} reads ${f.on} (${f.ro}), but ${m.k} reads ${m.on} (${m.ro}).`;
  else why = `Exception: the sound part ${f.head} reads ${f.on} (${f.ro}), but ${m.k} reads ${m.on} (${m.ro}).`;
  if (ALT[m.k]) why += ` It can also be read ${altText(m.k)}.`;
  return {
    type: 'reading', kanji: m.k, focus: m.k, prompt: 'What is the on’yomi?',
    hint: `Look for the sound part ${f.head}.`,
    options: shuffle(opts).map(o => ({key: o.on, main: o.on, sub: o.ro})),
    answer: m.on,
    explain: `${m.k} means “${m.g}.” ${why}`
  };
}

const WORDS_BY_LEN = {};
WORDS.forEach(w => (WORDS_BY_LEN[w.w.length] = WORDS_BY_LEN[w.w.length] || []).push(w));
function buildWord(wd) {
  const pool = (WORDS_BY_LEN[wd.w.length] || WORDS).filter(x => x.r !== wd.r);
  const sharing = shuffle(pool.filter(x => [...x.w].some(ch => wd.w.includes(ch))));
  const similar = shuffle(pool.filter(x => Math.abs(x.r.length - wd.r.length) <= 1));
  const opts = [wd.r];
  for (const x of [...sharing, ...similar, ...shuffle(pool)]) {
    if (opts.length >= 4) break;
    if (!opts.includes(x.r)) opts.push(x.r);
  }
  const parts = [...wd.w].filter(ch => INFO[ch] && INFO[ch].on).map(ch => `${ch} ${INFO[ch].on}`);
  return {
    type: 'words', kanji: wd.w, focus: wd.w, wide: true, prompt: 'How is this word read?',
    hint: `It means “${wd.m}.”`,
    options: shuffle(opts).map(r => ({key: r, main: r, sub: romaji(r)})),
    answer: wd.r,
    explain: `${wd.w} is read ${wd.r} (${romaji(wd.r)}) and means “${wd.m}.”${parts.length ? ` Kanji readings: ${parts.join(', ')}.` : ''}`
  };
}

const GLOSS_KANJI = [];
{
  const seen = new Set();
  const push = k => { if (!seen.has(k) && INFO[k] && INFO[k].g && !INFO[k].g.startsWith('(')) { seen.add(k); GLOSS_KANJI.push(k); } };
  ALL_MEMBERS.forEach(m => push(m.k));
  MEANINGS.forEach(c => c.items.forEach(i => push(i.k)));
  Object.keys(DATA.traps).forEach(push);
}
function buildGloss(k) {
  const g = INFO[k].g;
  const opts = [g];
  for (const o of shuffle(GLOSS_KANJI)) {
    if (opts.length >= 4) break;
    const og = INFO[o].g;
    if (!opts.includes(og)) opts.push(og);
  }
  const info = INFO[k];
  return {
    type: 'gloss', kanji: k, focus: k, prompt: 'What does this kanji mean?',
    hint: info.cat ? `Its meaning part points to “${info.cat.label}.”` : info.on ? `It reads ${info.on} (${info.ro}).` : 'Think of a word you know that uses it.',
    options: shuffle(opts).map(o => ({key: o, main: o, plain: true})),
    answer: g,
    explain: `${k} means “${g}.”${info.on ? ` On’yomi ${info.on} (${info.ro}).` : ''}`
  };
}

function buildOdd(s, odd) {
  const picks = shuffle([...shuffle(s.same).slice(0, 3), odd]);
  const same = s.same[0];
  return {
    type: 'odd', focus: odd.k, prompt: 'Which one has a different on’yomi?',
    hint: `All four contain ${s.fam.head}.`,
    options: picks.map(m => ({key: m.k, main: m.k, sub: `${m.on} ${m.ro}`, kanji: true, hideSub: true})),
    answer: odd.k,
    explain: `${odd.k} (“${odd.g}”) reads ${odd.on} (${odd.ro}). The others read ${same.on} (${same.ro}).`
  };
}

function buildMeaning(cat, item) {
  const others = shuffle(MEANINGS.filter(c => c !== cat)).slice(0, 3);
  const opts = shuffle([cat, ...others]);
  return {
    type: 'meaning', kanji: item.k, focus: item.k, prompt: 'Which category does its meaning part point to?',
    hint: 'Look at the left side, the top, or the part that wraps around.',
    options: opts.map(c => ({key: c.label, main: c.label, plain: true})),
    answer: cat.label,
    explain: `${item.k} means “${item.g}.” Its meaning part is ${cat.rad.split(' ')[0]} (${cat.label}).`
  };
}

const CANDS = {
  reading: ALL_MEMBERS.map(m => ({key: m.k, fam: m.fam, build: () => buildReading(m)})),
  words: WORDS.map(w => ({key: w.w, fam: null, build: () => buildWord(w)})),
  gloss: GLOSS_KANJI.map(k => ({key: k, fam: INFO[k].fam, build: () => buildGloss(k)})),
  odd: ODD_SETS.flatMap(s => s.odd.map(o => ({key: o.k, fam: s.fam, build: () => buildOdd(s, o)}))),
  meaning: MEANINGS.flatMap(c => c.items.map(i => ({key: i.k, fam: INFO[i.k] && INFO[i.k].fam, build: () => buildMeaning(c, i)})))
};
for (const m of Object.keys(CANDS)) {
  const seen = new Set();
  CANDS[m] = CANDS[m].filter(c => !seen.has(c.key) && seen.add(c.key));
}

// ---------- weighting ----------
function famMissRate(f) {
  if (!f) return 0;
  let c = 0, n = 0;
  f.members.forEach(m => { const r = totals.kanji[m.k]; if (r) { c += r.c; n += r.n; } });
  return n ? (n - c) / n : 0;
}
function isWeak(k) { const r = totals.kanji[k]; return !!r && r.n > r.c && r.c / r.n < 0.8; }
function weightOf(cand) {
  const r = totals.kanji[cand.key];
  const w = !r ? 1.5 : 1 + 6 * ((r.n - r.c) / r.n) * Math.min(r.n, 3) / 3;
  return w * (1 + famMissRate(cand.fam));
}
function wsample(items, n) {
  const pool = items.map(x => ({x, w: weightOf(x)}));
  const out = [];
  while (out.length < n && pool.length) {
    let r = Math.random() * pool.reduce((s, p) => s + p.w, 0), i = 0;
    for (; i < pool.length - 1; i++) { r -= pool[i].w; if (r <= 0) break; }
    out.push(pool[i].x); pool.splice(i, 1);
  }
  return out;
}

// ---------- tests ----------
let mode = 'reading';
const tests = {}; Object.keys(MODES).forEach(m => tests[m] = null);
let setup = { len: 20, focus: 'due' };
try { const s = JSON.parse(localStorage.getItem('kfd-setup') || 'null'); if (s && [10, 20, 30].includes(s.len)) setup = {len: s.len, focus: ['due', 'mixed', 'weak'].includes(s.focus) ? s.focus : 'due'}; } catch (e) {}
let streak = 0;
const FOCUS_NAMES = {due: 'Review', mixed: 'Mixed', weak: 'Weak spots', family: 'Family'};

function makeTest(focus, len, onlyKeys, label) {
  const all = CANDS[mode];
  let picks, note = '';
  if (onlyKeys) {
    picks = shuffle(all.filter(c => onlyKeys.includes(c.key)));
  } else if (focus === 'due') {
    const due = dueCands(mode).slice(0, len);
    const fresh = newCands(mode).slice(0, len - due.length);
    picks = shuffle(due).concat(fresh);
    if (picks.length < len) {
      const extra = wsample(all.filter(c => !picks.includes(c)), len - picks.length);
      picks = picks.concat(extra);
      note = `${due.length} due for review and ${fresh.length} new. The other ${extra.length} lean toward kanji you miss, as extra practice that won’t change your schedule much.`;
    } else note = `${due.length} due for review${fresh.length ? `, ${fresh.length} new` : ''}.`;
  } else if (focus === 'weak') {
    const weak = all.filter(c => isWeak(c.key));
    picks = shuffle(weak).slice(0, len);
    if (picks.length < len) {
      const rest = wsample(all.filter(c => !picks.includes(c)), len - picks.length);
      note = weak.length
        ? `You have ${weak.length} weak spots in this quiz type, so the other ${rest.length} questions lean toward ones you haven't mastered.`
        : 'No weak spots yet in this quiz type, so this test leans toward ones you haven’t practiced.';
      picks = shuffle(picks.concat(rest));
    }
  } else {
    picks = wsample(all, len);
  }
  if (picks.length < len && !onlyKeys) note = (note ? note + ' ' : '') + `This quiz type has ${all.length} questions in total.`;
  return { mode, focus, label, list: picks.map(c => ({q: c.build(), chosen: null, hint: false})), i: 0, view: 'q', done: false, note };
}
const T = () => tests[mode];
const cur = () => T() && T().list[T().i];

function setMode(m) {
  mode = m; streak = 0;
  document.querySelectorAll('.mode').forEach(x => x.setAttribute('aria-pressed', x.dataset.mode === m));
}
function startFamilyTest(head) {
  const f = FAMILIES.find(x => x.head === head);
  if (!f) return;
  setMode('reading');
  tests.reading = makeTest('family', f.members.length, f.members.map(m => m.k), `Family ${head}`);
  showTab('practice');
  try { window.scrollTo({top: 0}); } catch (e) {}
}

// ---------- practice render ----------
function renderScore() {
  const s = totals.scores[mode];
  const pct = s.n ? Math.round(100 * s.c / s.n) + '%' : '–';
  $('#score').innerHTML = `<span>All-time: <b>${s.c}</b> of <b>${s.n}</b> correct (${pct})</span><span>Due now: <b>${dueCands(mode).length}</b></span><span>Streak <b>${streak}</b></span>`;
}

function renderStage() {
  const t = T();
  if (!t) renderSetup();
  else if (t.view === 'list') renderResults();
  else renderQuestion();
  renderScore();
}

function renderSetup() {
  const M = MODES[mode];
  const weakCount = CANDS[mode].filter(c => isWeak(c.key)).length;
  const dueCount = dueCands(mode).length, newCount = newCands(mode).length;
  const nd = nextDue(mode);
  const notes = {
    due: dueCount
      ? `${dueCount} due for review now, then new ones (${newCount} not seen yet). Each right answer pushes the next review further out: 1 day, 3, 7, 14, 30, then 90. A miss starts it over.`
      : `Nothing due right now${Number.isFinite(nd) ? `; the next review is ${untilText(nd)}` : ''}. This test introduces new ones (${newCount} not seen yet).`,
    mixed: 'Drawn from everything, but kanji and sound families you miss come up more often.',
    weak: `Only ones you’ve missed and not yet mastered. You have ${weakCount} in this quiz type right now.`
  };
  $('#stage').innerHTML = `
    <div class="setup">
      <div><h2>New test: ${M.name}</h2><p class="note">${esc(M.blurb)}</p></div>
      ${M.fixedLen ? '' : `<div class="field"><span>Length</span>
        <div class="seg" id="seg-len">${[10, 20, 30].map(n => `<button data-v="${n}" aria-pressed="${setup.len === n}">${n} questions</button>`).join('')}</div>
      </div>`}
      <div class="field"><span>Questions</span>
        <div class="seg" id="seg-focus">
          <button data-v="due" aria-pressed="${setup.focus === 'due'}">Review schedule${dueCount ? ` (${dueCount} due)` : ''}</button>
          <button data-v="mixed" aria-pressed="${setup.focus === 'mixed'}">Mixed</button>
          <button data-v="weak" aria-pressed="${setup.focus === 'weak'}">Weak spots only</button>
        </div>
        <p class="note">${notes[setup.focus]}</p>
      </div>
      <div><button class="navbtn primary" id="start">Start test</button></div>
    </div>`;
  const save = () => { try { localStorage.setItem('kfd-setup', JSON.stringify(setup)); } catch (e) {} };
  document.querySelectorAll('#seg-len button').forEach(b => b.onclick = () => { setup.len = +b.dataset.v; save(); renderSetup(); });
  document.querySelectorAll('#seg-focus button').forEach(b => b.onclick = () => { setup.focus = b.dataset.v; save(); renderSetup(); });
  $('#start').onclick = () => { tests[mode] = makeTest(setup.focus, M.fixedLen || setup.len); streak = 0; renderStage(); };
}

function renderQuestion() {
  const t = T();
  const entry = t.list[t.i];
  const q = entry.q;
  const done = entry.chosen !== null;
  const answered = t.list.filter(e => e.chosen !== null).length;
  const atEnd = t.i >= t.list.length - 1;
  $('#stage').innerHTML = `
    ${t.note && t.i === 0 && !done ? `<p class="note" style="margin-bottom:12px">${esc(t.note)}</p>` : ''}
    <div style="display:grid;gap:12px">
      <div class="navrow">
        <button class="navbtn" id="prev" aria-label="Previous question"${t.i <= 0 ? ' disabled' : ''}>← Back</button>
        <span class="pos">${t.label ? esc(t.label) + ' · ' : ''}Question ${t.i + 1} of ${t.list.length}</span>
        <button class="navbtn${done && (atEnd ? t.done : true) ? ' primary' : ''}" id="next" aria-label="Next question">${atEnd ? (t.done ? 'See results →' : 'Results list →') : 'Next →'}</button>
      </div>
      <div class="bar" aria-hidden="true"><i style="width:${Math.round(100 * answered / t.list.length)}%"></i></div>
      <div class="qcard" id="qcard">
        <p class="prompt">${esc(q.prompt)}</p>
        ${q.kanji ? `<div class="cell big${q.wide ? ' wide' : ''}" lang="ja">${esc(q.kanji)}</div>` : ''}
        <div class="hintrow" id="hint">${entry.hint || done ? esc(q.hint) : '<button class="linkbtn" id="hintbtn">Show hint</button>'}</div>
        <div class="opts">${q.options.map((o, i) => {
          let cls = 'opt' + (o.kanji ? ' kanji-opt' : '') + (o.plain ? ' plain' : '');
          if (done && o.key === q.answer) cls += ' right';
          else if (done && o.key === entry.chosen) cls += ' wrong';
          return `<button class="${cls}" data-key="${esc(o.key)}"${done ? ' disabled' : ''}>
            <span class="num">${i + 1}</span>
            <span class="main"${o.plain ? '' : ' lang="ja"'}>${esc(o.main)}</span>
            ${o.sub ? `<span class="romaji"${o.hideSub && !done ? ' hidden' : ''}>${esc(o.sub)}</span>` : ''}
          </button>`;
        }).join('')}
        </div>
        ${done ? feedbackHTML(entry) : ''}
      </div>
      <div class="actions" style="justify-content:space-between;align-items:center">
        <button class="linkbtn" id="showlist">Show results list (${answered} of ${t.list.length} answered)</button>
        <span class="keys">Keys: 1–4 answer · ← → move · Enter next</span>
      </div>
    </div>`;
  const hb = $('#hintbtn');
  if (hb) hb.onclick = () => { entry.hint = true; $('#hint').textContent = q.hint; };
  document.querySelectorAll('#qcard .opt').forEach(b => b.onclick = () => answer(b.dataset.key));
  $('#prev').onclick = () => go(-1);
  $('#next').onclick = () => go(1);
  $('#showlist').onclick = () => { t.view = 'list'; renderStage(); };
}

function feedbackHTML(entry) {
  const q = entry.q, ok = entry.chosen === q.answer;
  const rec = totals.kanji[q.focus];
  const s = srsOf(mode, q.focus);
  let words = '';
  if (q.type === 'words') {
    const parts = [...q.focus].filter(ch => INFO[ch]);
    if (parts.length) words = `<div class="hits">${parts.map(ch => `<button class="hit" data-k="${ch}"><span class="k" lang="ja">${ch}</span><span class="t">${esc(INFO[ch].g || '')}</span></button>`).join('')}</div>`;
  } else if (COMPOUNDS[q.focus]) {
    words = `<div><b lang="ja">${q.focus}</b> in common words:</div>${compoundsHTML(q.focus)}`;
  }
  return `<div class="feedback ${ok ? 'good' : 'bad'}">
    <span class="verdict">${ok ? 'Correct.' : 'Not this time.'}</span>
    <span>${esc(q.explain)}</span>
    ${words}
    <span class="record">${rec ? `Your record on ${esc(q.focus)}: ${rec.c} of ${rec.n} correct.` : ''}${s ? ` Next review ${untilText(s.d)}.` : ''}</span>
  </div>`;
}

function optLabel(q, key) {
  if (key === null) return '—';
  const o = q.options.find(o => o.key === key);
  if (!o) return key;
  return o.sub && !o.kanji ? `${o.main} (${o.sub})` : o.main;
}

function renderResults() {
  const t = T();
  const answered = t.list.filter(e => e.chosen !== null);
  const right = answered.filter(e => e.chosen === e.q.answer).length;
  const missedKeys = t.list.filter(e => e.chosen !== null && e.chosen !== e.q.answer).map(e => e.q.focus);
  $('#stage').innerHTML = `
    <div style="display:grid;gap:14px">
      <div class="res-head">
        <div>
          <div class="eyebrow">${t.done ? 'Test complete' : 'Test in progress'} · ${esc(t.label || FOCUS_NAMES[t.focus])}</div>
          <div class="big-score">${right} / ${t.list.length}<small>${t.done ? Math.round(100 * right / t.list.length) + '% correct' : `${answered.length} answered so far`}</small></div>
        </div>
        ${t.done ? '' : '<button class="navbtn primary" id="resume">Back to questions</button>'}
      </div>
      <div class="res">${t.list.map((e, i) => {
        const q = e.q, state = e.chosen === null ? 'skip' : e.chosen === q.answer ? 'ok' : 'no';
        const label = state === 'skip' ? 'Not answered' : state === 'ok' ? 'Right' : 'Missed';
        const detail = state === 'skip' ? esc(q.prompt)
          : state === 'ok' ? `Answer: ${esc(optLabel(q, q.answer))}`
          : `<span class="you">You: ${esc(optLabel(q, e.chosen))}</span> · Answer: ${esc(optLabel(q, q.answer))}`;
        const g = glossOf(q.focus);
        return `<button class="res-row" data-i="${i}">
          <span class="n">${i + 1}</span>
          <span class="k${q.focus.length > 1 ? ' small' : ''}" lang="ja">${esc(q.focus)}</span>
          <span class="a">${detail}${g && q.type !== 'gloss' ? `<span class="you"> · ${esc(g)}</span>` : ''}</span>
          <span class="chip ${state}">${label}</span>
        </button>`;
      }).join('')}</div>
      <p class="note">Tap a row to open that question.</p>
      <div class="actions">
        ${t.done && missedKeys.length ? `<button class="navbtn primary" id="retest">Retest the ${missedKeys.length} missed</button>` : ''}
        <button class="navbtn${t.done && !missedKeys.length ? ' primary' : ''}" id="newtest">${t.done ? 'New test' : 'End test and start a new one'}</button>
      </div>
    </div>`;
  document.querySelectorAll('.res-row').forEach(r => r.onclick = () => { t.i = +r.dataset.i; t.view = 'q'; renderStage(); });
  const rs = $('#resume'); if (rs) rs.onclick = () => { t.view = 'q'; renderStage(); };
  const rt = $('#retest'); if (rt) rt.onclick = () => { tests[mode] = makeTest(t.focus, missedKeys.length, missedKeys, 'Retest'); streak = 0; renderStage(); };
  $('#newtest').onclick = () => { tests[mode] = null; renderStage(); };
}

function go(delta) {
  const t = T();
  if (!t) return;
  if (delta < 0) { if (t.i > 0) { t.i--; renderStage(); } return; }
  if (t.i < t.list.length - 1) { t.i++; renderStage(); return; }
  t.view = 'list'; renderStage();
}

function answer(key) {
  const t = T(), entry = cur();
  if (!entry || entry.chosen !== null) return;
  entry.chosen = key;
  const ok = key === entry.q.answer;
  if (ok) streak++; else streak = 0;
  const now = Date.now(), gen = store.gen, owner = ownerOf(store), epoch = epochOf(store), m = mode, focus = entry.q.focus;
  const finished = !t.done && t.list.every(e => e.chosen !== null);
  if (finished) t.done = true;
  const result = finished && {t: now, m, c: t.list.filter(e => e.chosen === e.q.answer).length, n: t.list.length, f: t.focus,
    miss: t.list.filter(e => e.chosen !== e.q.answer).map(e => e.q.focus).slice(0, 30)};
  commit(copy => {
    // Another tab cleared or restored first, so this answer belongs to data that is gone.
    if (!sameGeneration(copy.gen, gen)) return null;
    // Likewise if another tab has removed this account's copy, even if the generation looks the same.
    // An ownerless copy's answers are the person's own and stay, through adoption too.
    if (owner !== null && epochOf(copy) !== epoch) { resetActiveTests(); return null; }
    recordAnswer(copy, m, focus, ok, now);
    if (result) recordTest(copy, result);
    return copy;
  }).then(() => {
    renderStage();
    const nb = $('#next'); if (nb && cur() === entry) nb.focus({preventScroll: true});
    if (result) sync.save();
  });
}

$('#modes').innerHTML = Object.entries(MODES).map(([k, v]) => `<button class="mode" data-mode="${k}" aria-pressed="${k === mode}">${v.name}</button>`).join('');
document.querySelectorAll('.mode').forEach(b => b.onclick = () => { setMode(b.dataset.mode); renderStage(); });

document.addEventListener('keydown', e => {
  if (!$('#overlay').hidden) { if (e.key === 'Escape') closeDetail(); return; }
  if ($('#practice').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  const t = T();
  if (!t || t.view !== 'q') return;
  const entry = cur();
  if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  else if (entry.chosen === null && /^[1-4]$/.test(e.key)) {
    const b = document.querySelectorAll('#qcard .opt')[+e.key - 1];
    if (b) answer(b.dataset.key);
  } else if (entry.chosen !== null && e.key === 'Enter' && !['next', 'prev', 'showlist'].includes(document.activeElement?.id)) {
    go(1);
  }
});

// ---------- history ----------
const STATUS = {
  anon: 'Saved in this browser only. Use “Download backup” below to keep a copy.',
  checking: 'Saved in this browser. Checking your account…',
  synced: 'Signed in. Your progress is saved to your account and syncs between your devices.',
  unsaved: 'Signed in. Your latest answers are in this browser and will be saved to your account soon.',
  expired: 'Your sign-in has ended. Your answers stay in this browser. Sign in to the same account to save them.',
  unreachable: 'Couldn’t save to your account just now. Your answers are safe in this browser, and it will try again.',
  too_large: 'Your progress is over the 1 MB limit for an account, so your latest answers are only in this browser. Use “Download backup” below to keep a copy.',
};

function statusKey() {
  const {state, problem} = sync.status;
  if (problem) return problem;
  if (state === 'expired') return 'expired';
  if (state === 'active') return store.sync && store.sync.dirty ? 'unsaved' : 'synced';
  return ownerOf(store) === null ? 'anon' : 'checking';
}

// Rebuilt only when it differs, so a background save can't take focus from a button.
function setHtml(el, html) {
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}

let accountStep = null; // 'delete' or 'unsaved': a question waiting on the person's answer
let accountBusy = false;

function renderStatus() {
  const key = statusKey();
  setHtml($('#status'), `<span class="dot${key === 'synced' ? ' on' : ''}"></span><span>${esc(STATUS[key])}</span>`);
  renderAccount();
}

function renderAccount() {
  const {state, google, dev} = sync.status;
  const canSignIn = google || dev;
  const signIn = `${google ? '<button class="navbtn" id="sign-in-google">Sign in with Google</button>' : ''}
    ${dev ? '<button class="navbtn" id="sign-in-dev">Fake login (local only)</button>' : ''}`;
  const off = accountBusy ? ' disabled' : '';
  let html = '';
  if (state === 'anon' && canSignIn) {
    html = `<div class="account"><span class="note">Optional: sign in to sync your progress between devices. <a href="/privacy">Privacy</a></span><span class="actions">${signIn}</span></div>`;
  } else if (accountStep === 'unsaved') {
    html = `<div class="confirm"><span>Some answers couldn’t be saved to your account. Signing out removes them from this browser.</span>
      <button class="navbtn" id="sign-out-cancel">Cancel</button><button class="danger solid" id="sign-out-anyway"${off}>Sign out anyway</button></div>`;
  } else if (accountStep === 'delete') {
    html = `<div class="confirm"><span>Delete your saved progress from your account and this browser? This can’t be undone.</span>
      <button class="danger solid" id="delete-yes"${off}>Delete my data</button><button class="navbtn" id="delete-no">Keep it</button></div>`;
  } else if (state === 'expired') {
    html = `<div class="account"><span class="actions">${signIn}<button class="navbtn" id="sign-out"${off}>Sign out</button></span><a class="note" href="/privacy">Privacy</a></div>`;
  } else if (state === 'active') {
    html = `<div class="account"><span class="actions"><button class="navbtn" id="sign-out"${off}>${accountBusy ? 'Saving…' : 'Sign out'}</button><button class="danger" id="delete-data">Delete my data</button></span><a class="note" href="/privacy">Privacy</a></div>`;
  }
  setHtml($('#account'), html);
}

function setAccountStep(step, busy = false) { accountStep = step; accountBusy = busy; renderAccount(); }

async function signOut(force) {
  setAccountStep(accountStep, true);
  const outcome = await sync.signOut(force);
  setAccountStep(outcome === 'unsaved' ? 'unsaved' : null);
}

// The block is rebuilt freely, so its buttons are handled here rather than one by one.
$('#account').addEventListener('click', async e => {
  const id = e.target.id;
  if (id === 'sign-in-google') window.location.assign('/auth/login');
  else if (id === 'sign-in-dev') sync.devSignIn();
  else if (id === 'sign-out') signOut(false);
  else if (id === 'sign-out-cancel') setAccountStep(null);
  else if (id === 'sign-out-anyway') signOut(true);
  else if (id === 'delete-data') setAccountStep('delete');
  else if (id === 'delete-no') setAccountStep(null);
  else if (id === 'delete-yes') {
    setAccountStep('delete', true);
    await sync.deleteAccount();
    setAccountStep(null);
  }
});

// ---------- notices ----------
const NOTICES = {
  deleted: 'This account’s data was deleted on another device, so the copy in this browser was removed.',
  foreign: 'You signed in with a different account. The progress in this browser belonged to the other account, so it was removed from this browser and not added to this one.',
  delete_done: 'Your saved progress was deleted from your account and this browser.',
  generation: 'Your history was cleared or restored on another device, so the test in progress ended.',
  login_failed: 'Signing in didn’t work. Please try again.',
  sign_out_failed: 'Couldn’t reach the site, so you’re still signed in. Nothing was removed. Please try again.',
  delete_failed: 'Couldn’t delete your data just now. Nothing was removed. Please try again.',
  delete_needs_session: 'Your sign-in has ended. Sign in again to delete your data.',
  bad_state: 'That sign-in took too long or was started elsewhere. Please try again.',
  bad_request: 'Google didn’t finish the sign-in. Please try again.',
  google_failed: 'Couldn’t reach Google to finish signing in. Please try again.',
  bad_token: 'Google’s reply couldn’t be checked, so you weren’t signed in. Please try again.',
};

function showNotice(kind) {
  $('#notice').innerHTML = `<span>${esc(NOTICES[kind])}</span> <button class="linkbtn" id="notice-close">Dismiss</button>`;
  $('#notice').hidden = false;
  $('#notice-close').onclick = () => { $('#notice').hidden = true; };
}

// A failed login arrives as a fixed code in the address. Only known codes are shown, and it is
// removed so a reload doesn't say it again.
function showLoginError() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('login_error');
  if (code === null) return;
  showNotice(['bad_state', 'bad_request', 'google_failed', 'bad_token'].includes(code) ? code : 'login_failed');
  url.searchParams.delete('login_error');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : d + ' days ago';
}

let confirming = false;
let pendingImport = null;
function renderHistory() {
  renderStatus();
  $('#hist-modes').innerHTML = Object.keys(MODES).map(m => {
    const s = totals.scores[m];
    const learned = CANDS[m].filter(c => { const x = srsOf(m, c.key); return x && x.b >= 4; }).length;
    const started = CANDS[m].filter(c => srsOf(m, c.key)).length;
    return `<tr><td>${MODE_NAMES[m]}</td><td class="num">${s.n ? Math.round(100 * s.c / s.n) + '%' : '–'}</td>
      <td class="num">${dueCands(m).length}</td><td class="num">${started} / ${CANDS[m].length}</td><td class="num">${learned}</td></tr>`;
  }).join('');

  const pastTests = store.tests.slice(-15).reverse();
  $('#hist-tests').innerHTML = pastTests.length
    ? `<div class="log">${pastTests.map(x => `<div class="log-row" style="grid-template-columns:64px 1fr auto">
        <b style="font-variant-numeric:tabular-nums">${x.c}/${x.n}</b>
        <span class="d">${MODE_NAMES[x.m]} · ${FOCUS_NAMES[x.f] || 'Mixed'} · ${ago(x.t)}${x.miss.length ? ` · missed <span lang="ja">${x.miss.map(esc).join(' ')}</span>` : ''}</span>
        <span class="chip ${x.c / x.n >= 0.8 ? 'ok' : 'no'}">${Math.round(100 * x.c / x.n)}%</span></div>`).join('')}</div>`
    : '<p class="empty">No finished tests yet.</p>';

  const missed = Object.entries(totals.kanji).filter(([, v]) => v.n > v.c)
    .sort((a, b) => (b[1].n - b[1].c) - (a[1].n - a[1].c) || (a[1].c / a[1].n) - (b[1].c / b[1].n)).slice(0, 18);
  $('#hist-review').innerHTML = missed.length
    ? `<div class="review">${missed.map(([k, v]) => `<button class="rv" data-k="${esc(k)}"><span class="k${k.length > 1 ? ' small' : ''}" lang="ja">${esc(k)}</span><span class="s">${v.n - v.c} missed of ${v.n}</span></button>`).join('')}</div>`
    : '<p class="empty">Nothing to review yet. What you miss in Practice will show up here.</p>';

  const recent = store.log.slice(-40).reverse();
  $('#hist-log').innerHTML = recent.length
    ? `<div class="log">${recent.map(e => `<div class="log-row">
        <button class="k${e.k.length > 1 ? ' small' : ''}" lang="ja" data-k="${esc(e.k)}">${esc(e.k)}</button>
        <span class="d">${esc(glossOf(e.k))} · ${MODE_NAMES[e.m]} · ${ago(e.t)}</span>
        <span class="chip ${e.ok ? 'ok' : 'no'}">${e.ok ? 'Right' : 'Missed'}</span></div>`).join('')}</div>`
    : '<p class="empty">No answers yet. Head to Practice to start.</p>';

  renderBackup();

  const cb = $('#clear-block');
  cb.innerHTML = confirming
    ? `<div class="confirm"><span>Erase all history, scores and your review schedule? This can’t be undone.</span>
       <button class="danger solid" id="clear-yes">Erase history</button><button class="navbtn" id="clear-no">Keep it</button></div>`
    : '<div><button class="danger" id="clear">Clear history</button></div>';
  if (confirming) {
    $('#clear-yes').onclick = () => {
      confirming = false;
      const now = Date.now(), id = randomId();
      commit(copy => clearedStore(copy, now, id)).then(() => { renderAll(); sync.save(); });
    };
    $('#clear-no').onclick = () => { confirming = false; renderHistory(); };
  } else $('#clear').onclick = () => { confirming = true; renderHistory(); };
}

// A test in progress holds answers from the store it started on, so it can't outlive that store.
const hasActiveTest = () => Object.values(tests).some(t => t && !t.done);
function resetActiveTests() {
  Object.keys(tests).forEach(m => { tests[m] = null; });
  streak = 0;
}

// ---------- backup ----------
let backupMsg = '';
function renderBackup() {
  const el = $('#backup');
  el.innerHTML = `
    <div class="actions">
      <button class="navbtn" id="dl">Download backup</button>
      <label class="navbtn filebtn">Restore from backup<input type="file" id="restore-file" accept=".json,application/json"></label>
    </div>
    ${pendingImport ? `<div class="confirm"><span>Replace your current history with this backup (${pendingImport.log.length} answers, ${pendingImport.tests.length} tests)?</span>
      <button class="danger solid" id="imp-yes">Replace</button><button class="navbtn" id="imp-no">Cancel</button></div>` : ''}
    ${backupMsg ? `<p class="note" role="status">${esc(backupMsg)}</p>` : ''}`;
  $('#dl').onclick = downloadBackup;
  $('#restore-file').onchange = e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const s = migrateStore(JSON.parse(r.result), store.device);
        if (!s.log.length && !s.tests.length && !Object.keys(s.srs).length && !Object.keys(s.counters).length) throw new Error('empty');
        pendingImport = s; backupMsg = '';
      } catch (err) { pendingImport = null; backupMsg = 'That file isn’t a Kanji Family Drills backup. Choose the .json file saved with “Download backup.”'; }
      renderBackup();
    };
    r.readAsText(f);
  };
  if (pendingImport) {
    $('#imp-yes').onclick = () => {
      const backup = pendingImport, now = Date.now(), id = randomId();
      pendingImport = null; backupMsg = 'Backup restored.';
      commit(copy => restoredStore(copy, backup, now, id)).then(() => { renderAll(); sync.save(); });
    };
    $('#imp-no').onclick = () => { pendingImport = null; renderBackup(); };
  }
}
function downloadBackup() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(withoutSync(store))], {type: 'application/json'}));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'kanji-family-drills-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  backupMsg = 'Backup saved.';
  renderBackup();
}

// ---------- other tabs ----------
function renderAll() { renderHistory(); renderStage(); }

// Redraws from `store`. A test in progress keeps its question and focus; only the score line changes.
function refreshView() {
  if (!$('#history').hidden) renderHistory();
  if (!$('#practice').hidden) { if (T()) renderScore(); else renderStage(); }
}

// Shows what another tab wrote. It never writes, so a tab can't overwrite newer data with its
// own older view.
function refreshFromLocal() {
  const before = store.gen, owner = ownerOf(store), syncedAt = store.sync ? store.sync.syncedAt : 0;
  setStore(latest());
  const lostOwner = owner !== null && ownerOf(store) !== owner;
  if (lostOwner) forgetAccountState();
  if (lostOwner || !sameGeneration(before, store.gen)) { resetActiveTests(); renderAll(); }
  else refreshView();
  // Another tab signed in or out, so this one's picture of the account is out of date.
  if (ownerOf(store) !== owner || (sync.status.state === 'expired' && store.sync && store.sync.syncedAt > syncedAt)) sync.start();
}
window.addEventListener('storage', e => { if (e.key === STORE_KEY || e.key === null) refreshFromLocal(); });
window.addEventListener('pageshow', e => { if (e.persisted) refreshFromLocal(); });

// ---------- sync ----------
// Questions and files in progress belong to the copy being removed.
function forgetAccountState() {
  accountStep = null; accountBusy = false; confirming = false; pendingImport = null; backupMsg = '';
}

function removeLeftovers() {
  try {
    localStorage.removeItem(LEGACY_SCORES_KEY);
    for (let i = 0; ; i++) {
      const key = i ? `${UNREADABLE_KEY}-${i}` : UNREADABLE_KEY;
      if (localStorage.getItem(key) === null) break;
      localStorage.removeItem(key);
    }
  } catch (e) {}
}

// Removes everything this browser holds of an account, and gives it a new device ID.
function emptyCopy() {
  unwritten = false; unreadableAtRisk = false;
  removeLeftovers();
  return blankFor(randomId());
}

function afterRemoval() {
  forgetAccountState();
  resetActiveTests();
  renderAll();
}

// Holds the Web Lock until work finishes. Unlike commit it doesn't wait for the settle time, because
// work's writes are done by the time it returns. If locks are missing or refused, it just runs work.
async function holdLock(work) {
  if (!navigator.locks) return work();
  let started = false;
  try {
    return await navigator.locks.request(LOCK_NAME, () => { started = true; return work(); });
  } catch (e) {
    if (started) throw e;
    return work();
  }
}

const sync = createSync({
  read: latest,
  write: change => commit(change, true).then(refreshView),
  drop: applies => {
    let removed = false;
    return commit(copy => {
      if (!applies(copy)) return null;
      removed = true;
      return emptyCopy();
    }, 'removed').then(() => {
      if (removed) afterRemoval();
      return removed;
    });
  },
  dropHeld: () => { applyChange(emptyCopy, 'removed'); afterRemoval(); },
  exclusive: holdLock,
  changed: renderStatus,
  notify: showNotice,
});

// ---------- start ----------
upgradeLocal();
renderStage();
renderHistory();
showLoginError();
// Never waited for: the page above already works from the browser copy.
sync.start();
