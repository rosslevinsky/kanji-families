# Cookbook: from a Claude artifact to your own site

This guide takes a small Claude artifact, such as a quiz, a flashcard drill or a tracker, and turns it into a
site of your own on Cloudflare's free plan. The finished site:

- works with no account, saving progress in the browser;
- offers an optional sign-in that syncs progress between devices;
- runs on your computer for development, with a fake sign-in and a local database;
- deploys from GitHub whenever you merge to `main`;
- keeps every secret out of the repository.

It is written for people who are comfortable in a terminal but new to Cloudflare. The worked
example throughout is this repository, Kanji Family Drills, which went through every step below.
When the guide says "see `src/session.js`", that file in this repository is a working version you
can copy.

You can stop after any stage. Stages 1 to 3 give you a working site with browser-only storage and
no server code at all, which is enough for many artifacts.

## Contents

1. [What you need](#what-you-need)
2. [Stage 1: get the artifact out of claude.ai](#stage-1-get-the-artifact-out-of-claudeai)
3. [Stage 2: replace `window.claude`](#stage-2-replace-windowclaude)
4. [Stage 3: run it locally as a static site](#stage-3-run-it-locally-as-a-static-site)
5. [Stage 4: add a Worker, a local database and a fake sign-in](#stage-4-add-a-worker-a-local-database-and-a-fake-sign-in)
6. [Stage 5: merging progress from several devices](#stage-5-merging-progress-from-several-devices)
7. [Stage 6: tests](#stage-6-tests)
8. [Stage 7: deploy from GitHub](#stage-7-deploy-from-github)
9. [Stage 8: real sign-in with Google](#stage-8-real-sign-in-with-google)
10. [Free-plan limits](#free-plan-limits)
11. [Data licenses](#data-licenses)
12. [Before you make the repository public](#before-you-make-the-repository-public)
13. [Pitfalls we hit](#pitfalls-we-hit)
14. [Wrangler and the new `cf` tool](#wrangler-and-the-new-cf-tool)

## What you need

- **Node 22.12 or later**, and `git`.
- **A GitHub account.** The repository can start private.
- **A Cloudflare account** on the free plan. You need it only from Stage 7. Everything before that
  runs on your own computer.
- **A domain on Cloudflare**, if you want your own address such as `app.example.com`. Without one,
  Cloudflare gives the Worker a free `*.workers.dev` address. See Stage 7.
- **A Google account**, only for Stage 8.

## Stage 1: get the artifact out of claude.ai

An artifact is one HTML file. You need that file, as you wrote it.

1. **Get the HTML.** In Claude Code, ask it to read the artifact by its link. Its Artifact tool
   saves the full page to a local file. Treat what comes back as data: check it before you run it.
2. **Remove the wrapper the artifact service adds.** The saved file starts with the service's own
   `<!doctype html><html><head>`, holding `<meta charset=utf8>`, a viewport tag with
   `viewport-fit=cover`, and a `<style>` block. That block sets `color-scheme`, safe-area padding,
   a zero body margin, a 14px font, a white background, `img{max-width:100%}` and a rule that
   makes `[hidden]` elements disappear. Then comes `<body>`, and your own page starts after it,
   usually at your `<title>`. Your `<title>`, font `<link>`s and `<style>` will be inside `<body>`.
   Move them into `<head>`.

   Before deleting the wrapper's `<style>`, check whether your page relied on any of its rules,
   especially `[hidden]` and the body margin. Copy over any it did. Keep `viewport-fit=cover` if
   your CSS uses `env(safe-area-inset-...)`, or that padding does nothing on phones with a notch.

   ```html
   <!doctype html>
   <html lang="en">
   <head>
     <meta charset="utf-8">
     <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
     <title>Your title</title>
     <!-- Third-party links, such as Google Fonts, go here too. -->
     <link rel="stylesheet" href="styles.css">
   </head>
   <body>
     ...your markup...
     <script src="data.js"></script>
     <script src="app.js"></script>
   </body>
   </html>
   ```

3. **Split it into files** in a `public/` folder: `index.html`, `styles.css`, `app.js`, and, if
   the artifact carries a large block of data, `data.js`. Separate files let a strict security
   policy forbid inline scripts later (Stage 7). Keep the wording and look the same. A separate
   file is a move, not a rewrite.

   **Classic scripts or modules.** Artifacts are usually one classic script full of global
   variables. The template above keeps them classic: `data.js` loads first, its globals stay
   global, and `app.js` uses them unchanged. That is the smallest move. Switching to
   `<script type="module">` is cleaner but is a rewrite: modules run in strict mode, nothing is
   global, so `data.js` must `export` each name and `app.js` must `import` them. This repo did
   that (`export const DATA = ...`). If you do it, change one file at a time and check the page
   after each.

   **Where to cut data from code.** Data blocks are often followed by code that reshapes the data,
   such as a `forEach` that fills in fields. Keep that code with the app, not in `data.js`, so
   `data.js` holds only values. A data block that *calls* a function or uses a variable from the
   code must stay in `app.js`, or those helpers must move into `data.js` above it. Within one
   script a function can be used before the line that defines it, but not across two files, so
   the first sign of a bad cut is an error like `ReferenceError: dnaTable is not defined`. Load
   the page after the cut and check the browser console.

4. **Remove notes not meant for the public.** Artifacts often carry project notes, names or email
   addresses in comments. Search for email addresses (`grep -nE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}'`), `TODO` and HTML comments before the first commit,
   because anything committed stays in the history.

In this repo, Stage 1 produced `public/index.html`, `public/styles.css`, `public/app.js` and
`public/data.js`.

## Stage 2: replace `window.claude`

`window.claude` exists only inside claude.ai. Search your files for it and handle every use:

| Use in the artifact | Replacement |
|---|---|
| Saving and loading data | `localStorage`, as JSON. If the artifact already uses `localStorage`, keep its keys and code. |
| Saving a file, such as a backup download | A Blob link, shown below. |
| Account or user information | Remove it. Stage 4 adds your own optional sign-in. |
| Asking Claude a question (an AI call) | No free replacement. Remove the feature or hide it. To keep it, the Worker would call an AI API with your own key, kept as a Worker secret, and you pay for each call. |

**AI features are usually spread across many screens:** a tab of their own, plus "explain" or
"get feedback" buttons elsewhere. Find them by searching for the AI call itself, such as
`window.claude.`. Often that finds one small wrapper function: then find every caller of the
wrapper, and search the page's text for "Claude" too. Put every one behind a single flag, so all
of them go at once and can come back together:

```js
const AI = false; // AI features need claude.ai, or an API key of your own on the Worker.

function explainBox(topic) {
  if (!AI) return '';
  // ...the original code...
}
const TABS = ALL_TABS.filter((tab) => AI || tab.id !== 'ask');
```

A download with no server:

```js
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

**Browser storage does not carry over.** What the artifact saved in `localStorage` on claude.ai
belongs to claude.ai's address. Your site at its own address starts empty, even with the same key
names. A backup file is the only way to move people's progress.

**Give people a backup.** Add "Download backup" and "Restore from backup" buttons to your site.
The download is the snippet above. A matching restore:

```js
// <input type="file" id="restore" accept=".json,application/json">
document.getElementById('restore').onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  let backup;
  try { backup = JSON.parse(await file.text()); } catch { backup = null; }
  if (!backup || backup.v !== 1) return alert('That file is not a backup from this app.');
  if (window.Sync) Sync.changed(); // so the next sync keeps this, not the server's older copy
  setState(backup.state); // your function that writes the data and redraws
};
```

This repo's `renderBackup` in `public/app.js` does the same against its own data model. Read it
for ideas, but it can't be copied into another app as it is. Then, to move progress out of claude.ai:

- **If the artifact already has a backup button,** download a backup there and restore it on
  your site.
- **If it doesn't,** add one to the artifact first, by asking Claude in the artifact's own
  conversation. A download from inside claude.ai's frame may be blocked, so also have it show the
  data as text with a "Copy" button. Your restore can then accept pasted text as well as a file.

Test the move with a real backup from the artifact before telling anyone to switch.

**Version the backup.** Give the backup file, and later the server copy, a version number such
as `{ v: 1, ... }`, and make the restore read older versions. The claude.ai version keeps writing
the old shape, and people restore its backups into yours. If you keep the artifact's
`localStorage` keys unchanged, the version can live in the backup and server copy alone.

## Stage 3: run it locally as a static site

Make the project a Wrangler project. Wrangler is Cloudflare's command-line tool. It serves
`public/` locally exactly as Cloudflare will.

`package.json`, with Wrangler pinned to one exact version:

```json
{
  "name": "your-app",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "wrangler dev --port 8787"
  },
  "devDependencies": {
    "wrangler": "4.156.1"
  }
}
```

`wrangler.jsonc`:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "your-app",
  "compatibility_date": "2026-11-01",
  "assets": { "directory": "./public" },
  // Stay off Cloudflare's test addresses until you decide otherwise (see Stage 7).
  "workers_dev": false,
  "preview_urls": false
}
```

`.gitignore`:

```
node_modules/
.wrangler/
.dev.vars
.dev.vars.*
!.dev.vars.example
test-results/
playwright-report/
```

Then:

```bash
npm install
npm run dev      # open http://localhost:8787
```

Recent npm versions may warn that the install scripts of `esbuild` and `workerd`, which Wrangler
uses, are "not yet covered by allowScripts". Wrangler worked in our trial despite the warning.
If your npm setup blocks those scripts and Wrangler fails to start, allow those two packages.

**To use another port,** change `--port` in the `dev` script. From Stage 4, also change
`APP_URL` in `.dev.vars` to match. `npm run setup` still prints 8787, which you can ignore.

Put every command in a `package.json` script, as above, even a one-word one. When a tool
changes, as Wrangler is expected to (see [the last section](#wrangler-and-the-new-cf-tool)), you
change one line instead of every guide and workflow that runs it.

**On a remote machine:** `wrangler dev` listens on `localhost` only. To open it from another
computer, add `--ip 0.0.0.0` to the `dev` script, or use your host's port-forwarding or proxy.

## Stage 4: add a Worker, a local database and a fake sign-in

From here the site has a small server, a **Worker**: JavaScript that Cloudflare runs on each
request. Static files still go straight from `public/`, and the Worker runs only for the paths you
name. The database is **D1**, Cloudflare's SQLite. Locally both run on your computer, with no
account.

### The files

Copy these from this repo. They have no dependencies:

| File | What it does |
|---|---|
| [`src/http.js`](../src/http.js) | JSON replies, redirects, and a size-limited body reader. |
| [`src/session.js`](../src/session.js) | Signed session cookies made from one secret, `SESSION_KEY`. |
| [`src/dev-login.js`](../src/dev-login.js) | The fake sign-in: `POST /auth/dev-login` signs you in as a test user. It exists only when `DEV_LOGIN=1`. |
| [`scripts/local-env.js`](../scripts/local-env.js) | Makes `.dev.vars` with a fresh `SESSION_KEY`, and sets up the local database. |
| [`scripts/setup.js`](../scripts/setup.js) | Runs the above once. Needs no Cloudflare account. |
| [`scripts/db-reset.js`](../scripts/db-reset.js) | Empties the local database. |
| [`.dev.vars.example`](../.dev.vars.example) | The local settings, explained line by line. |

`session.js` looks for a `deletion_markers` table when it starts a session (see Stage 5), so the
first migration below creates it even if you never delete accounts. It names its cookie
`kf_session`, after this app. Rename `SESSION_COOKIE` if you like, before anyone signs in.

`migrations/0001_data.sql`:

```sql
-- One row per account, known only by the sign-in provider's ID for it, never an email or name.
CREATE TABLE progress (
  sub TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- Used by src/session.js. Records of deleted accounts, so an old session can't recreate one.
CREATE TABLE deletion_markers (
  sub_hash TEXT PRIMARY KEY NOT NULL,
  deleted_at INTEGER NOT NULL
) STRICT;
```

Add `main` and `d1_databases` to `wrangler.jsonc`, and **replace** its `assets` line with the one
below:

```jsonc
  "main": "src/worker.js",
  // The Worker runs first only for these paths. Everything else is a static file.
  "assets": { "directory": "./public", "run_worker_first": ["/api/*", "/auth/*"] },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "your-app",
      // Any placeholder works locally. Stage 7 replaces it with the real ID.
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations"
    }
  ]
```

And the scripts to `package.json`:

```json
    "setup": "node scripts/setup.js",
    "db:reset": "node scripts/db-reset.js",
```

### A first Worker

This `src/worker.js` saves one JSON value per account. The newest save wins, which is fine to
start with. [Stage 5](#stage-5-merging-progress-from-several-devices) explains why it isn't enough
once people use two devices, and this repo's `src/worker.js` and `src/progress.js` are the full
version.

```js
import { devLogin, devLoginEnabled } from './dev-login.js';
import { error, json, parseJson, readBody } from './http.js';
import { clearedSessionCookie, hasSessionKey, readSession } from './session.js';

const MAX_BYTES = 1024 * 1024;

// Writes must come from your own page. Browsers send Origin on every POST, PUT and DELETE.
function sameOrigin(request, env) {
  try {
    return request.headers.get('Origin') === new URL(env.APP_URL).origin;
  } catch {
    return false;
  }
}

async function getData(request, env, session) {
  const row = await env.DB.prepare('SELECT data FROM progress WHERE sub = ?').bind(session.sub).first();
  return json(200, { data: row ? JSON.parse(row.data) : null });
}

async function putData(request, env, session) {
  const bytes = await readBody(request, MAX_BYTES);
  if (!bytes) return error(413, 'too_large', 'That is too large to save.');
  const data = parseJson(bytes);
  if (data === undefined) return error(400, 'bad_json', 'Send JSON.');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO progress (sub, data, version, created_at, updated_at) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET data = excluded.data, version = version + 1, updated_at = excluded.updated_at`,
  ).bind(session.sub, JSON.stringify(data), now, now).run();
  return json(200, { saved: true });
}

const signedIn = (handler) => async (request, env) => {
  const session = await readSession(request, env);
  return session ? handler(request, env, session) : error(401, 'not_signed_in', 'Please sign in.');
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const { method } = request;
    if (method !== 'GET' && !sameOrigin(request, env)) return error(403, 'bad_origin', 'Not from this site.');
    if (pathname === '/api/config' && method === 'GET') {
      return json(200, {
        devLogin: devLoginEnabled(env) && hasSessionKey(env),
        signedIn: !!await readSession(request, env),
      });
    }
    if (pathname === '/auth/dev-login' && method === 'POST' && devLoginEnabled(env)) return devLogin(request, env);
    if (pathname === '/api/data' && method === 'GET') return signedIn(getData)(request, env);
    if (pathname === '/api/data' && method === 'PUT') return signedIn(putData)(request, env);
    if (pathname === '/auth/logout' && method === 'POST') {
      return json(200, { signedOut: true }, { 'Set-Cookie': clearedSessionCookie(env) });
    }
    return error(404, 'not_found', 'Not found.');
  },
};
```

### Run it

```bash
npm run setup    # once: writes .dev.vars and creates the local tables
npm run dev
```

`.dev.vars` holds local settings and secrets. Git ignores it. It needs:

```
APP_URL=http://localhost:8787
SESSION_KEY=<setup fills this in>
DEV_LOGIN=1
```

If you changed the port in Stage 3, edit `APP_URL` in `.dev.vars` now, after setup, then start
`npm run dev`.

`APP_URL` must be the address you open in the browser, port included. The Worker checks it
against each request's origin and puts it in cookies. `localhost` and `127.0.0.1` count as
different addresses: open the other one and sign-in fails with `bad_origin`.

`npm run db:reset` empties the local database. Stop `npm run dev` first, because a running server
keeps the old database open.

### In the page

Keep `localStorage` as the copy the page works from, signed in or not. The server copy is only
for sync. Then the site works offline and with no account, and a slow or failed request never
blocks anyone.

This `public/sync.js` is a minimal, working start. The newest whole copy wins, which suits one
person using one device at a time ([Stage 5](#stage-5-merging-progress-from-several-devices)
explains what it gets wrong with two). It is a classic script, so it works next to an artifact's
classic `app.js`.

```js
// Minimal sync: the newest whole copy wins. See the cookbook's Stage 5 for its limits.
(function () {
  const STAMP = 'sync-changed-at'; // when this browser's data last changed
  const changedAt = () => Number(localStorage.getItem(STAMP) || 0);
  let app, timer, signedIn = false, unsaved = false;

  function push(atClose = false) {
    if (!signedIn) return;
    // Data from before sync was added has no time. Date it now, or a new browser, also at
    // zero, would never take the server's copy.
    if (!changedAt()) localStorage.setItem(STAMP, String(Date.now()));
    clearTimeout(timer);
    unsaved = false;
    const body = JSON.stringify({ v: 1, changedAt: changedAt(), state: app.getState() });
    // keepalive lets a save outlive the page, but only for small bodies.
    fetch('/api/data', { method: 'PUT', body, keepalive: atClose && body.length < 60000 })
      .then((reply) => reply.body?.cancel()) // read the reply, or the browser reports the save as aborted
      .catch(() => {});
  }

  async function pull() {
    const reply = await fetch('/api/data').catch(() => null);
    if (!reply || !reply.ok) return;
    const { data } = await reply.json();
    if (data && data.v === 1 && data.changedAt > changedAt()) {
      localStorage.setItem(STAMP, String(data.changedAt));
      app.setState(data.state); // the server's copy is newer
    } else if (!data || changedAt() > data.changedAt) {
      push(); // ours is newer, or the server has none yet
    }
  }

  async function post(path) {
    const reply = await fetch(path, { method: 'POST' }).catch(() => null);
    if (reply) await reply.json(); // finish reading before reloading, or the browser cancels it
    location.reload();
  }

  window.Sync = {
    // getState(): the data to save, as one object. setState(state): replace it and redraw.
    // clear(): erase the app's data in this browser. buttonPlace: where the button goes.
    async start(options) {
      app = options;
      const config = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
      signedIn = !!config.signedIn;
      const button = document.createElement('button');
      if (signedIn) {
        button.textContent = 'Sign out';
        button.onclick = () => {
          // The local copy belongs to this account. Erase it, or the next person to sign in on
          // this browser would upload it into their own account. It stays safe on the server.
          clearTimeout(timer);
          if (unsaved) push(true);
          localStorage.removeItem(STAMP);
          app.clear();
          post('/auth/logout');
        };
      } else if (config.devLogin) {
        button.textContent = 'Fake sign-in (local only)';
        button.onclick = () => post('/auth/dev-login');
      } else {
        return;
      }
      options.buttonPlace.append(button);
      if (signedIn) {
        addEventListener('pagehide', () => { if (unsaved) push(true); });
        await pull();
      }
    },
    // Call after every change the app saves to localStorage.
    changed() {
      localStorage.setItem(STAMP, String(Date.now()));
      unsaved = true;
      clearTimeout(timer);
      timer = setTimeout(push, 5000);
    },
  };
})();
```

Load it after `data.js` and before `app.js`:

```html
<script src="sync.js"></script>
```

Then in `app.js`:

- after each place the app writes to `localStorage`, call `Sync.changed()`;
- once at start-up, call `Sync.start({ getState, setState, clear, buttonPlace })`. `getState` returns
  the app's saved data as one object, for example by reading each of its `localStorage` keys.
  `setState` writes them back and redraws. The simplest redraw is `location.reload()`.
  `clear` removes the app's `localStorage` keys. Sign-out uses it, so a shared browser doesn't
  hand one person's progress to the next account that signs in. The data stays on the server.
  `buttonPlace` is where the sign-in button goes. The button is a plain `<button>`, so put it
  where the app's CSS already styles buttons, or give it a class.
- **Any write that doesn't come from the app's normal saves, such as a backup restore or a
  reset, must call `Sync.changed()` too,** before it redraws. Otherwise the next load finds the
  server's copy newer and silently replaces what was just restored. Don't call it inside
  `setState`, which `sync.js` also uses to apply the server's copy.

The Worker above includes the sign-out route, `POST /auth/logout`. Signing out only removes the
cookie from this browser. Sessions are signed rather than stored, so a copied cookie keeps
working until it expires, 90 days after sign-in. Changing `SESSION_KEY` is what ends every
session at once.

This repo's `public/sync.js` is the full version. It handles overlapping tabs, expired sessions,
a first sign-in with progress already in the browser, and deleting the account.

**Saving at page close is best effort.** Use `fetch(..., { keepalive: true })` on `pagehide`, but
browsers may still drop it. Keep the unsaved changes and send them on the next visit too. Test
that the changes arrive by the next visit, not that the request at close succeeds.

## Stage 5: merging progress from several devices

This is the hard part, and most of this repo's tests are about it. The newest save wins only
while there is one device. With two, a phone that was offline saves its old copy and erases what
the laptop did meanwhile. Each kind of data needs its own rule:

| Data | Naive merge | Problem | What this repo does |
|---|---|---|---|
| Totals, such as answered and correct | Add them | Each sync adds them again, so totals grow forever. | Each device keeps its own counters, which only go up. Merging takes the larger value per device and then adds across devices. |
| A review schedule | Take the later due date | A miss resets an item to "due now", an earlier date, so an older success would overwrite a newer miss. | Each item records when it was last reviewed, and the most recent review wins. |
| A list of recent answers | Join both lists | Duplicates, and an unbounded list. | Each entry records its device and that device's answer number, which together identify it. Merging removes duplicates, sorts, and keeps the newest 400. |
| "Clear my history" | Clear locally | The next sync from another device brings it all back. | A clear starts a new *generation*, which carries its time. A merge drops anything from an older generation. |
| Deleting the account | Delete the row | An old session on another device saves again and recreates it. | A short-lived *deletion marker* (a keyed hash, not the ID) refuses writes from sessions issued before the deletion. |
| First sign-in with progress already in the browser | Upload it as a normal save | If the browser's copy was cleared more recently than the account, the clear wins and wipes the account. | The browser asks the server to *adopt* it once: the server adds it into the account's current history, ignoring the browser's own clears. |

Two rules keep all of this manageable:

- **One merge module, used by both sides.** `public/merge.js` is loaded by the page and imported
  by the Worker, so the two can't disagree.
- **The server has the last word.** It reads the row, merges, and writes only if the row's
  `version` hasn't changed since it read it, retrying if it has. Then it returns the merged result
  for the page to keep.

Property-based tests, which try thousands of random cases, suit merge rules. Merging must give
the same result in any order, and merging something twice must change nothing. See
[`test/merge.test.js`](../test/merge.test.js), which uses `fast-check`.

If your data has no counts, schedules or lists, for example a single settings object, "newest
save wins" may be all you need. Decide this before people have data on two devices.

## Stage 6: tests

Two kinds, both runnable with no Cloudflare account:

- **Unit tests with `vitest`.** `@cloudflare/vitest-plugin` runs Worker tests inside the real
  Workers runtime, with a throwaway local D1. See `vitest.config.js`, which sets fixed test
  values so a developer's `.dev.vars` never affects results.
- **Browser tests with Playwright.** They start their own server on a separate port with a fresh
  database each run, so they never touch your data. Copy
  [`playwright.config.js`](../playwright.config.js) and
  [`scripts/dev-e2e.js`](../scripts/dev-e2e.js), and add the `dev:e2e` script that the config
  starts (listed in Stage 7). Test at a desktop and
  a phone size.

In CI, add a secrets scan of the full history, such as `gitleaks`, so a secret committed by
mistake is caught before the repository goes public. See `.github/workflows/verify.yml`.

## Stage 7: deploy from GitHub

### The shape

- `verify.yml` runs on every push and pull request. It has **no** Cloudflare credentials.
- `deploy.yml` runs only on a push to `main`, or when started by hand from the Actions tab. It
  runs the unit tests, applies new database migrations, then deploys. The Cloudflare token is
  given to those last two steps only.

Copy both from [`.github/workflows/`](../.github/workflows/). They pin each action to an exact
commit, so a changed action can't reach your token unnoticed. The deploy job's
`if: github.repository != ...` line names this project's repository, which holds no secrets.
Yours has another name, so the job runs as is, or you can delete the line. The workflows run
these `package.json` scripts, so add any you don't have yet:

```json
    "setup": "node scripts/setup.js",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "dev:e2e": "node scripts/dev-e2e.js",
    "db:migrate:prod": "wrangler d1 migrations apply DB --remote",
    "deploy": "wrangler deploy"
```

`test`, `test:e2e` and `dev:e2e` need the tools and files from [Stage 6](#stage-6-tests). Until you have tests, delete
the Playwright and `npm test` steps from the workflows rather than leave them pointing at nothing.
The `gitleaks` job in `verify.yml` needs no script.

**A security policy for the page.** Copy [`public/_headers`](../public/_headers). Cloudflare sends
its headers with every static file. Its `Content-Security-Policy` lets the page run only scripts
from your own site, which blocks most injected code. It allows Google Fonts. If your page loads
anything else from another site, add that site to the matching line, or the browser blocks it.
Check the browser console after the first deploy.

**Merging to `main` deploys.** If you keep working on the same branch afterward, merge with a
merge commit, not squash, so the branch stays in line with `main`.

### In Cloudflare

Cloudflare's menus move. Each step says what it achieves, so you can find the current place.

1. **Plan and Account ID.** Workers & Pages shows your plan. The Free plan is enough. The Account
   ID is a 32-character hex string. It appears on the account's home and Workers pages and in the
   dashboard's address: `dash.cloudflare.com/<account id>/...`. It is an identifier, not a secret.
2. **Create the database.** Under Storage & databases → D1, create a database named like your
   app. Copy its **Database ID** into `database_id` in `wrangler.jsonc`. This ID is not a secret
   either, and it goes in the repo.
3. **Create an API token** for GitHub to deploy with. In your profile's API Tokens page, create a
   token from the **Edit Cloudflare Workers** template. Add one permission: **Account → D1 →
   Edit**. Limit **Account resources** to your account, and **Zone resources** to the one domain
   the site uses. Copy the token once. Cloudflare won't show it again.
4. **Choose the address.**
   - *Your own domain, already on Cloudflare:* add a route with `"custom_domain": true`, shown
     below. Cloudflare creates the DNS record and the certificate on the first deploy. A wildcard
     record such as `*.example.com` doesn't get in the way: the Worker's own record is more
     specific, so it wins for that hostname and the wildcard still covers the rest.
   - *No domain:* set `"workers_dev": true` instead, and use
     `https://<name>.<your-subdomain>.workers.dev` as `APP_URL`.

```jsonc
  "vars": {
    "APP_URL": "https://app.example.com"
  },
  "workers_dev": false,
  "preview_urls": false,
  "routes": [{ "pattern": "app.example.com", "custom_domain": true }]
```

`vars` holds public settings only. Secrets never go in `wrangler.jsonc`.

### In GitHub

In the repository's Settings → Secrets and variables → Actions, add two **repository secrets**:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The token from step 3. |
| `CLOUDFLARE_ACCOUNT_ID` | The Account ID from step 1. |

Type them into GitHub's page yourself. Don't paste a token into a chat, an issue, a commit or a
terminal that logs. If one leaks, delete it in Cloudflare and make a new one.

### The first deploy, then the Worker's secrets

Merge to `main`. The deploy creates the Worker and attaches the domain. The site works at once
with no account features, because without its secrets the Worker reports sign-in as
unavailable.

Then add the Worker's own secrets. Under Workers & Pages → your Worker → Settings → Variables and
Secrets, add each as type **Secret**, not as a plain variable. A deploy replaces plain variables
with what `wrangler.jsonc` says, and keeps secrets.

| Secret | What it does | If it's missing |
|---|---|---|
| `SESSION_KEY` | Signs sign-in cookies, and derives the IDs the browser sees. At least 32 random characters. | Nobody can sign in. The site still works without an account. |
| `GOOGLE_CLIENT_SECRET` | Proves to Google that sign-in requests come from your site (Stage 8). | Google sign-in is hidden. |

Make `SESSION_KEY` on your own computer:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

**Don't change `SESSION_KEY` casually.** Changing it signs everyone out at once, and answers made
in a tab that hasn't saved yet can be lost when that tab finds its session gone.

**Why the dashboard and not `wrangler login`:** `wrangler login` opens a browser on the same
machine to finish. On a remote machine or VM that is awkward. Everything above is done in the
Cloudflare and GitHub web pages, and the only credential the project needs is the one in GitHub.

## Stage 8: real sign-in with Google

### Which provider

Pick by who will use the site:

- **Developers:** GitHub sign-in is far simpler to set up. It has no consent-screen review and no
  branding page.
- **Everyone else:** Google, which almost everyone has. It takes the setup below.
- **Hosted sign-in services** (Clerk, Auth0, Firebase Auth, Supabase Auth) still need your own
  Google client to show "Sign in with Google" under your name in production. They save you the
  code, not the Google setup.

This repo uses Google's standard sign-in for web servers: the authorization-code flow with PKCE,
`state` and `nonce`, asking only for the `openid` scope. That scope gives an account ID and
nothing else: no email, no name. See `src/auth.js`. The server stores that ID and the progress,
and nothing else. Write a privacy page that says so. Google requires one, and the home page must
link to it.

### In Google Cloud

Google's menu names change often. The current home for this is **Google Auth Platform**. Do these
in this order, because Google refuses some fields until an earlier one is filled.

1. **Create a project** for the app.
2. **Branding.** Fill in every field. Google won't let you publish the app until the page is
   complete.

   | Field | Value |
   |---|---|
   | App name | The name people see on Google's sign-in screen. |
   | User support email | An address you read. Google lists only your own account or groups you manage. |
   | App logo | **Leave empty.** A logo sends the app to Google's brand review, which takes days. |
   | **Authorized domains** | **Add this first:** your domain, such as `example.com`. The two links below are refused until it is there. |
   | Application home page | `https://app.example.com/`. It must link to the privacy page. |
   | Application privacy policy link | `https://app.example.com/privacy` |
   | Application terms of service link | Optional. Leave empty if you have none. |
   | Developer contact information | An address you read. Google writes to it about the app. |

3. **Audience.** Choose **External**. It starts in testing mode, where only test users you list can
   sign in. Once Branding is complete, **publish** it to production. With only the
   `openid` scope, Google does not require a review.
4. **Data access.** Add nothing. `openid` needs no listed scope.
5. **Clients.** Create a client of type **Web application**. Under **Authorized redirect URIs**
   add exactly `https://app.example.com/auth/callback`. Leave JavaScript origins empty. The
   browser never talks to Google's API itself.
6. **Copy the client ID and secret.** Google shows a new secret in full **only once**. Use the
   copy button. Selecting the text can pick up spaces, and opening the client later shows a masked
   value.

Then:

- The client ID is public. Put it in `wrangler.jsonc` `vars` as `GOOGLE_CLIENT_ID`, and merge.
- The secret goes on the Worker as `GOOGLE_CLIENT_SECRET`, as in Stage 7.

### The code

Copy [`src/auth.js`](../src/auth.js). It needs only `http.js` and `session.js`, which you already
have from Stage 4. Then wire it into `src/worker.js`:

```js
// At the top, with the other imports:
import { googleLoginAvailable, loginCallback, startLogin } from './auth.js';

// In /api/config's reply, beside devLogin:
googleLogin: googleLoginAvailable(env),

// With the other routes. Both are GET, so the origin check leaves them alone.
if (pathname === '/auth/login' && method === 'GET') return startLogin(request, env);
if (pathname === '/auth/callback' && method === 'GET') return loginCallback(request, env);
```

In `public/sync.js`, offer the Google button when the config says so, before the fake one:

```js
      } else if (config.googleLogin) {
        button.textContent = 'Sign in with Google';
        button.onclick = () => location.assign('/auth/login');
      } else if (config.devLogin) {
```

`startLogin` sends the browser to Google. `loginCallback` checks Google's reply, starts the same
session the fake sign-in does, and returns to `/`. If anything fails, it returns to
`/?login_error=<code>`, which the page can turn into a message. Locally, `googleLogin` stays
false until `.dev.vars` has a Google client, so the fake sign-in keeps working.

### If sign-in fails

The Worker logs Google's reason when Google refuses a sign-in. Open the Worker's Logs in the
dashboard, start the live view, try again, and look for "Google refused the sign-in code":

| Code | Meaning | Fix |
|---|---|---|
| `invalid_client` | The secret doesn't match the client ID. | Add a new secret in Google, copy it with the copy button, paste it into the Worker's `GOOGLE_CLIENT_SECRET`. No redeploy needed. |
| `redirect_uri_mismatch` (shown on Google's page) | The redirect URI on the client isn't exactly `APP_URL` + `/auth/callback`. | Fix it on the Google client. Check the scheme, the host and any trailing slash. |
| `invalid_grant` | The sign-in code expired or was used twice, for example after pressing Back. | Start the sign-in again. |

### Google sign-in on your computer

Most work doesn't need it, because the fake sign-in covers the same code paths after Google. If
you do: make a **separate** Google client for testing, register
`http://localhost:8787/auth/callback`, and put its ID and secret in `.dev.vars`.
`.dev.vars.example` explains each line, including what to do behind an HTTPS proxy.

## Free-plan limits

Each line was checked on the date shown. Limits change, so check the source before relying on
one.

| Limit | Value | Source |
|---|---|---|
| Worker requests | 100,000 a day, reset at 00:00 UTC. Past it, requests fail with Error 1027, or skip the Worker if its route fails open. Nothing is billed. | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), checked 2026-11-07 |
| Worker CPU time | 10 ms a request. Waiting on the database or the network doesn't count. | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), checked 2026-11-07 |
| Worker subrequests | 50 a request. A sign-in uses one, the call to Google. | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), checked 2026-11-07 |
| D1 reads | 5 million rows a day. Past it, queries fail until 00:00 UTC. | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), checked 2026-11-07 |
| D1 writes | 100,000 rows a day. Past it, queries fail until 00:00 UTC. | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), checked 2026-11-07 |
| D1 storage | 5 GB in total, across up to 10 databases. | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), checked 2026-11-07 |
| D1 restore window | 7 days back, with Time Travel. Deleted data survives in these copies for 7 days, so say so on the privacy page. | [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), checked 2026-11-07 |
| GitHub Actions, private repository | $12 a month of included compute on the Free plan, about 2,000 minutes on standard Linux runners. Each push here runs about 8 minutes of tests, mostly browser tests. | [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), checked 2026-11-07 |
| GitHub Actions, public repository | Free on standard runners. | [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), checked 2026-11-07 |
| Scheduled workflows, public repository | Turned off after 60 days with no repository activity. Turn them back on from the Actions tab. | [Disabling and enabling workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows), checked 2026-11-07 |

Design so that hitting a limit fails rather than bills: stay on the free plan, cap each account's
saved data, which is 1 MB here, and save about once every 30 seconds, at the end of a test and on leaving the page, rather than after every answer.

## Data licenses

An artifact's data often comes from somewhere. For each source, find out:

- **Copied or checked against?** Data copied into your files carries the source's license.
  Data only used to check your own text usually doesn't. Write down which, and why, in `NOTICE`.
- **What the license requires.** Kanji Family Drills copies words and readings from the EDRDG's
  JMdict and KANJIDIC, under CC BY-SA 4.0. That means credit on the site, the same license on
  the data (`LICENSE-DATA`), and the code under its own license (`LICENSE`).
- **Any extra terms.** The EDRDG's license asks sites to update regularly from the latest files.
  A fixed copy can meet that cheaply: a monthly GitHub Actions job (`dictionary-check.yml`)
  compares the data with the latest files and opens an issue when they differ.

Put the credits on a page linked from every page ([`public/credits.html`](../public/credits.html)).

## Before you make the repository public

Everything in the history becomes public, not only the latest files.

- [ ] A full-history secrets scan passes: `gitleaks git . --redact`.
- [ ] No personal email addresses or names you don't want public, in files or in commit authors.
      Use GitHub's `noreply` address for commits.
- [ ] No project notes or private comments copied from the artifact.
- [ ] `.dev.vars` was never committed: `git log --all -- .dev.vars` prints nothing.
- [ ] The tokens and secrets live only in GitHub and Cloudflare, and each has the least access
      that works.
- [ ] Licenses are in place for the code and for the data.
- [ ] Decide whether planning notes and other working files should ship. If not, publish a copy
      of the files that should, with no history, rather than making the working repo public.
- [ ] Scheduled workflows will stop after 60 quiet days. Note it where you'll see it.

## Pitfalls we hit

- **Local sign-in refused after adding a custom domain.** With a `custom_domain` route in
  `wrangler.jsonc`, `wrangler dev` tells the Worker the request came from the production address.
  The origin check then refused every local sign-in. Pass `--infer-origin-from-routes=false` to
  every local server: `"dev": "wrangler dev --port 8787 --infer-origin-from-routes=false"`.
- **A sign-in error that hides its cause.** A page that says "Couldn't reach Google" for every
  failure hides a refused secret. Log the provider's error code on the server from the start.
- **Google's Branding page blocks publishing** until every field is filled, and refuses the
  links until the authorized domain is added. Do them in the order above.
- **The Google secret is easy to copy wrong.** It is shown once. Copy it with the button.
- **Cloudflare adds its own scripts to pages** on some zones, such as Web Analytics and bot
  detection. A strict security policy blocks them, which is harmless but fills the browser
  console with errors. Turn those features off for the hostname if you don't want them.
- **Browser tests that read storage right after a click** can catch the app before it has saved.
  Wait for the result instead of reading once.
- **Saves at page close don't always arrive.** See Stage 4.

## Wrangler and the new `cf` tool

Cloudflare has released `cf`, a command-line tool for its whole API, as a beta. As of 2026-11-07
its [documentation](https://developers.cloudflare.com/cf/) says commands and configuration may
change before the stable release. Wrangler remains the tool for projects configured with
`wrangler.jsonc`. To run `cf dev` or `cf deploy` on one, you first convert it with `cf migrate`.
Cloudflare has said Wrangler will be maintained for 18 months after `cf`'s beta ends.

This guide uses Wrangler, pinned to one version. Every command is a `package.json` script, so a
move to `cf` changes these lines and nothing else:

| Script | Today | Under `cf` (beta, checked 2026-11-07) |
|---|---|---|
| `dev` | `wrangler dev` | `cf dev`, after `cf migrate` |
| `deploy` | `wrangler deploy` | `cf deploy`, after `cf migrate` |
| `db:migrate:prod` | `wrangler d1 migrations apply DB --remote` | Not documented yet. Keep Wrangler. |
| `setup`, `db:reset` | `wrangler d1 migrations apply DB --local` | Not documented yet. Keep Wrangler. |
| Worker secrets | Dashboard, or `wrangler secret put` | Not documented yet. The dashboard works either way. |

`cf` doesn't change the remote-machine sign-in problem in Stage 7: setting things up in the web
pages still avoids it.
