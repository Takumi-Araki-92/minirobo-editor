import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser-tests",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:3117",
    browserName: "chromium",
    channel: "msedge",
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: "node server.js",
    url: "http://127.0.0.1:3117",
    env: { PORT: "3117", HISTORY_MODE: "off" },
    reuseExistingServer: false,
  },
});
