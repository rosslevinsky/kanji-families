import { expect, test } from '@playwright/test';
import { answerCount, answerOne, newSub, open, openHistory, openSignedIn, readCopy, serverCopy, startTest, status, takeTest, watchForPageErrors } from '../helpers/e2e.js';

let problems;
test.beforeEach(({ page }) => { problems = []; watchForPageErrors(page, problems); });
test.afterEach(() => { expect(problems).toEqual([]); });

test('with the API failing, study goes on, the status says so, and a later save succeeds', async ({ page, context }) => {
  await page.clock.install();
  await openSignedIn(page, newSub());
  await page.route('**/api/**', (route) => route.abort());

  await takeTest(page);
  await openHistory(page);
  await expect(status(page)).toContainText('Couldn’t save to your account');
  expect(answerCount(await readCopy(page))).toBe(10);
  expect((await readCopy(page)).sync.dirty).toBe(true);

  await page.unroute('**/api/**');
  await page.clock.fastForward(31000);
  await expect(status(page)).toContainText(/^Signed in\. Your progress is saved/);
  expect(answerCount((await serverCopy(context)).progress)).toBe(10);
});

test('with the API down from the start, the app works as if login did not exist', async ({ page }) => {
  await page.route('**/api/**', (route) => route.abort());
  await open(page);
  await takeTest(page);
  await page.reload();
  await openHistory(page);
  await expect(status(page)).toHaveText('Saved in this browser only. Use “Download backup” below to keep a copy.');
  await expect(page.locator('#account button')).toHaveCount(0);
  expect(answerCount(await readCopy(page))).toBe(10);
});

test('a copy with an owner stays usable when the API is down at load', async ({ page, context }) => {
  await openSignedIn(page, newSub());
  await page.route('**/api/**', (route) => route.abort());
  await page.reload();
  await openHistory(page);
  await expect(status(page)).toContainText('Couldn’t save to your account');
  await startTest(page);
  await answerOne(page);
  expect(answerCount(await readCopy(page))).toBe(1);
});

test('a save too large for an account says so and keeps the copy', async ({ page }) => {
  await openSignedIn(page, newSub());
  await page.route('**/api/progress?account=*', (route) => route.fulfill({ status: 413, json: { code: 'progress_too_large', message: 'x' } }));
  await takeTest(page);
  await openHistory(page);
  await expect(status(page)).toContainText('over the 1 MB limit');
  expect(answerCount(await readCopy(page))).toBe(10);
});
