import { expect, test } from '@playwright/test';
import { accountCount, answerCount, answerOne, endSession, newSub, ORIGIN, openHistory, openSignedIn, readCopy, serverCopy, SIGNED_IN, signIn, startTest, status, takeTest, watchForPageErrors } from '../helpers/e2e.js';

let problems;
test.beforeEach(({ page }) => { problems = []; watchForPageErrors(page, problems); });
test.afterEach(() => { expect(problems).toEqual([]); });

async function secondDevice(browser, sub) {
  const context = await browser.newContext();
  const page = await context.newPage();
  watchForPageErrors(page, problems);
  await openSignedIn(page, sub);
  await expect.poll(async () => answerCount(await readCopy(page))).toBe(10);
  return { context, page };
}

async function deleteData(page) {
  await openHistory(page);
  await page.locator('#delete-data').click();
  await expect(page.locator('#account')).toContainText('can’t be undone');
  await page.locator('#delete-yes').click();
  await expect(page.locator('#notice')).toContainText('deleted from your account and this browser');
}

test('asks first, and keeps everything if you say no', async ({ page }) => {
  await openSignedIn(page, newSub());
  await page.locator('#delete-data').click();
  await page.locator('#delete-no').click();
  await expect(page.locator('#delete-data')).toBeVisible();
  await expect(status(page)).toContainText(SIGNED_IN);
});

test('clears this browser; a second device drops its copy and can\'t recreate the row; signing in afterward starts empty', async ({ page, browser }) => {
  const sub = newSub();
  await openSignedIn(page, sub);
  await takeTest(page);
  await expect.poll(async () => (await readCopy(page)).sync.dirty).toBe(false);
  const second = await secondDevice(browser, sub);
  await startTest(second.page);
  await answerOne(second.page);

  await deleteData(page);
  expect(answerCount(await readCopy(page))).toBe(0);
  expect((await readCopy(page)).sync).toBeUndefined();

  // The second device's save is refused, it drops its copy and any test in progress.
  await second.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(second.page.locator('#notice')).toContainText('deleted on another device');
  await expect(second.page.locator('#start')).toBeVisible();
  const dropped = await readCopy(second.page);
  expect(answerCount(dropped)).toBe(0);
  expect(dropped.sync).toBeUndefined();
  await expect.poll(async () => (await second.context.cookies()).find((c) => c.name === 'kf_session')).toBeUndefined();

  // Signing in afterward, on this browser, starts empty.
  await signIn(page, sub);
  await expect(status(page)).toContainText(SIGNED_IN);
  expect(answerCount(await readCopy(page))).toBe(0);
  expect(await accountCount(browser, sub)).toBe(0);
  await second.context.close();
});

test('a copy whose session had ended when the account was deleted is dropped at the next login, not uploaded', async ({ page, context, browser }) => {
  const sub = newSub();
  await openSignedIn(page, sub);
  await takeTest(page);
  await expect.poll(async () => (await readCopy(page)).sync.dirty).toBe(false);
  const second = await secondDevice(browser, sub);
  await endSession(second.context);
  await second.page.reload();
  await openHistory(second.page);
  await expect(status(second.page)).toContainText('Your sign-in has ended');

  await deleteData(page);

  const puts = [];
  second.page.on('request', (r) => { if (r.method() === 'PUT') puts.push(r.url()); });
  await signIn(second.page, sub);
  await expect(second.page.locator('#notice')).toContainText('deleted on another device');
  await expect(status(second.page)).toContainText(SIGNED_IN);
  expect(puts).toEqual([]);
  expect(answerCount(await readCopy(second.page))).toBe(0);
  expect(await accountCount(browser, sub)).toBe(0);

  // The new copy is not mistaken for an old one on the next load.
  await startTest(second.page);
  await answerOne(second.page);
  await second.page.reload();
  await expect(status(second.page)).toContainText(SIGNED_IN);
  await expect(second.page.locator('#notice')).toBeHidden();
  expect(answerCount(await readCopy(second.page))).toBe(1);
  await second.context.close();
});

test('a copy made after a deletion, by the same browser, survives its next load', async ({ page, context }) => {
  const sub = newSub();
  await openSignedIn(page, sub);
  await deleteData(page);
  await signIn(page, sub);
  await expect(status(page)).toContainText(SIGNED_IN);
  await startTest(page);
  await answerOne(page);
  await page.reload();
  await expect(status(page)).toContainText(SIGNED_IN);
  await expect(page.locator('#notice')).toBeHidden();
  expect(answerCount(await readCopy(page))).toBe(1);
  await expect.poll(async () => answerCount((await serverCopy(context)).progress)).toBe(1);
});

test('a failed delete keeps everything and says so', async ({ page }) => {
  await openSignedIn(page, newSub());
  await page.route('**/api/progress?*', (route) => (route.request().method() === 'DELETE' ? route.abort() : route.continue()));
  await page.locator('#delete-data').click();
  await page.locator('#delete-yes').click();
  await expect(page.locator('#notice')).toContainText('Couldn’t delete');
  await expect(status(page)).toContainText(SIGNED_IN);
  expect((await readCopy(page)).sync).toBeTruthy();
});

test('a page showing one account can\'t delete another account after the session changed', async ({ page, context, browser }) => {
  const first = newSub(), second = newSub();
  await openSignedIn(page, first);
  await takeTest(page);
  await expect.poll(async () => (await readCopy(page)).sync.dirty).toBe(false);

  // Another tab signs in as someone else and saves. This page hasn't heard yet.
  const login = await context.request.post('/auth/dev-login', { headers: { Origin: ORIGIN }, data: { sub: second } });
  expect(login.status()).toBe(200);
  const blank = { v: 3, gen: { t: 0, id: '0' }, srs: {}, log: [], tests: [], counters: { other: { scores: { reading: { c: 2, n: 2 } }, kanji: {} } } };
  expect((await context.request.put('/api/progress', { headers: { Origin: ORIGIN }, data: blank })).status()).toBe(200);

  await openHistory(page);
  await page.locator('#delete-data').click();
  await page.locator('#delete-yes').click();
  await expect(page.locator('#notice')).toContainText('different account');
  expect(await accountCount(browser, second)).toBe(2);
  expect(await accountCount(browser, first)).toBe(10);
});

test('a dirty copy older than a deletion is refused even with a newer session, which stays signed in', async ({ page, browser }) => {
  const sub = newSub();
  await openSignedIn(page, sub);
  await takeTest(page);
  await expect.poll(async () => (await readCopy(page)).sync.dirty).toBe(false);
  const second = await secondDevice(browser, sub);
  await startTest(second.page);
  await answerOne(second.page);

  await deleteData(page);
  // A new session arrives without the page reading the account, as from another tab's login.
  await second.context.request.post('/auth/dev-login', { headers: { Origin: ORIGIN }, data: { sub } });

  await second.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(second.page.locator('#notice')).toContainText('deleted on another device');
  await expect(status(second.page)).toContainText(SIGNED_IN);
  expect(answerCount(await readCopy(second.page))).toBe(0);
  expect(await accountCount(browser, sub)).toBe(0);
  await second.context.close();
});
