/* Read-only tour of every GLASS page, reached through the side menu as a user would. Each page must load without
   an uncaught error, and must look the same as in a reference build: record the reference screenshots with
   `E2E_BUILD_DIR=<reference build> yarn e2e --update-snapshots`, then run `yarn e2e` on the new build.
   Writes are refused inside the browser, so the tour never changes DHIS2, whatever the server allows. */
import { expect, Page, test } from "@playwright/test";
import { clickMenuItem, selectCountry, waitForIdle } from "./support/app";

// Angola has data in AMR, AMR - Individual and AMC on DEV, so those pages show real tables; the Republic of Korea is
// enrolled in every module, so it covers the others. EGASP has no "Current Data Submission" menu item.
const countries = { Angola: "Angola", Korea: "Republic of Korea" };
const moduleItems = [
    "Current Data Submission",
    "Reports",
    "Data File History",
    "Data Submissions History",
    "Country Information",
];
const submissionTabs = ["Overview", "Questionnaires", "Datasets", "Validation Report"];
const tour = [
    { module: "AMR", country: countries.Angola, items: moduleItems },
    { module: "AMR - Individual", country: countries.Angola, items: moduleItems },
    { module: "AMC", country: countries.Angola, items: moduleItems },
    { module: "AMR - Fungal", country: countries.Korea, items: moduleItems },
    { module: "EGASP", country: countries.Korea, items: moduleItems.slice(1) },
    { module: "EAR", country: countries.Korea, items: ["Signals", "Draft a new signal"] },
];
const visits = tour.flatMap(({ module, country, items }) => items.map(item => ({ country, module, item })));

const slug = (...parts: string[]) =>
    parts
        .join("-")
        .replace(/[^a-z0-9]+/gi, "-")
        .toLowerCase();

async function readOnly(page: Page): Promise<string[]> {
    const pageErrors: string[] = [];
    page.on("pageerror", error => {
        // Dashboard iframes are redirected to DHIS2's own address by the local proxy (config/dhis2-proxy.js), so
        // reading into them is cross-origin here; inside DHIS2 the app and its iframes share one origin.
        if (!/from accessing a cross-origin frame/.test(String(error))) pageErrors.push(String(error));
    });
    await page.route("**/dhis2/**", route =>
        ["GET", "HEAD", "OPTIONS"].includes(route.request().method())
            ? route.continue()
            : route.fulfill({ status: 403, json: { status: "ERROR", message: "Blocked by the read-only page tour" } })
    );
    return pageErrors;
}

async function expectSameLook(page: Page, name: string) {
    // Some parts render after their data arrives without showing a spinner: wait until the network is quiet too.
    await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => undefined);
    await waitForIdle(page);
    // Dashboards in the Reports pages are DHIS2's own iframes: they are not part of this app, so they are masked.
    await expect(page).toHaveScreenshot(`${name}.png`, {
        fullPage: true,
        mask: [page.locator("iframe")],
        maxDiffPixelRatio: 0.002,
    });
}

test.describe("Pages", () => {
    for (const { country, module, item } of visits) {
        test(`${module} › ${item}`, async ({ page }) => {
            const pageErrors = await readOnly(page);
            await selectCountry(page, country);
            await clickMenuItem(page, module, item);
            await expectSameLook(page, slug(module, item));

            if (item === "Current Data Submission") {
                for (const tab of submissionTabs.slice(1)) {
                    await page.getByRole("button", { name: tab, exact: true }).click();
                    await expectSameLook(page, slug(module, item, tab));
                }
            }
            expect(pageErrors, "uncaught errors in the page").toEqual([]);
        });
    }

    for (const [name, hash] of [
        ["User profile", "#/user-profile"],
        ["User settings", "#/user-settings"],
    ] as const) {
        test(name, async ({ page }) => {
            const pageErrors = await readOnly(page);
            await selectCountry(page, countries.Angola);
            await page.goto(hash);
            await expectSameLook(page, slug(name));
            expect(pageErrors, "uncaught errors in the page").toEqual([]);
        });
    }
});
