import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage is kept between tests in a file, so each starts empty.
beforeEach(() => env.DB.batch([env.DB.prepare('DELETE FROM progress'), env.DB.prepare('DELETE FROM deletion_markers')]));
