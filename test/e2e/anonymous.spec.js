import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Every test fails if a request fails or the page throws. Fonts are excepted, since they need a
// network, and so is the config check, which a reload may cut short. With login never used, the
// page may only ask which sign-in buttons to show: nothing else may reach an API, and nothing may write.
let problems;
test.beforeEach(async ({ page }) => {
  problems = [];
  const isFont = (url) => /fonts\.(googleapis|gstatic)\.com/.test(url);
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (/Content.Security.Policy/i.test(m.text())) problems.push(`blocked: ${m.text()}`); });
  const isConfigCheck = (r) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/config';
  page.on('requestfailed', (r) => { if (!isFont(r.url()) && !isConfigCheck(r)) problems.push(`failed: ${r.url()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !isFont(r.url())) problems.push(`${r.status()}: ${r.url()}`); });
  page.on('request', (r) => {
    const { pathname } = new URL(r.url());
    if ((pathname.startsWith('/api/') || pathname.startsWith('/auth/')) && !isConfigCheck(r)) problems.push(`api call: ${r.method()} ${r.url()}`);
  });
  await page.goto('/');
  await expect(page.locator('#families .fam').first()).toBeVisible();
});
test.afterEach(() => { expect(problems).toEqual([]); });

const score = (page) => page.locator('#score');

// Answers the current test with the first option every time; returns how many were right.
async function answerAll(page, count) {
  let right = 0;
  for (let i = 0; i < count; i++) {
    await expect(page.locator('.pos')).toContainText(`Question ${i + 1} of ${count}`);
    await page.locator('#qcard .opt').first().click();
    const verdict = page.locator('.feedback .verdict');
    await expect(verdict).toBeVisible();
    if ((await verdict.textContent()) === 'Correct.') right++;
    await page.locator('#next').click();
  }
  return right;
}

async function takeTest(page) {
  await page.getByRole('tab', { name: 'Practice' }).click();
  await page.locator('#seg-len').getByRole('button', { name: '10 questions' }).click();
  await page.locator('#start').click();
  return answerAll(page, 10);
}

test('shows the page as the artifact does', async ({ page }) => {
  await expect(page).toHaveTitle('Kanji Family Drills');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kanji Family Drills');
  await expect(page.locator('#fam-count')).toHaveText('55 sound families, 239 kanji');
  await expect(page.locator('#families .fam')).toHaveCount(55);
  await expect(page.locator('.fam-head .cell').first()).toHaveText('青');
  await expect(page.locator('#overlay')).toBeHidden();
  expect(await page.evaluate(() => 'claude' in window)).toBe(false);
});

test('study: search and details', async ({ page }) => {
  await page.locator('#search').fill('sei');
  await expect(page.locator('#search-results .hit[data-k="清"]')).toBeVisible();
  await page.locator('#search').fill('xqzzy');
  await expect(page.locator('#search-results .empty')).toContainText('Nothing found for “xqzzy”');
  await page.locator('#search').fill('');
  await expect(page.locator('#search-results .hit')).toHaveCount(0);

  await page.locator('.mem[data-k="清"]').first().click();
  await expect(page.locator('#sheet-title')).toHaveText('pure');
  await expect(page.locator('#sheet .fam-link').first()).toContainText('Sound family 青');
  await expect(page.locator('#sheet .record')).toHaveText('Not practiced yet.');
  await page.locator('#close').click();
  await expect(page.locator('#overlay')).toBeHidden();
});

test('practice: every quiz type gives a question', async ({ page }) => {
  await page.getByRole('tab', { name: 'Practice' }).click();
  for (const [name, prompt] of [
    ['Sound → reading', 'What is the on’yomi?'],
    ['Read the word', 'How is this word read?'],
    ['Kanji → meaning', 'What does this kanji mean?'],
    ['Odd one out', 'Which one has a different on’yomi?'],
    ['Meaning component', 'Which category does its meaning part point to?'],
  ]) {
    await page.locator('#modes').getByRole('button', { name, exact: true }).click();
    await page.locator('#start').click();
    await expect(page.locator('.prompt')).toHaveText(prompt);
    await expect(page.locator('#qcard .opt')).toHaveCount(4);
  }
});

test('practice: a whole test is scored and recorded in History', async ({ page }) => {
  const right = await takeTest(page);
  await expect(page.locator('.big-score')).toContainText(`${right} / 10`);
  await expect(page.locator('.eyebrow').last()).toContainText('Test complete');
  await expect(score(page)).toContainText(`All-time: ${right} of 10 correct`);

  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.locator('#status')).toHaveText('Saved in this browser only. Use “Download backup” below to keep a copy.');
  await expect(page.locator('#hist-tests .log-row')).toHaveCount(1);
  await expect(page.locator('#hist-tests .log-row b')).toHaveText(`${right}/10`);
  await expect(page.locator('#hist-log .log-row')).toHaveCount(10);
  await expect(page.locator('#hist-modes tr').first().locator('td').nth(3)).toHaveText(/^10 \/ \d+$/);
});

test('family test from a Test me button', async ({ page }) => {
  await page.locator('.famtest[data-fam="同"]').click();
  await expect(page.locator('.pos')).toContainText('Family 同 · Question 1 of 4');
});

test('progress survives a reload under the kfd-progress key', async ({ page }) => {
  const right = await takeTest(page);
  await page.reload();
  await page.getByRole('tab', { name: 'Practice' }).click();
  await expect(score(page)).toContainText(`All-time: ${right} of 10 correct`);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('kfd-progress')));
  expect(stored.log).toHaveLength(10);
  expect(stored.tests).toHaveLength(1);
});

test('backup downloads as a file, then restores after clearing', async ({ page }) => {
  const right = await takeTest(page);
  await page.getByRole('tab', { name: 'History' }).click();

  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#dl').click()]);
  expect(download.suggestedFilename()).toMatch(/^kanji-family-drills-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const backup = await download.path();
  const saved = JSON.parse(await readFile(backup, 'utf8'));
  expect(saved.log).toHaveLength(10);
  expect(saved.v).toBe(3);
  expect(Object.values(saved.counters)[0].scores.reading).toEqual({ c: right, n: 10 });
  await expect(page.locator('#backup [role=status]')).toHaveText('Backup saved.');

  await page.locator('#clear').click();
  await page.locator('#clear-yes').click();
  await expect(page.locator('#hist-tests .empty')).toHaveText('No finished tests yet.');

  await page.locator('#restore-file').setInputFiles(backup);
  await expect(page.locator('#backup .confirm')).toContainText('(10 answers, 1 tests)');
  await page.locator('#imp-yes').click();
  await expect(page.locator('#backup [role=status]')).toHaveText('Backup restored.');
  await expect(page.locator('#hist-tests .log-row b')).toHaveText(`${right}/10`);
  await expect(page.locator('#hist-log .log-row')).toHaveCount(10);
});

// A store in the shape the claude.ai artifact wrote.
const DAY = 86400000, H4 = 4 * 3600000;
function artifactBackup(now) {
  return {
    v: 2,
    scores: { reading: { c: 7, n: 10 }, words: { c: 0, n: 0 }, gloss: { c: 1, n: 2 }, odd: { c: 0, n: 0 }, meaning: { c: 0, n: 0 } },
    kanji: { 清: { c: 4, n: 6 }, 晴: { c: 3, n: 4 }, 青: { c: 1, n: 2 } },
    log: [
      { t: now - 3000, m: 'reading', k: '清', ok: true },
      { t: now - 2000, m: 'reading', k: '晴', ok: false },
      { t: now - 1000, m: 'gloss', k: '青', ok: true },
    ],
    tests: [{ t: now - 1000, m: 'reading', c: 1, n: 2, f: 'due', miss: ['晴'] }],
    srs: {
      'reading:晴': { b: 0, d: now - 2000 }, // due now
      'reading:清': { b: 4, d: now + 14 * DAY - H4 }, // learned, not due
      'gloss:青': { b: 1, d: now + DAY - H4 },
    },
  };
}
const asFile = (data) => ({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });

async function expectArtifactNumbers(page, now) {
  await page.getByRole('tab', { name: 'History' }).click();
  const cells = (row) => page.locator('#hist-modes tr').nth(row).locator('td');
  await expect(cells(0).nth(1)).toHaveText('70%'); // score
  await expect(cells(0).nth(2)).toHaveText('1'); // due now
  await expect(cells(0).nth(3)).toHaveText(/^2 \/ \d+$/); // started
  await expect(cells(0).nth(4)).toHaveText('1'); // learned
  await expect(cells(2).nth(1)).toHaveText('50%');
  await expect(cells(2).nth(2)).toHaveText('0');
  await expect(page.locator('#hist-tests .log-row b')).toHaveText('1/2');
  await expect(page.locator('#hist-log .log-row')).toHaveCount(3);
  await expect(page.locator('#hist-review .rv[data-k="清"] .s')).toHaveText('2 missed of 6');

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('kfd-progress')));
  expect(stored.v).toBe(3);
  expect(stored.srs['reading:清'].r).toBe(now);
  expect(stored.srs['reading:晴'].r).toBe(now - 2000);
  expect(stored.srs['reading:清'].d).toBe(now + 14 * DAY - H4);

  await page.getByRole('tab', { name: 'Practice' }).click();
  await expect(score(page)).toContainText('All-time: 7 of 10 correct (70%)');
  await expect(score(page)).toContainText('Due now: 1');

  await page.locator('.tab').first().click();
  await page.locator('.mem[data-k="清"]').first().click();
  await expect(page.locator('#sheet .record')).toHaveText('Your record: 4 of 6 correct.');
  await page.locator('#close').click();
}

test('an artifact backup restores with matching schedule and totals, and they survive a reload', async ({ page }) => {
  const now = Date.now();
  await page.getByRole('tab', { name: 'History' }).click();
  await page.locator('#restore-file').setInputFiles(asFile(artifactBackup(now)));
  await expect(page.locator('#backup .confirm')).toContainText('(3 answers, 1 tests)');
  await page.locator('#imp-yes').click();
  await expect(page.locator('#backup [role=status]')).toHaveText('Backup restored.');
  await expectArtifactNumbers(page, now);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('kfd-progress')));
  expect(stored.gen.t).toBeGreaterThan(0);
  expect(Object.keys(stored.counters)).toHaveLength(1);
  expect(stored.counters[stored.device]).toBeUndefined();

  await page.reload();
  await expectArtifactNumbers(page, now);
});

test('a backup from this site restores its totals in another browser, apart from that browser’s device', async ({ page, browser }) => {
  const right = await takeTest(page);
  await page.getByRole('tab', { name: 'History' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#dl').click()]);
  const backup = JSON.parse(await readFile(await download.path(), 'utf8'));

  const other = await (await browser.newContext({ baseURL: new URL(page.url()).origin })).newPage();
  await other.goto('/');
  await other.getByRole('tab', { name: 'History' }).click();
  await other.locator('#restore-file').setInputFiles(asFile(backup));
  await other.locator('#imp-yes').click();
  await expect(other.locator('#backup [role=status]')).toHaveText('Backup restored.');
  await other.getByRole('tab', { name: 'Practice' }).click();
  await expect(score(other)).toContainText(`All-time: ${right} of 10 correct`);
  const stored = await other.evaluate(() => JSON.parse(localStorage.getItem('kfd-progress')));
  expect(stored.device).not.toBe(backup.device);
  expect(stored.counters[backup.device]).toBeUndefined();
  expect(stored.counters[stored.device]).toBeUndefined();
  expect(Object.values(stored.counters)).toHaveLength(1);
  expect(Object.values(stored.counters)[0].scores.reading).toEqual({ c: right, n: 10 });
  await other.context().close();
});

const UNREADABLE_KEY = 'kfd-progress-unreadable';
const STORE_KEY = 'kfd-progress';
const getKey = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

test('a stored time no value can be made from does not lose real progress', async ({ page }) => {
  const stored = {
    v: 3, device: 'devA', gen: { t: 0, id: '0' },
    counters: { devA: { scores: { reading: { c: 3, n: 4 } }, kanji: {} } },
    srs: {}, tests: [], log: [{ t: { toString: null }, m: 'reading', k: '清', ok: true }],
  };
  await page.evaluate(([k, d]) => localStorage.setItem(k, JSON.stringify(d)), [STORE_KEY, stored]);
  await page.reload();
  await page.getByRole('tab', { name: 'Practice' }).click();
  await expect(score(page)).toContainText('All-time: 3 of 4 correct');
  expect(await getKey(page, UNREADABLE_KEY)).toBeNull();
});

test('a stored copy that cannot be read is kept when the next answer is saved', async ({ page }) => {
  const broken = '{"v":3,"counters":{"devA":{"scores":{"reading":{"c":40,"n":50';
  await page.evaluate(([k, d]) => localStorage.setItem(k, d), [STORE_KEY, broken]);
  await page.reload();
  await takeTest(page);
  expect(await getKey(page, UNREADABLE_KEY)).toBe(broken);
  expect(JSON.parse(await getKey(page, STORE_KEY)).log).toHaveLength(10);

  // A later broken copy doesn't take the place of the first one.
  await page.evaluate(([k]) => localStorage.setItem(k, 'also broken'), [STORE_KEY]);
  await page.reload();
  await takeTest(page);
  expect(await getKey(page, UNREADABLE_KEY)).toBe(broken);
  expect(await getKey(page, `${UNREADABLE_KEY}-1`)).toBe('also broken');
});

test('a stored copy that cannot be read or kept is not overwritten', async ({ page }) => {
  const broken = '{"v":3,"counters":{"devA"';
  await page.evaluate(([k, d]) => localStorage.setItem(k, d), [STORE_KEY, broken]);
  await page.addInitScript((prefix) => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k.startsWith(prefix)) throw new DOMException('full', 'QuotaExceededError');
      return setItem.call(this, k, v);
    };
  }, UNREADABLE_KEY);
  await page.reload();
  const right = await takeTest(page);
  expect(await getKey(page, STORE_KEY)).toBe(broken);
  await expect(score(page)).toContainText(`All-time: ${right} of 10 correct`);
});

test('a v2 copy already in this browser is migrated once, and keeps its device and counts', async ({ page }) => {
  const now = Date.now();
  await page.evaluate((d) => localStorage.setItem('kfd-progress', JSON.stringify(d)), artifactBackup(now));
  await page.reload();
  await expectArtifactNumbers(page, now);
  const first = await page.evaluate(() => localStorage.getItem('kfd-progress'));
  await page.reload();
  await page.getByRole('tab', { name: 'Practice' }).click();
  await expect(score(page)).toContainText('All-time: 7 of 10 correct');
  expect(await page.evaluate(() => localStorage.getItem('kfd-progress'))).toBe(first);
});

test('the older kfd-scores value is read', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('kfd-scores', JSON.stringify({ reading: { c: 5, n: 8 } })));
  await page.reload();
  await page.getByRole('tab', { name: 'Practice' }).click();
  await expect(score(page)).toContainText('All-time: 5 of 8 correct (63%)');
  // Clearing must not let the old key bring the counts back.
  await page.getByRole('tab', { name: 'History' }).click();
  await page.locator('#clear').click();
  await page.locator('#clear-yes').click();
  await page.reload();
  await page.getByRole('tab', { name: 'Practice' }).click();
  await expect(score(page)).toContainText('All-time: 0 of 0 correct');
});

test('a browser without Web Locks still saves answers', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'locks', { value: undefined }));
  await page.reload();
  const right = await takeTest(page);
  await page.reload();
  await page.getByRole('tab', { name: 'Practice' }).click();
  await expect(score(page)).toContainText(`All-time: ${right} of 10 correct`);
});

test('a browser that refuses the lock still saves answers', async ({ page }) => {
  await page.addInitScript(() => { LockManager.prototype.request = () => Promise.reject(new DOMException('no', 'SecurityError')); });
  await page.reload();
  const right = await takeTest(page);
  await page.reload();
  await page.getByRole('tab', { name: 'Practice' }).click();
  await expect(score(page)).toContainText(`All-time: ${right} of 10 correct`);
});

test('clearing history also ends a test in progress', async ({ page }) => {
  await page.getByRole('tab', { name: 'Practice' }).click();
  await page.locator('#seg-len').getByRole('button', { name: '10 questions' }).click();
  await page.locator('#start').click();
  await page.locator('#qcard .opt').first().click();
  await page.getByRole('tab', { name: 'History' }).click();
  await page.locator('#clear').click();
  await page.locator('#clear-yes').click();
  await page.getByRole('tab', { name: 'Practice' }).click();
  await expect(page.locator('#start')).toBeVisible();
  await expect(page.locator('#qcard')).toHaveCount(0);
});

test('restore refuses a file that is not a backup', async ({ page }) => {
  await page.getByRole('tab', { name: 'History' }).click();
  await page.locator('#restore-file').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') });
  await expect(page.locator('#backup [role=status]')).toContainText('isn’t a Kanji Family Drills backup');
});

test('credits page is linked and shows the attribution', async ({ page }) => {
  await page.getByRole('link', { name: 'Credits and licenses' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Credits and licenses');
  await expect(page.getByRole('heading', { name: 'KanjiVG' })).toBeVisible();
});

test('static files carry the security headers, and only the API runs the Worker', async ({ page, request }) => {
  const home = await request.get('/');
  expect(home.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(home.headers()['x-content-type-options']).toBe('nosniff');
  expect((await request.get('/_headers')).status()).toBe(404);
  const api = await request.get('/api/progress');
  expect(api.status()).toBe(401);
  expect(api.headers()['cache-control']).toBe('no-store');
  // The test server uses its own settings: this origin and the fake login, whatever .dev.vars says.
  const login = await request.post('/auth/dev-login', { headers: { Origin: new URL(home.url()).origin }, data: { sub: 'e2e' } });
  expect(login.status()).toBe(200);
  // Inline styles written by the page must still apply under the policy.
  await page.locator('[data-tab="practice"]').click();
  await expect(page.locator('#stage')).toBeVisible();
});
