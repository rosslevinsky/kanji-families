# Changelog

Each release is named for the month it ships in: `vYEAR.MONTH.N`, where N counts from 0 within
the month. So `v2026.11.0` is that month's first release, and `v2026.11.1` its second.

Each section says what someone using the site, or running their own copy, would notice. The
newest release is first.

## [2026.11.1] - 2026-11-12

- Works offline after the first visit: the app opens and drills with no connection, and
  syncs once you're back online.
- A review test mixes its questions, and draws new kanji from different families, so
  questions with the same reading no longer come in a row.
- Practice lists the quiz types in even rows, each with what it asks, and offers "One family"
  for drilling a single sound family.
- During a test, the intro and the quiz list step aside, so on a phone the question and its
  answers fit on screen. "Change quiz type" brings the list back. On a wide screen the four
  answers sit in one row.
- CI's already-tested skip and its secret scan run as local actions in `.github/actions/kit/`,
  and each checks its own files against `kit.lock` before it runs.

## [2026.11.0] - 2026-11-08

- The study guide and drills for kanji families, which work without an account and keep
  progress in the browser.
- Optional Google sign-in, which keeps progress on the server and in step across devices.
- Backup download and restore, and a "Delete my data" button for signed-in users.
- An app icon and install support, so the site can sit on a phone's home screen.
- A theme switch: match the device, or always light or always dark.
- Credits for the dictionary and stroke data, and a privacy page.
- The browser tests also run in Firefox and in WebKit, Safari's engine.
