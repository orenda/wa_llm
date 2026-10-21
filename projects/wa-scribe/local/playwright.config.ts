import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../tests/local-browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { browserName: "chromium", headless: true, acceptDownloads: true, viewport: { width: 1_000, height: 800 } },
});
