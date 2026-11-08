# Kanji Family Drills

Most kanji past the first few hundred are built from two parts: one hints at the meaning, the
other at the sound. Learn the common sound parts, and a kanji you have never seen often tells
you how it is read. This app teaches 55 of the most useful sound families, covering 239 jōyō
kanji, and drills them on a review schedule.

Try it at **[kanjifamilies.speedytuna.com](https://kanjifamilies.speedytuna.com)**. It works on
a phone, and you can add it to your home screen or install it from the browser menu to open it
like an app. It follows your device's light or dark setting, or you can pick one at the bottom
of the page.

## What's in this repo

Two things, which share one codebase:

- **A working app.** Use it on the live site, run it on your computer with no accounts or setup,
  or fork it and deploy your own copy. A fork fills in four settings of its own first: a domain,
  a database, a Google sign-in client and a contact address. See
  [Deploying your own copy](#deploying-your-own-copy).
- **[A cookbook](docs/COOKBOOK.md)** for turning a Claude artifact of your own into a site like
  this one: usable without an account, with optional Google sign-in that syncs progress between
  devices, tests, and deploys from GitHub. It goes step by step, with this app as the worked
  example.

Both fit in Cloudflare's free plan. The cookbook's
[free-plan limits](docs/COOKBOOK.md#free-plan-limits) say how far that goes.

## What it does

- **Study:** every family on one page, with how closely each member's on'yomi follows the sound
  part. Search by kanji, English or reading, and tap any kanji or word for details.
- **Practice:** five kinds of quiz. Pick a kanji's reading from its sound part, read a common
  word, match a kanji to its meaning, find the odd one out among four kanji that share a sound
  part, or name the category its meaning part points to. What you miss comes back sooner.
- **History:** accuracy, what is due, past tests and recent answers.
- **No account needed.** Progress stays in your browser, and you can download a backup file.
- **Optional Google sign-in** syncs progress between devices. The server keeps only Google's ID
  for the account and the progress itself. See [the privacy page](public/privacy.html).

## How it fits together

| Part | Where | What it does |
|---|---|---|
| The page | `public/` | Plain HTML, CSS and JavaScript, with no framework and no build step. Served as static files. |
| Progress and merging | `public/merge.js` | The progress format and the rules for merging two devices' progress. The browser and the server share this one file, so they can't disagree. |
| Sync in the browser | `public/sync.js` | Signs in and out, and saves to and loads from the account. Study never waits on it. |
| The Worker | `src/` | A Cloudflare Worker that runs only for `/api/*` and `/auth/*`: Google sign-in, sessions, and saving progress. |
| The database | `migrations/` | Cloudflare D1, which is SQLite. One row of progress per account. |
| Tests and deploys | `.github/workflows/` | Tests and a secrets scan on every push, a deploy from `main`, and a monthly check of the word data against the latest dictionary files. |

## Running it on your computer

You need Node 22.12 or later. No Cloudflare account, Google setup or secrets.

```bash
npm ci
npm run setup   # once: writes .dev.vars with a local key and creates the local database
npm run dev     # http://localhost:8787
```

The local site has a **fake sign-in** button, so you can try syncing without Google. It uses a
local database in `.wrangler/`.

| Command | What it does |
|---|---|
| `npm run dev` | The local site at http://localhost:8787. Restart it after changing `.dev.vars`. |
| `npm run db:reset` | Empties the local database. Stop `npm run dev` first. |
| `npm test` | Unit tests, including the Worker's, against a throwaway database. Add a file name to run one file: `npm test -- auth`. |
| `npm run test:e2e` | Browser tests on Chromium at desktop and phone sizes, on their own port and database. Run `npx playwright install chromium` once first. |
| `npm run test:e2e:browsers` | The same tests in Firefox at desktop size and WebKit (Safari's engine) at both sizes. Run `npx playwright install --with-deps firefox webkit` once first. This repo's CI runs them on every push to `main`. |
| `npm run check:dictionary` | Compares the word data with the latest JMdict and KANJIDIC. It downloads about 12 MB. |

To try real Google sign-in locally, follow the notes in [`.dev.vars.example`](.dev.vars.example).
Most changes don't need it.

## Deploying your own copy

The cookbook's [deploy](docs/COOKBOOK.md#stage-7-deploy-from-github) and
[Google sign-in](docs/COOKBOOK.md#stage-8-real-sign-in-with-google) stages walk through each step
below in detail.

1. **Fill in your own settings.** This repo holds placeholders where the live site has its own
   values. Nothing deploys until they are filled in:
   - `your-domain.example.com`, in `routes` and `APP_URL` in `wrangler.jsonc`: your domain. With
     no domain, delete the `routes` entry, set `workers_dev` to `true`, and use the `workers.dev`
     address Cloudflare gives you as `APP_URL`.
   - `REPLACE-WITH-YOUR-D1-DATABASE-ID`, in `wrangler.jsonc`: the ID of your own D1 database.
   - `REPLACE-WITH-YOUR-GOOGLE-CLIENT-ID`, in `wrangler.jsonc`: your own Google sign-in client's
     ID. You can leave sign-in out at first; the site works without it.
   - `you@example.com`, on the privacy page, `public/privacy.html`: your contact address.

   The tests in `test/deploy-config.test.js` and `test/static.test.js` check the domain and the
   contact address, so change them there too.
2. **Turn on Actions and Issues in your fork.** GitHub turns off workflows and issues in a new
   fork. Enable them on the fork's Actions tab and in its settings, or nothing deploys and the
   monthly check can't report.
3. **Add two GitHub repository secrets,** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then
   push to `main` to make the first deploy.
4. **Add two Worker secrets,** `SESSION_KEY` and, for Google sign-in, `GOOGLE_CLIENT_SECRET`, in
   the Cloudflare dashboard on the Worker the first deploy created.

From then on, a push to `main` runs the unit tests, applies any new database migrations, and
updates the Worker ([`deploy.yml`](.github/workflows/deploy.yml)). Pull requests only run the
tests and a secrets scan, with no Cloudflare access ([`verify.yml`](.github/workflows/verify.yml)).
On the 1st of each month, [`dictionary-check.yml`](.github/workflows/dictionary-check.yml) opens
an issue if the word data no longer matches the latest dictionary files.

In this repository, which holds no secrets, the deploy and monthly check skip themselves. A fork
has another name, so they run there.

## Licenses

The code is under the [Apache License 2.0](LICENSE). The kanji and word data in
`public/data.js` is under [CC BY-SA 4.0](LICENSE-DATA), because it draws on the EDRDG's JMdict
and KANJIDIC dictionary files. See [`NOTICE`](NOTICE) and the [credits page](public/credits.html)
for each source and its terms.
