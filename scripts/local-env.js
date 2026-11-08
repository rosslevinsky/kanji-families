// Shared by the setup, database reset and browser-test scripts. Everything here is local: nothing
// needs a Cloudflare account.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..');
export const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');

export const generateSessionKey = () => randomBytes(32).toString('base64url');

export function devVarsFrom(example) {
  return example.replace(/^SESSION_KEY=.*$/m, `SESSION_KEY=${generateSessionKey()}`);
}

// Returns whether it created the file. An existing file is the developer's and is left alone.
export function ensureDevVars(target, examplePath) {
  if (existsSync(target)) return false;
  writeFileSync(target, devVarsFrom(readFileSync(examplePath, 'utf8')), { mode: 0o600 });
  return true;
}

// stdin is closed so wrangler never waits at a prompt.
export function applyLocalMigrations(persistTo) {
  const args = ['d1', 'migrations', 'apply', 'DB', '--local', ...(persistTo ? ['--persist-to', persistTo] : [])];
  const run = spawnSync(WRANGLER, args, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  if (run.status !== 0) {
    console.error('Could not apply the local database migrations.');
    process.exit(run.status || 1);
  }
}
