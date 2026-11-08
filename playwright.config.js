import { defineConfig } from '@playwright/test';

// A port of its own (see dev:e2e in package.json), so the tests never run against an open dev server.
const BASE_URL = 'http://localhost:8799';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: { baseURL: BASE_URL, trace: 'retain-on-failure' },
  // desktop and mobile run everywhere, in Chromium. The others run in test:e2e:browsers, which only
  // the public repo's CI runs, since Actions minutes are free there.
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 720 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop-firefox', use: { browserName: 'firefox', viewport: { width: 1280, height: 720 } } },
    { name: 'desktop-webkit', use: { browserName: 'webkit', viewport: { width: 1280, height: 720 } } },
    { name: 'mobile-webkit', use: { browserName: 'webkit', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'npm run dev:e2e',
    url: BASE_URL,
    reuseExistingServer: false,
    env: { WRANGLER_SEND_METRICS: 'false' },
  },
});
