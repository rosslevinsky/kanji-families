import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devVarsFrom, ensureDevVars } from '../scripts/local-env.js';

const ROOT = join(import.meta.dirname, '..', 'public');
const files = readdirSync(ROOT, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name));
const textFiles = files.filter((f) => !f.endsWith('.png'));
const PAGES = ['index.html', 'credits.html', 'privacy.html'];
const page = (name) => readFileSync(join(ROOT, name), 'utf8');
// A PNG's width and height sit at bytes 16 to 24 of its header.
function pngSize(file) {
  const data = readFileSync(file);
  expect(data.subarray(1, 4).toString()).toBe('PNG');
  return `${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`;
}

describe('served files', () => {
  it('include the app', () => {
    const names = files.map((f) => f.slice(ROOT.length + 1));
    expect(names).toEqual(expect.arrayContaining(['index.html', 'app.js', 'data.js', 'merge.js', 'sync.js', 'styles.css', 'credits.html', 'privacy.html',
      'theme.js', 'manifest.webmanifest', 'icons/favicon-32.png', 'icons/apple-touch-icon.png']));
  });

  it.each(textFiles.map((f) => [f.slice(ROOT.length + 1), f]))('%s has no leftovers from the artifact', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/window\s*\.\s*claude/);
    expect(text).not.toMatch(/claude:viewport/);
    expect(text).not.toMatch(/PROJECT\s+NOTES/);
    // The site's public contact is the only email address a page may carry.
    expect(text.replaceAll('you@example.com', '')).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  });
});

describe('credits page', () => {
  it('names each source and links the license terms', () => {
    const text = readFileSync(join(ROOT, 'credits.html'), 'utf8');
    for (const s of ['JMdict', 'KANJIDIC', 'KanjiVG', 'Electronic Dictionary Research and Development Group',
      'https://www.edrdg.org/edrdg/licence.html', 'https://creativecommons.org/licenses/by-sa/4.0/']) {
      expect(text).toContain(s);
    }
  });

  it('states the monthly check and does not claim conformance', () => {
    const text = readFileSync(join(ROOT, 'credits.html'), 'utf8');
    expect(text).toContain('Each month an automatic check');
    expect(text).not.toContain('conformance');
  });

  it('is linked from the app', () => {
    expect(readFileSync(join(ROOT, 'index.html'), 'utf8')).toContain('href="/credits"');
  });
});

describe('privacy page', () => {
  it('gives a contact address', () => {
    expect(readFileSync(join(ROOT, 'privacy.html'), 'utf8')).toContain('mailto:you@example.com');
  });

  it('is linked from the app', () => {
    expect(readFileSync(join(ROOT, 'index.html'), 'utf8')).toContain('href="/privacy"');
  });

  it('names what is stored and where, and claims no compliance', () => {
    const text = readFileSync(join(ROOT, 'privacy.html'), 'utf8');
    for (const s of ['openid', 'local storage', 'Google Fonts', 'Cloudflare', 'Delete my data', '90 days', 'Download backup']) expect(text).toContain(s);
    expect(text).not.toMatch(/GDPR|CCPA|complian/i);
  });

  it('states how long Cloudflare can restore deleted data from', () => {
    const text = readFileSync(join(ROOT, 'privacy.html'), 'utf8');
    expect(text).toMatch(/any point in the last 7 days/);
    expect(text).toMatch(/within 7 days/);
    expect(text).not.toMatch(/limited time/);
  });
});

describe('security headers', () => {
  const headers = readFileSync(join(ROOT, '_headers'), 'utf8');
  const policy = /Content-Security-Policy: (.*)/.exec(headers)[1];
  const directive = (name) => (policy.split(';').map((d) => d.trim().split(/\s+/)).find(([n]) => n === name) || []).slice(1);

  it('apply to every static file', () => {
    expect(headers.split('\n')[0].trim()).toBe('/*');
    expect(headers).toContain('X-Content-Type-Options: nosniff');
  });

  it('start from nothing allowed and permit scripts only from this site', () => {
    expect(directive('default-src')).toEqual(["'none'"]);
    expect(directive('script-src')).toEqual(["'self'"]);
    expect(directive('frame-ancestors')).toEqual(["'none'"]);
    expect(directive('base-uri')).toEqual(["'none'"]);
    expect(policy).not.toContain('unsafe-eval');
  });

  it('allow the app manifest from this site only', () => {
    expect(directive('manifest-src')).toEqual(["'self'"]);
    expect(directive('img-src')).toEqual(["'self'"]);
  });

  it('allow the fonts the page uses', () => {
    expect(directive('style-src')).toContain('https://fonts.googleapis.com');
    expect(directive('font-src')).toEqual(['https://fonts.gstatic.com']);
  });

  it.each(['index.html', 'credits.html', 'privacy.html'])('%s has no inline scripts or handlers, which the policy would block', (name) => {
    const html = readFileSync(join(ROOT, name), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<style[\s>]/i);
  });
});

describe('installing the app', () => {
  const manifest = JSON.parse(page('manifest.webmanifest'));

  it('names the app and opens it full screen at the start page', () => {
    expect(manifest.name).toBe('Kanji Family Drills');
    expect(manifest.short_name.length).toBeLessThanOrEqual(15);
    expect(manifest).toMatchObject({ start_url: '/', scope: '/', id: '/', display: 'standalone' });
  });

  it('lists icons that exist at the sizes it claims, one of them maskable', () => {
    for (const icon of manifest.icons) expect(pngSize(join(ROOT, icon.src)), icon.src).toBe(icon.sizes);
    expect(manifest.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.filter((i) => i.purpose === 'maskable')).toHaveLength(1);
  });

  it.each(PAGES)('%s links the manifest and icons', (name) => {
    const html = page(name);
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<link rel="icon" href="/icons/favicon-32.png" sizes="32x32" type="image/png">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">');
    expect(pngSize(join(ROOT, 'icons/favicon-32.png'))).toBe('32x32');
    expect(pngSize(join(ROOT, 'icons/apple-touch-icon.png'))).toBe('180x180');
  });
});

describe('theme', () => {
  it.each(PAGES)('%s sets the saved theme before the styles load, so it never flashes', (name) => {
    const html = page(name);
    const theme = html.indexOf('<script src="/theme.js"></script>');
    expect(theme).toBeGreaterThan(0);
    expect(theme).toBeLessThan(html.indexOf('</head>'));
    expect(theme).toBeLessThan(html.indexOf('rel="stylesheet"'));
  });

  it('offers device, light and dark on the main page', () => {
    const choices = [...page('index.html').matchAll(/data-theme-choice="(\w+)"/g)].map((m) => m[1]);
    expect(choices).toEqual(['auto', 'light', 'dark']);
  });

  it('styles both forced themes and the device setting', () => {
    const css = page('styles.css');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toContain(':root[data-theme="dark"]');
  });
});

describe('local settings', () => {
  it('generates a signing key and turns on the fake login', () => {
    const text = devVarsFrom(readFileSync(join(ROOT, '..', '.dev.vars.example'), 'utf8'));
    const key = /^SESSION_KEY=(.*)$/m.exec(text)[1];
    expect(key.length).toBeGreaterThanOrEqual(32);
    expect(key).not.toBe(/^SESSION_KEY=(.*)$/m.exec(devVarsFrom('SESSION_KEY=\n'))[1]);
    expect(text).toMatch(/^DEV_LOGIN=1$/m);
    expect(text).toMatch(/^APP_URL=http:\/\/localhost:8787$/m);
  });

  it('does not overwrite an existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devvars-'));
    try {
      const example = join(dir, 'example'), target = join(dir, '.dev.vars');
      writeFileSync(example, 'SESSION_KEY=\nDEV_LOGIN=1\n');
      expect(ensureDevVars(target, example)).toBe(true);
      expect(readFileSync(target, 'utf8')).toMatch(/SESSION_KEY=.{32,}/);
      writeFileSync(target, 'mine');
      expect(ensureDevVars(target, example)).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('mine');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
