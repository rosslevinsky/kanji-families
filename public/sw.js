// Keeps a copy of the site's own files in the browser, so the app opens with no connection.
//
// Online, pages and files come from the network, as they did before this file existed, so a new
// version shows on the next launch. A page comes from the copy only when the network fails, or
// doesn't deliver the whole page within WAIT_MS, as on a weak signal. A page from the copy then
// takes every file from that same copy, and a page from the network takes every file from the
// network, so one page never mixes two versions.
//
// The copy is only ever replaced whole. After each launch, every file is fetched into a new set.
// Each file is then checked once more against the server, so a deploy that lands while the set is
// arriving is noticed and that set is dropped. Only a set that passes is marked complete, and only
// then are older ones removed, keeping the newest two.
//
// Progress is not kept here. It lives in the page's own storage, and /api and /auth always go to
// the network, so nothing about an account is ever copied. Requests to other sites, such as Google
// Fonts, are left to the browser: offline the pages fall back to the device's own fonts.

const PREFIX = 'kanji-families-';
// Written last into a set, so a set without it is one still arriving, or one that failed.
const COMPLETE = '/__complete__';
const FILES = [
  '/',
  '/credits',
  '/privacy',
  '/app.js',
  '/data.js',
  '/merge.js',
  '/sync.js',
  '/theme.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icons/favicon-32.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];
const WAIT_MS = 4000;
// A refresh runs in the background, so it gets longer than a page does.
const REFRESH_MS = 60000;
// An unfinished set this old was left by a refresh the browser stopped. A younger one may belong to
// another copy of this worker, such as the one installing during an update, so it is left alone.
const ABANDONED_MS = 10 * 60000;

// The set each page from the copy is reading, by client ID, so its files come from that set even
// after a newer one arrives. Lost if the browser stops the worker; a page's files all load within
// moments of the page, so that matters only to a page caught mid-load.
const bound = new Map();
let refreshing = null;

self.addEventListener('install', (event) => {
  event.waitUntil(refresh().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
  event.respondWith(request.mode === 'navigate' ? page(event, url) : file(event, url));
});

async function page(event, url) {
  // Started while the event is still open, so the browser keeps the worker running until the new
  // set is in. It starts whether or not this page comes from the network, so a connection too slow
  // for WAIT_MS still updates the copy in the background.
  event.waitUntil(refresh().catch(() => {}));
  try {
    return await whole(event.request, WAIT_MS);
  } catch {
    const name = await newestComplete();
    const copy = name && (await (await caches.open(name)).match(url.pathname));
    if (!copy) return Response.error();
    if (event.resultingClientId) bound.set(event.resultingClientId, name);
    return copy;
  }
}

async function file(event, url) {
  const name = bound.get(event.clientId);
  if (name) {
    // Only the page's own set: a file from a newer one could be another version than the page.
    const copy = (await caches.has(name)) && (await (await caches.open(name)).match(url.pathname));
    if (copy) return copy;
  }
  // A page from the network gets its files from the network only. A file from the copy could be
  // from another version than the page.
  return whole(event.request, WAIT_MS).catch(() => Response.error());
}

// The network's answer, read to the end within the time limit, or a failure. Reading the body
// inside the limit means a connection that drops halfway through a file counts as a failure. A
// server error counts as a failure; any other answer, such as a 404, is passed on.
async function whole(request, limit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    const response = await fetch(request, { signal: controller.signal });
    // A page's redirect, which a browser follows itself, has no body to read.
    if (response.type === 'opaqueredirect') return response;
    if (response.status >= 500) throw new Error(`server error ${response.status}`);
    const body = await response.arrayBuffer();
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally {
    clearTimeout(timer);
  }
}

// What identifies one version of a file.
const versionOf = (response) => response.headers.get('etag') || response.headers.get('last-modified') || '';

// Fetches every file into a new set, checks that none changed meanwhile, and marks it complete.
function refresh() {
  refreshing ??= (async () => {
    await dropSets((name, complete, age) => !complete && age > ABANDONED_MS);
    const name = PREFIX + Date.now();
    const cache = await caches.open(name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_MS);
    try {
      const versions = {};
      await Promise.all(FILES.map(async (path) => {
        // no-cache asks the server whether its copy changed, so an unchanged file costs little.
        const response = await fetch(path, { cache: 'no-cache', signal: controller.signal });
        if (!response.ok || response.redirected) throw new Error(`${path}: ${response.status}`);
        versions[path] = versionOf(response);
        await cache.put(path, response);
      }));
      // A deploy that landed while the set was arriving changes at least one answer here.
      await Promise.all(FILES.map(async (path) => {
        const response = await fetch(path, { method: 'HEAD', cache: 'no-cache', signal: controller.signal });
        if (!response.ok || versionOf(response) !== versions[path]) throw new Error(`${path} changed`);
      }));
      await cache.put(COMPLETE, new Response(''));
    } catch (error) {
      await caches.delete(name);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    // The newest two complete sets stay, and any a page open now is reading. Two, because another
    // copy of this worker, such as the one installing during an update, can't see this one's pages,
    // and the set one of them is reading is then the second newest.
    const live = new Set((await self.clients.matchAll()).map((client) => bound.get(client.id)));
    for (const id of bound.keys()) if (!live.has(bound.get(id))) bound.delete(id);
    const keep = new Set([name, ...live]);
    const complete = [];
    await dropSets((other, done) => { if (done) complete.push(other); return false; });
    complete.sort().reverse().slice(0, 2).forEach((n) => keep.add(n));
    await dropSets((other, done) => done && !keep.has(other) && other < name);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// Deletes each set the test picks, given its name, whether it is complete, and its age.
async function dropSets(pick) {
  for (const name of (await caches.keys()).filter((n) => n.startsWith(PREFIX))) {
    const complete = !!(await (await caches.open(name)).match(COMPLETE));
    // A name this worker didn't make has no time in it, and is left alone.
    const made = Number(name.slice(PREFIX.length));
    if (!Number.isFinite(made)) continue;
    if (pick(name, complete, Date.now() - made)) await caches.delete(name);
  }
}

async function newestComplete() {
  const names = (await caches.keys()).filter((n) => n.startsWith(PREFIX)).sort().reverse();
  for (const name of names) {
    if (await (await caches.open(name)).match(COMPLETE)) return name;
  }
  return null;
}
