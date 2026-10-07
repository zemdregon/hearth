import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel:false, workers:2, retries:0, timeout:30000,
  use:{baseURL:'http://localhost:5173',trace:'retain-on-failure',...devices['Desktop Chrome'],launchOptions:{executablePath:process.env.PLAYWRIGHT_MANAGED_BROWSER ? undefined : process.env.CHROMIUM_PATH || '/usr/bin/chromium',args:['--no-sandbox']}},
  webServer:[
    {command:'npm run dev -- --host 127.0.0.1',url:'http://localhost:5173',reuseExistingServer:!process.env.CI,timeout:60000},
    {command:'node scripts/start-e2e-api.mjs',url:'http://127.0.0.1:8787/api/health',reuseExistingServer:!process.env.CI,timeout:60000},
    {command:'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',url:'http://localhost:4173',reuseExistingServer:!process.env.CI,timeout:30000},
  ],
  reporter:[['list']],
});
