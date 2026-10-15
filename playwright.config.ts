import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:3000', ...devices['Desktop Chrome'] },
  webServer: { command: 'node dist-server/server/src/index.js', url: 'http://127.0.0.1:3000/api/health',
    env: { MODU2_MODE: 'mock', NODE_ENV: 'test' }, reuseExistingServer: true, timeout: 120_000 },
});
