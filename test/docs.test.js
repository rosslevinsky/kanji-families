// The README and the cookbook are followed by people new to the project, so a dead link, a
// missing script or an undated limit sends them the wrong way.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const DOCS = ['README.md', 'docs/COOKBOOK.md'];
const SCRIPTS = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
const DATED_SOURCE = /\]\(https:\/\/[^)]+\).*checked \d{4}-\d{2}-\d{2}/;
// A figure for a limit or a price: a dollar amount, "up to" a number, or a count of requests, rows,
// minutes or users.
const LIMIT_FIGURE = /\$\d|\b\d[\d,.]*\s*(?:million\s+)?(?:requests|rows|minutes|users)\b|\bup to \d/i;

const read = (doc) => readFileSync(join(ROOT, doc), 'utf8');

// Text outside fenced code blocks, so an example's contents aren't read as the guide's own claims.
const prose = (text) => text.replace(/^```[\s\S]*?^```/gm, '');

// GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens.
const slug = (heading) => heading.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-');

function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return '';
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

describe.each(DOCS)('%s', (doc) => {
  const text = read(doc);
  const links = [...prose(text).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);

  it('links only to files that exist', () => {
    const local = links.filter((l) => !/^(https?:|mailto:|#)/.test(l));
    expect(local.length).toBeGreaterThan(0);
    for (const link of local) {
      expect(existsSync(join(ROOT, dirname(doc), link.split('#')[0])), link).toBe(true);
    }
  });

  it('links only to headings that exist', () => {
    const anchors = new Set([...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));
    for (const link of links.filter((l) => l.startsWith('#'))) expect(anchors.has(link.slice(1)), link).toBe(true);
  });

  it('names only npm scripts that exist', () => {
    const named = [...text.matchAll(/npm run (?:-s )?([\w:-]+)/g)].map((m) => m[1]);
    for (const name of named) expect(Object.hasOwn(SCRIPTS, name), `npm run ${name}`).toBe(true);
  });
});

describe('the cookbook', () => {
  const text = read('docs/COOKBOOK.md');
  const limits = section(text, 'Free-plan limits');

  it('gives every limit and price a source and the date it was checked', () => {
    const rows = limits.split('\n').filter((l) => l.startsWith('|') && !/^\|\s*(Limit|-)/.test(l));
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect(row, row).toMatch(DATED_SOURCE);
  });

  it('keeps limit and price figures in the dated table', () => {
    const outside = prose(text.replace(limits, '')).split('\n').filter((l) => LIMIT_FIGURE.test(l));
    expect(outside).toEqual([]);
  });

  it('notices a limit stated outside the table', () => {
    expect(LIMIT_FIGURE.test('The free plan allows 100,000 requests a day.')).toBe(true);
    expect(LIMIT_FIGURE.test('About 2,000 minutes a month.')).toBe(true);
    expect(LIMIT_FIGURE.test('It costs $5.')).toBe(true);
    expect(LIMIT_FIGURE.test('Only test users can sign in, up to 100.')).toBe(true);
  });

  it('dates its note on the cf tool', () => {
    expect(section(text, 'Wrangler and the new `cf` tool')).toMatch(/checked \d{4}-\d{2}-\d{2}|As of \d{4}-\d{2}-\d{2}/);
  });
});
