// Returns the local database to empty. It only touches the local copy of the database. Stop
// "npm run dev" first: a running server keeps the old database open.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { applyLocalMigrations, ROOT } from './local-env.js';

rmSync(join(ROOT, '.wrangler', 'state', 'v3', 'd1'), { recursive: true, force: true });
applyLocalMigrations();
console.log('The local database is empty.');
