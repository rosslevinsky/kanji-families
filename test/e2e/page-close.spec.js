import { expect, test } from '@playwright/test';
import { answerCount, answerOne, newSub, openSignedIn, readCopy, serverCopy, SIGNED_IN, startTest, status, watchForPageErrors } from '../helpers/e2e.js';

let problems;
test.beforeEach(({ page }) => { problems = []; watchForPageErrors(page, problems); });
test.afterEach(() => { expect(problems).toEqual([]); });

// Long enough keys that a store passes the browser's 64 KiB limit for a save during page close.
const growCopy = (page) => page.evaluate(() => {
  const copy = JSON.parse(localStorage.getItem('kfd-progress'));
  for (let i = 0; i < 1500; i++) copy.srs[`reading:${String(i).padStart(50, '0')}`] = { b: 1, d: 2e12, r: 1e12 };
  localStorage.setItem('kfd-progress', JSON.stringify(copy));
});

// Records whether each save asked to outlive the page, in storage that outlives it too.
const recordKeepalive = (page) => page.addInitScript(() => {
  const real = window.fetch;
  window.fetch = (url, init = {}) => {
    if (init.method === 'PUT') localStorage.setItem('test-put-keepalive', String(!!init.keepalive));
    return real(url, init);
  };
});

// A save during page close is best effort: under load Chromium sometimes aborts it even with
// keepalive set (seen in about 1 run in 8 with 2 workers, never in 20 runs alone). So the promise
// tested is the one the app can keep: it tries, and no answer is lost by the next visit.
for (const [name, leave] of [
  ['closing the page', (page) => page.close({ runBeforeUnload: true })],
  ['leaving by navigation', (page) => page.goto('about:blank')],
]) {
  test(`${name} with a small store tries to save, and the next visit saves it at the latest`, async ({ page, context, browserName }) => {
    await recordKeepalive(page);
    await openSignedIn(page, newSub());
    await startTest(page);
    await answerOne(page);
    await answerOne(page);
    await leave(page);

    const next = await context.newPage();
    watchForPageErrors(next, problems);
    await next.goto('/');
    await expect(status(next)).toContainText(SIGNED_IN);
    await expect.poll(async () => answerCount((await serverCopy(context)).progress)).toBe(2);
    // Playwright's WebKit keeps nothing a page writes to storage while its tab closes, so there
    // the record of the attempt is lost, though the save itself is checked above.
    if (browserName === 'webkit' && name === 'closing the page') return;
    expect(await next.evaluate(() => localStorage.getItem('test-put-keepalive'))).toBe('true');
  });
}

test('closing the page with a store over 64 KiB sends nothing and errors nowhere, and the next visit saves it', async ({ page, context }) => {
  await openSignedIn(page, newSub());
  await growCopy(page);
  await startTest(page);
  await answerOne(page);
  const body = JSON.stringify(await readCopy(page));
  expect(body.length).toBeGreaterThan(64 * 1024);

  const puts = [];
  page.on('request', (r) => { if (r.method() === 'PUT') puts.push(r.url()); });
  await page.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 500));
  expect(puts).toEqual([]);
  expect(answerCount((await serverCopy(context)).progress)).toBe(0);

  const next = await context.newPage();
  watchForPageErrors(next, problems);
  await next.goto('/');
  await expect(status(next)).toContainText(SIGNED_IN);
  await expect.poll(async () => answerCount((await serverCopy(context)).progress)).toBe(1);
  expect(answerCount(await readCopy(next))).toBe(1);
});
