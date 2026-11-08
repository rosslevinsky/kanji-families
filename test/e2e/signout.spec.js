import { expect, test } from '@playwright/test';
import { accountCount, answerCount, answerOne, newSub, openHistory, openSignedIn, readCopy, startTest, status, watchForPageErrors } from '../helpers/e2e.js';

let problems;
test.beforeEach(({ page }) => { problems = []; watchForPageErrors(page, problems); });
test.afterEach(() => { expect(problems).toEqual([]); });

const session = async (context) => (await context.cookies()).find((c) => c.name === 'kf_session');

test('unsaved answers are saved first; then the browser is empty with a new device ID', async ({ page, context, browser }) => {
  const sub = newSub();
  await openSignedIn(page, sub);
  await startTest(page);
  await answerOne(page);
  await answerOne(page);
  const before = await readCopy(page);
  expect(before.sync.dirty).toBe(true);

  await openHistory(page);
  await page.locator('#sign-out').click();
  await expect(status(page)).toContainText('Saved in this browser only');
  await expect(page.locator('#sign-in-dev')).toBeVisible();

  const copy = await readCopy(page);
  expect(answerCount(copy)).toBe(0);
  expect(copy.sync).toBeUndefined();
  expect(copy.device).not.toBe(before.device);
  expect(await session(context)).toBeUndefined();
  expect(await accountCount(browser, sub)).toBe(2);
});

test('a failed save warns, and cancel keeps everything', async ({ page, context, browser }) => {
  const sub = newSub();
  await openSignedIn(page, sub);
  await startTest(page);
  await answerOne(page);
  await page.route('**/api/progress?account=*', (route) => route.abort());

  await openHistory(page);
  await page.locator('#sign-out').click();
  await expect(page.locator('#account')).toContainText('couldn’t be saved');
  await page.locator('#sign-out-cancel').click();
  await expect(page.locator('#sign-out')).toBeVisible();
  expect(answerCount(await readCopy(page))).toBe(1);
  expect((await readCopy(page)).sync.dirty).toBe(true);
  expect(await session(context)).toBeDefined();

  await page.unroute('**/api/progress?account=*');
  await page.locator('#sign-out').click();
  await expect(page.locator('#sign-in-dev')).toBeVisible();
  expect(await accountCount(browser, sub)).toBe(1);
});

test('a failed save can be overridden with "Sign out anyway"', async ({ page, context, browser }) => {
  const sub = newSub();
  await openSignedIn(page, sub);
  await startTest(page);
  await answerOne(page);
  await page.route('**/api/progress?account=*', (route) => route.abort());

  await openHistory(page);
  await page.locator('#sign-out').click();
  await page.locator('#sign-out-anyway').click();
  await expect(page.locator('#sign-in-dev')).toBeVisible();
  expect(answerCount(await readCopy(page))).toBe(0);
  expect(await session(context)).toBeUndefined();
  expect(await accountCount(browser, sub)).toBe(0);
});

test('signing out ends a test in progress in another tab', async ({ page, context }) => {
  await openSignedIn(page, newSub());
  const other = await context.newPage();
  await other.goto('/');
  await startTest(other);
  await answerOne(other);

  await page.bringToFront();
  await openHistory(page);
  await page.locator('#sign-out').click();
  await expect(page.locator('#sign-in-dev')).toBeVisible();

  await expect(other.locator('#start')).toBeVisible();
  expect(answerCount(await readCopy(page))).toBe(0);
});

test('signing out while the site can\'t be reached keeps the copy and says so', async ({ page, context }) => {
  await openSignedIn(page, newSub());
  await page.route('**/auth/logout', (route) => route.abort());
  await openHistory(page);
  await page.locator('#sign-out').click();
  await expect(page.locator('#notice')).toContainText('still signed in');
  expect((await readCopy(page)).sync).toBeTruthy();
  expect(await session(context)).toBeDefined();
});

test('signing out with a test running after a clear says nothing about another device', async ({ page }) => {
  await openSignedIn(page, newSub());
  await page.locator('#clear').click();
  await page.locator('#clear-yes').click();
  await startTest(page);
  await answerOne(page);
  await openHistory(page);
  await page.locator('#sign-out').click();
  await expect(page.locator('#sign-in-dev')).toBeVisible();
  await expect(page.locator('#notice')).toBeHidden();
});

test('an answer made while logout is pending is dropped with its test, and never saved', async ({ page, context, browser }) => {
  const sub = newSub();
  await openSignedIn(page, sub);
  const other = await context.newPage();
  await other.goto('/');
  await startTest(other);
  await expect(other.locator('#qcard')).toBeVisible();

  // Holds logout open, and this tab's answer is made while it is held.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let reached;
  const atLogout = new Promise((resolve) => { reached = resolve; });
  await page.route('**/auth/logout', async (route) => { reached(); await held; await route.continue(); });

  await page.bringToFront();
  await openHistory(page);
  await page.locator('#sign-out').click();
  await atLogout;
  await other.locator('#qcard .opt').first().click();
  release();

  await expect(page.locator('#sign-in-dev')).toBeVisible();
  await expect(other.locator('#start')).toBeVisible();
  const copy = await readCopy(page);
  expect(answerCount(copy)).toBe(0);
  expect(copy.sync).toBeUndefined();
  expect(await accountCount(browser, sub)).toBe(0);
});
