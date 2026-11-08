import { expect, test } from '@playwright/test';
import { accountCount, answerCount, answerOne, endSession, newSub, ORIGIN, openHistory, openSignedIn, readCopy, serverCopy, SIGNED_IN, signIn, startTest, status, takeTest, watchForPageErrors } from '../helpers/e2e.js';

let problems;
test.beforeEach(({ page }) => { problems = []; watchForPageErrors(page, problems); });
test.afterEach(() => { expect(problems).toEqual([]); });

test('after the session ends, study goes on, and the same account resumes and saves', async ({ page, context, browser }) => {
  const sub = newSub();
  await openSignedIn(page, sub);
  await takeTest(page);
  await expect.poll(async () => answerCount((await serverCopy(context)).progress)).toBe(10);
  const owner = (await readCopy(page)).sync.owner;

  await endSession(context);
  await page.reload();
  await openHistory(page);
  await expect(status(page)).toContainText('Your sign-in has ended');
  await expect(page.locator('#sign-in-dev')).toBeVisible();

  await startTest(page);
  await answerOne(page);
  const copy = await readCopy(page);
  expect(copy.sync).toMatchObject({ owner, dirty: true });
  expect(answerCount(copy)).toBe(11);

  await signIn(page, sub);
  await expect(status(page)).toContainText(SIGNED_IN);
  await expect(page.locator('#notice')).toBeHidden();
  await expect.poll(async () => answerCount((await serverCopy(context)).progress)).toBe(11);
  expect(await accountCount(browser, sub)).toBe(11);
});

test('a save refused as signed out marks the session ended and keeps the answers', async ({ page, context }) => {
  await openSignedIn(page, newSub());
  await startTest(page);
  await answerOne(page);
  await endSession(context);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await openHistory(page);
  await expect(status(page)).toContainText('Your sign-in has ended');
  expect(answerCount(await readCopy(page))).toBe(1);
});

test('another account signing in removes the copy with a notice and sends none of it', async ({ page, context, browser }) => {
  const subA = newSub(), subB = newSub();
  await openSignedIn(page, subA);
  await takeTest(page);
  await expect.poll(async () => answerCount((await serverCopy(context)).progress)).toBe(10);
  const before = await readCopy(page);

  await endSession(context);
  await page.reload();
  await openHistory(page);
  await expect(status(page)).toContainText('Your sign-in has ended');

  const puts = [];
  page.on('request', (r) => { if (r.method() === 'PUT') puts.push(r.url()); });
  await signIn(page, subB);
  await expect(page.locator('#notice')).toContainText('different account');
  await expect(status(page)).toContainText(SIGNED_IN);
  expect(puts).toEqual([]);

  const copy = await readCopy(page);
  expect(answerCount(copy)).toBe(0);
  expect(copy.device).not.toBe(before.device);
  expect(copy.sync.owner).not.toBe(before.sync.owner);
  expect(await accountCount(browser, subB)).toBe(0);
  expect(await accountCount(browser, subA)).toBe(10);
});

test('an open tab whose cookie changes to another account sends nothing to that account', async ({ page, context, browser }) => {
  const subA = newSub(), subB = newSub();
  await openSignedIn(page, subA);
  await startTest(page);
  await answerOne(page);

  // Another tab's login arrives, and this tab's save fires before that tab has settled anything.
  await context.request.post('/auth/dev-login', { headers: { Origin: ORIGIN }, data: { sub: subB } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#notice')).toContainText('different account');
  expect(answerCount(await readCopy(page))).toBe(0);
  expect(await accountCount(browser, subB)).toBe(0);
});
