import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const raw = readFileSync('wrangler.jsonc', 'utf8');
const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
const deploy = readFileSync('.github/workflows/deploy.yml', 'utf8');
const dictionary = readFileSync('.github/workflows/dictionary-check.yml', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const code = (text) => text.replace(/^\s*#.*$/gm, '');

describe('wrangler.jsonc', () => {
  it('serves only from the custom domain', () => {
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toEqual([{ pattern: 'your-domain.example.com', custom_domain: true }]);
    expect(config.vars.APP_URL).toBe('https://your-domain.example.com');
  });
  it('stores no Worker logs, which the privacy page does not list', () => {
    expect(config.observability).toEqual({ enabled: false });
  });
  it('turns on no fake login and holds no secrets', () => {
    expect(raw).not.toContain('DEV_LOGIN');
    expect(raw).not.toContain('SESSION_KEY');
    expect(raw).not.toContain('GOOGLE_CLIENT_SECRET');
  });
  it('names a real database and sign-in client, or the placeholders a fork fills in', () => {
    expect(config.vars.GOOGLE_CLIENT_ID).toMatch(/\.apps\.googleusercontent\.com$/);
    const id = config.d1_databases[0].database_id;
    if (id !== 'REPLACE-WITH-YOUR-D1-DATABASE-ID') {
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(id).not.toBe('00000000-0000-0000-0000-000000000000');
    }
  });
});

describe('local servers', () => {
  it('keep their own address despite the production route', () => {
    expect(pkg.scripts.dev).toContain('--infer-origin-from-routes=false');
    expect(readFileSync('scripts/dev-e2e.js', 'utf8')).toContain("'--infer-origin-from-routes=false'");
  });
});

describe('deploy.yml', () => {
  it('runs only from main or by hand, with read-only access', () => {
    expect(code(deploy)).not.toMatch(/pull_request/);
    expect(deploy).toMatch(/branches: \[main\]/);
    expect(deploy).toMatch(/permissions:\n {2}contents: read/);
  });
  it('tests, then migrates, then deploys', () => {
    const order = ['run: npm ci', 'run: npm test', 'run: npm run db:migrate:prod', 'run: npm run deploy'].map((s) => deploy.indexOf(s));
    expect(order.every((n) => n >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(pkg.scripts['db:migrate:prod']).toContain('--remote');
  });
  it('gives the token only to the two steps that need it', () => {
    expect(deploy.match(/secrets\.CLOUDFLARE_API_TOKEN/g)).toHaveLength(2);
    expect(deploy.indexOf('secrets.CLOUDFLARE_API_TOKEN')).toBeGreaterThan(deploy.indexOf('run: npm test'));
  });
  it('pins every action to a commit', () => {
    for (const text of [deploy, dictionary]) {
      for (const [, ref] of text.matchAll(/uses: \S+@(\S+)/g)) expect(ref).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe('dictionary-check.yml', () => {
  it('runs monthly with no Cloudflare credentials and no write access to code', () => {
    expect(dictionary).toMatch(/schedule:\n\s+- cron: '\d+ \d+ 1 \* \*'/);
    expect(dictionary).not.toContain('CLOUDFLARE');
    expect(dictionary).not.toContain('contents: write');
  });
  it('fails the run on any exit but a match or a difference', () => {
    expect(dictionary).toContain('if [ "$code" != 1 ]; then exit 1; fi');
  });
});

describe('verify.yml', () => {
  const verify = readFileSync('.github/workflows/verify.yml', 'utf8');
  const job = (name) => verify.split(new RegExp(`^ {2}${name}:$`, 'm'))[1].split(/^ {2}\w/m)[0];

  it('tests pull requests and pushes to main, and names no repository', () => {
    expect(verify).toMatch(/^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n/m);
    expect(code(verify)).not.toMatch(/github\.repository [!=]=/);
  });
  it('skips the tests on a merge only when this tree already passed, and the gate holds that', () => {
    expect(job('tested')).toMatch(/if: github\.event_name == 'push'/);
    for (const name of ['test', 'browsers']) {
      expect(job(name)).toMatch(/needs: tested\n {4}if: always\(\) && needs\.tested\.outputs\.already != 'true'/);
    }
    expect(job('test')).toContain('name=tested-tree-$t');
    expect(job('tested')).toMatch(/uses: \.\/\.github\/actions\/kit\/ci-skip\n {8}with:\n {10}workflow: verify\.yml\n {10}receipt: tested-tree\n/);
    expect(job('gitleaks')).not.toContain('needs:');
    expect(job('gitleaks')).toMatch(/uses: \.\/\.github\/actions\/kit\/gitleaks\n {8}with:\n {10}mode: history\n/);
    const gate = job('gate');
    expect(gate).toMatch(/needs: \[tested, test, browsers, gitleaks\]\n {4}if: always\(\)/);
    expect(gate).toContain('[ "${{ needs.test.result }}" = "$want" ] || exit 1');
    expect(gate).toContain('[ "${{ needs.gitleaks.result }}" = "success" ] || exit 1');
  });
  it('runs the other browsers only in a public repo, where minutes are free', () => {
    expect(job('browsers')).toContain('!github.event.repository.private');
    expect(job('browsers')).toContain('run: npm run test:e2e:browsers');
    expect(pkg.scripts['test:e2e']).not.toMatch(/firefox|webkit/);
    expect(pkg.scripts['test:e2e:browsers']).toMatch(/firefox/);
    expect(pkg.scripts['test:e2e:browsers']).toMatch(/webkit/);
  });
  it('pins every action to a commit', () => {
    for (const [, ref] of verify.matchAll(/uses: \S+@(\S+)/g)) expect(ref).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('a repository without the secrets', () => {
  // Its only job holds the guard, so rosslevinsky/kanji-families never tries to deploy or file issues.
  it.each([['deploy.yml', deploy], ['dictionary-check.yml', dictionary]])('%s skips itself there', (_, text) => {
    const jobs = code(text).split(/^jobs:$/m)[1];
    expect(jobs.match(/^ {2}\w[\w-]*:$/gm)).toHaveLength(1);
    expect(jobs).toMatch(/^ {2}\w[\w-]*:\n(?:\s*\n)* {4}if: github\.repository != 'rosslevinsky\/kanji-families'\n/m);
  });
});
