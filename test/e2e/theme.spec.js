import { expect, test } from '@playwright/test';
import { newSub, open, openHistory, openSignedIn, status, takeTest, watchForPageErrors } from '../helpers/e2e.js';

let problems;
test.beforeEach(({ page }) => { problems = []; watchForPageErrors(page, problems); });
test.afterEach(() => { expect(problems).toEqual([]); });

const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme ?? 'auto');
const background = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const barColor = (page) => page.locator('meta[name="theme-color"]').getAttribute('content');
const choice = (page, name) => page.locator(`[data-theme-choice="${name}"]`);

test('follows the device until a theme is chosen, and the choice survives a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await open(page);
  expect(await theme(page)).toBe('auto');
  await expect(choice(page, 'auto')).toHaveAttribute('aria-pressed', 'true');
  const darkBackground = await background(page);
  expect(await barColor(page)).toBe('#11151d');

  await choice(page, 'light').click();
  expect(await theme(page)).toBe('light');
  await expect(choice(page, 'light')).toHaveAttribute('aria-pressed', 'true');
  await expect(choice(page, 'auto')).toHaveAttribute('aria-pressed', 'false');
  expect(await background(page)).not.toBe(darkBackground);
  expect(await barColor(page)).toBe('#f3f5f8');

  await page.reload();
  expect(await theme(page)).toBe('light');
  await expect(choice(page, 'light')).toHaveAttribute('aria-pressed', 'true');

  await choice(page, 'auto').click();
  expect(await theme(page)).toBe('auto');
  expect(await background(page)).toBe(darkBackground);
  expect(await page.evaluate(() => localStorage.getItem('kfd-theme'))).toBeNull();
});

test('a forced dark theme ignores a light device, on every page', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page);
  await choice(page, 'dark').click();
  const dark = await background(page);
  for (const path of ['/credits', '/privacy']) {
    await page.goto(path);
    expect(await theme(page)).toBe('dark');
    expect(await background(page)).toBe(dark);
  }
});

test('the choice stays with the browser through clearing history and signing out', async ({ page }) => {
  await openSignedIn(page, newSub());
  await choice(page, 'dark').click();
  await takeTest(page);
  await openHistory(page);
  await page.locator('#clear').click();
  await page.locator('#clear-yes').click();
  await page.locator('#sign-out').click();
  await expect(status(page)).toContainText('Saved in this browser only');
  await page.reload();
  expect(await theme(page)).toBe('dark');
});

test('the manifest and icons load under the security policy', async ({ page, request }) => {
  await open(page);
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  for (const icon of (await manifest.json()).icons) {
    const res = await request.get(icon.src);
    expect(res.headers()['content-type']).toBe('image/png');
  }
  // Chromium reads the manifest itself; a policy that blocked it would log an error here.
  await page.waitForTimeout(500);
});
