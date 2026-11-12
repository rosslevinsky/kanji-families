// The offline copy kept by public/sw.js. The other specs block service workers so their routes see
// every request; this one turns them on.
import { expect, test } from '@playwright/test';
import { answerCount, newSub, open, openHistory, readCopy, signIn, takeTest, watchForPageErrors } from '../helpers/e2e.js';

test.use({ serviceWorkers: 'allow' });

const PREFIX = 'kanji-families-';
const COMPLETE = '/__complete__';
let problems;
test.beforeEach(({ page }) => { problems = []; watchForPageErrors(page, problems); });
test.afterEach(() => { expect(problems).toEqual([]); });

// Opens the app and waits until the worker is in charge and its copy is complete.
async function openWithCopy(page) {
  await open(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });
}

// Playwright's offline switch reaches a service worker only in Chromium: in Firefox the worker's
// requests still reach the server, and WebKit fails the reload outright. Both browsers run service
// workers, so the tests that need a real loss of connection run in Chromium only.
const needsChromium = (browserName) => test.skip(browserName !== 'chromium', 'offline emulation misses service workers here');

// The set the worker answers from: the newest one marked complete.
const copyName = (page) => page.evaluate(async ([prefix, complete]) => {
  for (const name of (await caches.keys()).filter((n) => n.startsWith(prefix)).sort().reverse()) {
    if (await (await caches.open(name)).match(complete)) return name;
  }
  return null;
}, [PREFIX, COMPLETE]);

const cachedPaths = async (page) => page.evaluate(async (name) => {
  const keys = await (await caches.open(name)).keys();
  return keys.map((request) => new URL(request.url).pathname).sort();
}, await copyName(page));

// Puts a stand-in manifest into a set. The manifest is never run, so the page keeps working.
const STALE = '{"name": "stale copy"}';
const plant = (page, name) => page.evaluate(async ([n, body]) => {
  await (await caches.open(n)).put(`${location.origin}/manifest.webmanifest`, new Response(body));
}, [name, STALE]);
const served = (page) => page.evaluate(async () => (await fetch('/manifest.webmanifest')).text());

test('after one visit, the app opens and drills with no connection', async ({ page, context, browserName }) => {
  needsChromium(browserName);
  await openWithCopy(page);
  expect(await cachedPaths(page)).toEqual(expect.arrayContaining(['/', '/app.js', '/credits', '/data.js', '/privacy', '/styles.css']));

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#families .fam').first()).toBeVisible();
  await takeTest(page);
  expect(answerCount(await readCopy(page))).toBe(10);
  await page.reload();
  expect(answerCount(await readCopy(page))).toBe(10);

  for (const [path, heading] of [['/credits', 'Credits and licenses'], ['/privacy', 'Privacy']]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
  }
});

test('online, files come from the network and the copy is replaced whole; offline, from the copy', async ({ page, context, browserName }) => {
  needsChromium(browserName);
  await openWithCopy(page);
  const first = await copyName(page);
  await plant(page, first);
  expect(await served(page)).not.toContain('stale copy');

  // Each page load from the network makes a new complete set. The newest two stay, so the first
  // goes at the second reload.
  await page.reload();
  await expect.poll(() => copyName(page)).not.toBe(first);
  const second = await copyName(page);
  expect(await page.evaluate((n) => caches.has(n), first)).toBe(true);
  await page.reload();
  await expect.poll(() => copyName(page)).not.toBe(second);
  await expect.poll(() => page.evaluate((n) => caches.has(n), first)).toBe(false);

  await plant(page, await copyName(page));
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#families .fam').first()).toBeVisible();
  expect(await served(page)).toBe(STALE);
});

test('a newer set that never finished arriving is never used', async ({ page, context, browserName }) => {
  needsChromium(browserName);
  await openWithCopy(page);
  await plant(page, `${PREFIX}${Date.now() + 60000}`);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#families .fam').first()).toBeVisible();
  expect(await served(page)).not.toContain('stale copy');
});

test('an unfinished set left long ago goes at the next refresh, and a recent one stays', async ({ page }) => {
  await openWithCopy(page);
  const old = `${PREFIX}${Date.now() - 3600000}`;
  const recent = `${PREFIX}${Date.now() - 60000}`;
  await plant(page, old);
  await plant(page, recent);
  const before = await copyName(page);
  await page.reload();
  await expect.poll(() => copyName(page)).not.toBe(before);
  expect(await page.evaluate((n) => caches.has(n), old)).toBe(false);
  // It may belong to another copy of the worker, such as one installing during an update.
  expect(await page.evaluate((n) => caches.has(n), recent)).toBe(true);
});

test('the server tags each file with its version, which a refresh checks', async ({ page }) => {
  await open(page);
  for (const path of ['/', '/app.js', '/sync.js', '/icons/icon-192.png']) {
    const tag = await page.evaluate(async (p) => {
      const r = await fetch(p, { method: 'HEAD', cache: 'no-store' });
      return r.headers.get('etag') || r.headers.get('last-modified');
    }, path);
    expect(tag, path).toBeTruthy();
  }
});

test('nothing from an account is copied', async ({ page }) => {
  await openWithCopy(page);
  await signIn(page, newSub());
  await takeTest(page);
  await openHistory(page);
  const paths = await cachedPaths(page);
  expect(paths.filter((p) => p.startsWith('/api/') || p.startsWith('/auth/'))).toEqual([]);
});

test('offline, the Google sign-in button explains instead of leaving the app', async ({ page, context }) => {
  await openWithCopy(page);
  await openHistory(page);
  // The local server has no Google sign-in, so the button the live site shows is put in by hand.
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'sign-in-google';
    document.querySelector('#account').append(button);
  });
  await context.setOffline(true);
  await page.locator('#sign-in-google').click();
  await expect(page.locator('#notice')).toContainText('You’re offline. Sign in once you’re connected again.');
  expect(new URL(page.url()).pathname).toBe('/');
});
