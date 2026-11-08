// First-run setup for local development. Needs no Cloudflare account or secrets.
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`Node 22 or later is required; this is ${process.version}.`);
  process.exit(1);
}

// Loaded after the check, so an old Node gets the message above rather than an import error.
const { join } = await import('node:path');
const { applyLocalMigrations, ensureDevVars, ROOT } = await import('./local-env.js');

const created = ensureDevVars(join(ROOT, '.dev.vars'), join(ROOT, '.dev.vars.example'));
console.log(created ? 'Created .dev.vars with a new local key.' : 'Keeping the existing .dev.vars.');
applyLocalMigrations();
console.log('Setup complete. Run "npm run dev", then open http://localhost:8787');
