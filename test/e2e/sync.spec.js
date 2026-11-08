import { expect, test } from '@playwright/test';
import { answerCount, answerOne, newSub, open, openHistory, openSignedIn, readCopy, serverCopy, SIGNED_IN, signIn, startTest, status, takeTest, watchForPageErrors } from '../helpers/e2e.js';

let problems;
test.beforeEach(() => { problems = []; });
test.afterEach(() => { expect(problems).toEqual([]); });

async function device(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  watchForPageErrors(page, problems);
  return { context, page };
}

test('two devices on one account add up exactly', async ({ browser }) => {
  const sub = newSub();
  const a = await device(browser), b = await device(browser);
  await openSignedIn(a.page, sub);
  await takeTest(a.page);
  await expect.poll(async () => answerCount((await serverCopy(a.context)).progress)).toBe(10);

  await openSignedIn(b.page, sub);
  await expect.poll(async () => answerCount(await readCopy(b.page))).toBe(10);
  await takeTest(b.page);
  await expect.poll(async () => answerCount((await serverCopy(b.context)).progress)).toBe(20);

  await a.page.reload();
  await expect.poll(async () => answerCount(await readCopy(a.page))).toBe(20);
  const copy = await readCopy(a.page);
  expect(Object.keys(copy.counters)).toHaveLength(2);
  await a.context.close(); await b.context.close();
});

test('clearing history reaches another device and its older data stays gone', async ({ browser }) => {
  const sub = newSub();
  const a = await device(browser), b = await device(browser);
  await openSignedIn(a.page, sub);
  await takeTest(a.page);
  await expect.poll(async () => answerCount((await serverCopy(a.context)).progress)).toBe(10);
  await openSignedIn(b.page, sub);
  await expect.poll(async () => answerCount(await readCopy(b.page))).toBe(10);

  // B has a test running when A clears.
  await startTest(b.page);
  await answerOne(b.page);

  await openHistory(a.page);
  await a.page.locator('#clear').click();
  await a.page.locator('#clear-yes').click();
  await expect.poll(async () => answerCount((await serverCopy(a.context)).progress)).toBe(0);

  // B saves its older data and is answered with the newer generation.
  await b.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(b.page.locator('#notice')).toContainText('cleared or restored on another device');
  await expect(b.page.locator('#start')).toBeVisible();
  await expect.poll(async () => answerCount(await readCopy(b.page))).toBe(0);
  expect(answerCount((await serverCopy(b.context)).progress)).toBe(0);
  await a.context.close(); await b.context.close();
});

test('restoring a backup reaches another device', async ({ browser }) => {
  const sub = newSub();
  const a = await device(browser), b = await device(browser);
  await openSignedIn(a.page, sub);
  await takeTest(a.page);
  await expect.poll(async () => answerCount((await serverCopy(a.context)).progress)).toBe(10);
  await openSignedIn(b.page, sub);

  const backup = { v: 3, gen: { t: 0, id: '0' }, counters: { other: { scores: { reading: { c: 2, n: 3 } }, kanji: {} } }, srs: {}, log: [], tests: [] };
  await openHistory(a.page);
  await a.page.locator('#restore-file').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await a.page.locator('#imp-yes').click();
  await expect.poll(async () => answerCount((await serverCopy(a.context)).progress)).toBe(3);

  await b.page.reload();
  await expect.poll(async () => answerCount(await readCopy(b.page))).toBe(3);
  await a.context.close(); await b.context.close();
});

test('first login adopts anonymous progress with no prompt, and a reload keeps it', async ({ page, context }) => {
  watchForPageErrors(page, problems);
  const adopts = [];
  page.on('request', (r) => { if (r.url().includes('adopt=1')) adopts.push(r.url()); });
  await open(page);
  await takeTest(page);
  const before = await readCopy(page);
  expect(before.sync).toBeUndefined();

  await signIn(page, newSub());
  await expect(status(page)).toHaveText(/^Signed in\. Your progress is saved/);
  expect(adopts).toHaveLength(1);
  expect(answerCount((await serverCopy(context)).progress)).toBe(10);
  const after = await readCopy(page);
  expect(after.device).toBe(before.device);
  expect(after.sync.owner).toBe((await serverCopy(context)).account);

  await page.reload();
  await expect(status(page)).toContainText(SIGNED_IN);
  expect(answerCount(await readCopy(page))).toBe(10);
  expect(adopts).toHaveLength(1);
});

test('adoption whose reply is lost is retried, and nothing counts twice', async ({ page, context }) => {
  watchForPageErrors(page, problems);
  await open(page);
  await takeTest(page);

  // The server gets the data, but the browser never hears back.
  let adopts = 0;
  await page.route('**/api/progress?adopt=1*', async (route) => {
    adopts++;
    if (adopts === 1) { await route.fetch(); await route.abort(); } else await route.continue();
  });
  await signIn(page, newSub());
  await expect(status(page)).toContainText('Couldn’t save to your account');
  expect((await readCopy(page)).sync).toBeUndefined();
  expect(answerCount((await serverCopy(context)).progress)).toBe(10);

  await page.reload();
  await expect(status(page)).toContainText(SIGNED_IN);
  expect(adopts).toBe(2);
  expect((await readCopy(page)).sync.owner).toBeTruthy();
  expect(answerCount((await serverCopy(context)).progress)).toBe(10);
  expect(answerCount(await readCopy(page))).toBe(10);
});

test('a question answered while a save is in flight is kept, and saved next', async ({ page, context }) => {
  watchForPageErrors(page, problems);
  await openSignedIn(page, newSub());
  await startTest(page);
  await answerOne(page);

  let release;
  const held = new Promise((r) => { release = r; });
  let puts = 0;
  await page.route('**/api/progress?account=*', async (route) => {
    puts++;
    if (puts === 1) await held;
    await route.continue();
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => puts).toBe(1);
  await answerOne(page);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(100);
  expect(puts).toBe(1); // at most one save in flight in a tab

  release();
  await expect.poll(async () => answerCount((await serverCopy(context)).progress)).toBe(2);
  expect(answerCount(await readCopy(page))).toBe(2);
  await expect.poll(async () => (await readCopy(page)).sync.dirty).toBe(false);
});

test('saves at most every 30 seconds while answering, and once per finished test', async ({ page }) => {
  watchForPageErrors(page, problems);
  await page.clock.install();
  await openSignedIn(page, newSub());
  const puts = [];
  page.on('request', (r) => { if (r.method() === 'PUT') puts.push(r.url()); });

  await startTest(page);
  await answerOne(page);
  await answerOne(page);
  expect(puts).toHaveLength(0);
  await page.clock.fastForward(31000);
  await expect.poll(() => puts.length).toBe(1);
  await answerOne(page);
  expect(puts).toHaveLength(1);
  for (let i = 3; i < 10; i++) await answerOne(page);
  await expect.poll(() => puts.length).toBe(2);
});

test('a failed login says so in plain words and leaves the address clean', async ({ page }) => {
  watchForPageErrors(page, problems);
  await page.goto('/?login_error=google_failed');
  await expect(page.locator('#notice')).toHaveText(/Couldn’t reach Google/);
  await expect(page).toHaveURL(/\/$/);
  await page.locator('#notice-close').click();
  await expect(page.locator('#notice')).toBeHidden();

  await page.goto('/?login_error=%3Cb%3Eodd%3C/b%3E');
  await expect(page.locator('#notice')).toHaveText(/Signing in didn’t work/);
  await page.reload();
  await expect(page.locator('#notice')).toBeHidden();
});

test('sign-in is offered only by the methods the site has', async ({ page }) => {
  watchForPageErrors(page, problems);
  const config = { googleLogin: false, devLogin: false, signedIn: false };
  await page.route('**/api/config', (route) => route.fulfill({ json: config }));
  await open(page);
  await openHistory(page);
  await expect(status(page)).toContainText('Saved in this browser only');
  await expect(page.locator('#account button')).toHaveCount(0);

  config.googleLogin = true;
  await page.reload();
  await openHistory(page);
  await expect(page.locator('#sign-in-google')).toBeVisible();
  await expect(page.locator('#sign-in-dev')).toHaveCount(0);
  await expect(page.locator('#account')).toContainText('Optional');
});

test('the privacy page opens from the app and loads with nothing blocked', async ({ page }) => {
  watchForPageErrors(page, problems);
  await open(page);
  await page.locator('.site-foot a[href="/privacy"]').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy');
  await expect(page.getByRole('heading', { name: 'Deleting your data' })).toBeVisible();
});

test('a backup holds no account ID', async ({ page }) => {
  watchForPageErrors(page, problems);
  await openSignedIn(page, newSub());
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#dl').click()]);
  const chunks = [];
  for await (const c of await download.createReadStream()) chunks.push(c);
  expect(JSON.parse(Buffer.concat(chunks).toString())).not.toHaveProperty('sync');
});
