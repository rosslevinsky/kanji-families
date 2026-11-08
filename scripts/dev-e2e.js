// The server for browser tests: its own throwaway database and settings, so tests never touch a
// developer's data or .dev.vars. Both are made new on each run.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyLocalMigrations, generateSessionKey, ROOT, WRANGLER } from './local-env.js';

const PORT = '8799';
const DIR = join(ROOT, '.wrangler', 'e2e');
const VARS = join(DIR, 'dev.vars');

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
writeFileSync(VARS, `APP_URL=http://localhost:${PORT}\nSESSION_KEY=${generateSessionKey()}\nDEV_LOGIN=1\n`, { mode: 0o600 });
applyLocalMigrations(DIR);

const server = spawn(WRANGLER, ['dev', '--port', PORT, '--infer-origin-from-routes=false', '--persist-to', DIR, '--env-file', VARS], { cwd: ROOT, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 1));
