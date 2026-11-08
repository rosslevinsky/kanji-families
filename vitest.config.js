import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// These run inside the Workers runtime against a local D1 database. The rest run in Node.
const WORKER_TESTS = ['test/progress.test.js', 'test/deletion.test.js', 'test/dev-login.test.js', 'test/schema.test.js', 'test/auth.test.js'];

export default defineConfig(async () => {
  const migrations = await readD1Migrations('migrations');
  return {
    test: {
      projects: [
        { test: { name: 'node', include: ['test/*.test.js'], exclude: WORKER_TESTS } },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: {
                // Fixed test values, which take priority over a developer's .dev.vars.
                bindings: {
                  APP_URL: 'http://app.test',
                  SESSION_KEY: 'test-only-session-key-not-a-real-secret',
                  DEV_LOGIN: '1',
                  TEST_MIGRATIONS: migrations,
                },
              },
            }),
          ],
          test: { name: 'worker', include: WORKER_TESTS, setupFiles: ['test/helpers/apply-migrations.js'] },
        },
      ],
    },
  };
});
