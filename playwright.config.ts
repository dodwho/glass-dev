import { defineConfig } from "@playwright/test";
import { port } from "./e2e/support/config";

/* Browser tests (e2e/), run against a built app (E2E_BUILD_DIR, default build/) served with the DHIS2 instance
   in .env.local. `yarn e2e` only reads; `yarn e2e:dev` also uploads and deletes test files, on DEV only. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { writesAllowed } = require("./e2e/env");

const buildDir = process.env.E2E_BUILD_DIR ?? "build";

export default defineConfig({
    testDir: "e2e",
    outputDir: "e2e/.results",
    snapshotPathTemplate: "e2e/.snapshots/{arg}{ext}",
    // One DHIS2 user and one test country: tests run one at a time, in file order.
    workers: 1,
    fullyParallel: false,
    timeout: 30 * 60_000,
    expect: { timeout: 60_000 },
    reporter: [["list"], ["html", { outputFolder: "e2e/.report", open: "never" }]],
    use: {
        baseURL: `http://localhost:${port}/`,
        channel: process.env.E2E_BROWSER_CHANNEL ?? "msedge",
        viewport: { width: 1440, height: 1000 },
        locale: "en-GB",
        // GLASS users work in every time zone; dates are the part most sensitive to it.
        timezoneId: process.env.E2E_TIMEZONE ?? "Europe/Zurich",
        acceptDownloads: true,
        // Clicks and typing wait at most 2 minutes, so a missing button fails fast instead of at the test time-out.
        actionTimeout: 120_000,
        // A trace records every step with screenshots and network calls: `npx playwright show-trace <zip>`.
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    webServer: {
        command: `"${process.execPath}" e2e/server.js "${buildDir}" ${port}`,
        url: `http://localhost:${port}/manifest.webapp`,
        reuseExistingServer: false,
        stdout: "pipe",
    },
    projects: [
        { name: "pages", testMatch: "pages.spec.ts" },
        ...(writesAllowed() ? [{ name: "uploads", testMatch: "*.upload.spec.ts" }] : []),
    ],
});
