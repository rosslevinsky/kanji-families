// Shared steps for browser tests that sign in. Every test uses its own account, so tests running
// at once never share a row.
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

export const ORIGIN = 'http://localhost:8799';
export const newSub = () => `e2e-${randomUUID()}`;
export const SIGNED_IN = /^Signed in\./;

export const status = (page) => page.locator('#status');
export const openHistory = (page) => page.getByRole('tab', { name: 'History' }).click();

export function watchForPageErrors(page, problems) {
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (/Content.Security.Policy/i.test(m.text())) problems.push(`blocked: ${m.text()}`); });
}

// Clicks the fake login, sending this test's account in place of the button's default one.
export async function signIn(page, sub) {
  await page.route('**/auth/dev-login', (route) => route.continue({ postData: JSON.stringify({ sub }), headers: { ...route.request().headers(), 'content-type': 'application/json' } }));
  await openHistory(page);
  const done = page.waitForResponse('**/auth/dev-login');
  await page.locator('#sign-in-dev').click();
  await done;
}

export async function open(page) {
  await page.goto('/');
  await expect(page.locator('#families .fam').first()).toBeVisible();
}

export async function openSignedIn(page, sub) {
  await open(page);
  await signIn(page, sub);
  await expect(status(page)).toContainText(SIGNED_IN);
}

export const endSession = (context) => context.clearCookies({ name: 'kf_session' });

export const readCopy = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('kfd-progress')));

export function answerCount(store) {
  let n = 0;
  for (const dev of Object.values(store.counters)) for (const x of Object.values(dev.scores)) n += x.n;
  return n;
}

// What the account holds, read with this context's session.
export async function serverCopy(context) {
  const res = await context.request.get('/api/progress');
  expect(res.status()).toBe(200);
  return res.json();
}

// What another account holds, read through a separate login that doesn't touch any page's cookies.
export async function accountCount(browser, sub) {
  const context = await browser.newContext({ baseURL: ORIGIN });
  try {
    await context.request.post('/auth/dev-login', { headers: { Origin: ORIGIN }, data: { sub } });
    return answerCount((await serverCopy(context)).progress);
  } finally {
    await context.close();
  }
}

export async function startTest(page, length = 10) {
  await page.getByRole('tab', { name: 'Practice' }).click();
  await page.locator('#seg-len').getByRole('button', { name: `${length} questions` }).click();
  await page.locator('#start').click();
}

export async function answerOne(page) {
  const before = await page.locator('.pos').textContent();
  await page.locator('#qcard .opt').first().click();
  await expect(page.locator('.feedback .verdict')).toBeVisible();
  await page.locator('#next').click();
  await expect(page.locator('.pos, .big-score').first()).not.toHaveText(before);
}

export async function answerSome(page, count) {
  for (let i = 0; i < count; i++) await answerOne(page);
}

// Takes a whole test, which also saves it.
export async function takeTest(page) {
  await startTest(page);
  await answerSome(page, 10);
  await expect(page.locator('.eyebrow').filter({ hasText: 'Test complete' })).toBeVisible();
}
