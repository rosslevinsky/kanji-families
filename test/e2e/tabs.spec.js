import { expect, test } from '@playwright/test';

// Two tabs in one browser share a device ID and a browser copy.
let tabs;
test.beforeEach(async ({ context }) => {
  tabs = [await context.newPage(), await context.newPage()];
  for (const page of tabs) {
    page.on('pageerror', (e) => { throw e; });
    await page.goto('/');
    await page.getByRole('tab', { name: 'Practice' }).click();
    await page.locator('#seg-len').getByRole('button', { name: '10 questions' }).click();
  }
});

const readStore = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('kfd-progress')));
const score = (page) => page.locator('#score');

function totalsFrom(store) {
  return Object.values(store.counters).reduce((sum, dev) => {
    for (const x of Object.values(dev.scores)) { sum.c += x.c; sum.n += x.n; }
    return sum;
  }, { c: 0, n: 0 });
}

// Answers with no pause between questions; returns how many were right.
async function answerTen(page) {
  await page.locator('#start').click();
  let right = 0;
  for (let i = 0; i < 10; i++) {
    await expect(page.locator('.pos')).toContainText(`Question ${i + 1} of 10`);
    await page.locator('#qcard .opt').first().click();
    const verdict = page.locator('.feedback .verdict');
    await expect(verdict).toBeVisible();
    if ((await verdict.textContent()) === 'Correct.') right++;
    await page.locator('#next').click();
  }
  return right;
}

test('two tabs answering at once lose no answers', async () => {
  const [rightA, rightB] = await Promise.all(tabs.map(answerTen));
  const right = rightA + rightB;

  const stored = await readStore(tabs[0]);
  expect(totalsFrom(stored)).toEqual({ c: right, n: 20 });
  expect(stored.log).toHaveLength(20);
  expect(stored.tests).toHaveLength(2);
  expect(Object.keys(stored.counters)).toEqual([stored.device]);
  // Each answer has its own place in the device's count.
  expect(new Set(stored.log.map((e) => e.s)).size).toBe(20);

  for (const page of tabs) await expect(score(page)).toContainText(`All-time: ${right} of 20 correct`);
  await tabs[0].reload();
  await tabs[0].getByRole('tab', { name: 'Practice' }).click();
  await expect(score(tabs[0])).toContainText(`All-time: ${right} of 20 correct`);
});

test('a tab that was left open does not overwrite newer data', async () => {
  const [busy, idle] = tabs;
  const right = await answerTen(busy);
  await idle.locator('#start').click();
  await idle.locator('#qcard .opt').first().click();
  await expect(idle.locator('.feedback')).toBeVisible();
  const stored = await readStore(idle);
  expect(stored.log).toHaveLength(11);
  expect(totalsFrom(stored).n).toBe(11);
  expect(totalsFrom(stored).c).toBeGreaterThanOrEqual(right);
});

test('answers from another tab refresh the view without disturbing a test in progress', async () => {
  const [busy, testing] = tabs;
  await testing.locator('#start').click();
  await testing.locator('#qcard .opt').first().click();
  await testing.locator('#next').click();
  await expect(testing.locator('.pos')).toContainText('Question 2 of 10');
  const kanji = await testing.locator('#qcard .cell').textContent();
  await testing.locator('#hintbtn').click();
  await testing.locator('#next').focus();

  await answerTen(busy);

  await expect(score(testing)).toContainText('of 11 correct');
  await expect(testing.locator('.pos')).toContainText('Question 2 of 10');
  await expect(testing.locator('#qcard .cell')).toHaveText(kanji);
  await expect(testing.locator('#qcard .feedback')).toHaveCount(0);
  await expect(testing.locator('#next')).toBeFocused();
});

test('the History view follows another tab', async () => {
  const [busy, watching] = tabs;
  await watching.getByRole('tab', { name: 'History' }).click();
  await expect(watching.locator('#hist-tests .empty')).toBeVisible();
  await answerTen(busy);
  await expect(watching.locator('#hist-tests .log-row')).toHaveCount(1);
  await expect(watching.locator('#hist-log .log-row')).toHaveCount(10);
});

test('clearing in one tab ends a test in progress in the other', async () => {
  const [clearing, testing] = tabs;
  await testing.locator('#start').click();
  await testing.locator('#qcard .opt').first().click();
  await expect(testing.locator('.feedback')).toBeVisible();

  await clearing.getByRole('tab', { name: 'History' }).click();
  await clearing.locator('#clear').click();
  await clearing.locator('#clear-yes').click();

  await expect(testing.locator('#start')).toBeVisible();
  await expect(testing.locator('#qcard')).toHaveCount(0);
  await expect(score(testing)).toContainText('All-time: 0 of 0 correct');
  const stored = await readStore(testing);
  expect(stored.log).toEqual([]);
  expect(stored.gen.t).toBeGreaterThan(0);
});

test('an answer that lands just after another tab clears is dropped, not added to the new data', async () => {
  const [clearing, testing] = tabs;
  // This listener goes in first, so the tab never hears about the clear and answers on its old view.
  await testing.addInitScript(() => window.addEventListener('storage', (e) => e.stopImmediatePropagation(), { capture: true }));
  await testing.reload();
  await testing.getByRole('tab', { name: 'Practice' }).click();
  await testing.locator('#start').click();
  await expect(testing.locator('#qcard')).toBeVisible();

  await clearing.getByRole('tab', { name: 'History' }).click();
  await clearing.locator('#clear').click();
  await clearing.locator('#clear-yes').click();
  await expect.poll(async () => (await readStore(clearing))?.gen?.t ?? 0).toBeGreaterThan(0);
  await expect(testing.locator('#qcard')).toBeVisible();

  await testing.locator('#qcard .opt').first().click();
  await expect(testing.locator('#start')).toBeVisible();
  const stored = await readStore(clearing);
  expect(stored.log).toEqual([]);
  expect(stored.counters).toEqual({});
});

// Runs inside the page, with no round trip to the test runner between answers, so the two tabs'
// writes really do overlap.
async function burst(page) {
  return page.evaluate(async () => {
    const wait = async (ok) => { while (!ok()) await new Promise((r) => setTimeout(r, 0)); };
    document.querySelector('#seg-len button[data-v="30"]').click();
    document.querySelector('#start').click();
    let right = 0;
    for (let i = 0; i < 30; i++) {
      const q = document.querySelector('.pos').textContent;
      document.querySelector('#qcard .opt').click();
      await wait(() => document.querySelector('.feedback'));
      if (document.querySelector('.feedback .verdict').textContent === 'Correct.') right++;
      document.querySelector('#next').click();
      await wait(() => !document.querySelector('.pos') || document.querySelector('.pos').textContent !== q);
    }
    return right;
  });
}

test('two tabs answering as fast as they can lose no answers', async () => {
  const [rightA, rightB] = await Promise.all(tabs.map(burst));
  const stored = await readStore(tabs[0]);
  expect(totalsFrom(stored)).toEqual({ c: rightA + rightB, n: 60 });
  expect(stored.log).toHaveLength(60);
  expect(stored.tests).toHaveLength(2);
});
