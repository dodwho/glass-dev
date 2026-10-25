/* Drives the GLASS screens as a user would: from the home page of the test country, through the module card,
   to the datasets tab and the upload page. Pages are always reached by clicking, because a page opened directly
   by URL can check access before the user's access has loaded. */
import path from "path";
import { expect, Page } from "@playwright/test";
import { ModuleKey, modules, testYear } from "./config";
import { get, getUploads, isTestUpload } from "./dhis2";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const longWait = { timeout: 10 * 60_000 };

/** Waits until no spinner or progress bar is showing (closed loading overlays keep a hidden one in the page). */
export async function waitForIdle(page: Page, timeout = 120_000) {
    await expect(page.locator('[role="progressbar"]').filter({ visible: true })).toHaveCount(0, { timeout });
}

/**
 * Opens the home page and picks the country in the header, as a user does. Unlike a link with ?orgUnit=, this changes
 * the country once, after the start-up country's modules have loaded, so the side menu cannot keep stale modules.
 */
export async function selectCountry(page: Page, countryName: string) {
    await page.goto("#/");
    await waitForIdle(page);
    await page.locator('header [aria-haspopup="listbox"]').click();
    await page.getByRole("option", { name: countryName, exact: true }).click();
    await waitForIdle(page);
}

/** Opens the module's current data submission from the side menu, as users do (home cards are not shown for every module). */
export async function openSubmission(page: Page, module: ModuleKey) {
    await page.goto(`#/?orgUnit=${modules[module].country.id}`);
    await waitForIdle(page);
    if (module === "EGASP") {
        // EGASP has no "Current Data Submission" menu item or home card: users open the year from its history.
        await clickMenuItem(page, modules[module].name, "Data Submissions History");
        await page
            .getByRole("row")
            .filter({ hasText: new RegExp(`^${testYear}`) })
            .first()
            .click();
    } else {
        await clickMenuItem(page, modules[module].name, "Current Data Submission");
    }
    await expect(page.getByText(new RegExp(`${escape(modules[module].name)}.*${testYear}`)).first()).toBeVisible();
    await waitForIdle(page);
}

/**
 * Opens the module's group in the side menu and clicks one of its items. The menu can re-render while the app is
 * still loading, which closes the group again, so this retries until the click lands. The menu can also keep the
 * modules of the country the app started with (BACKLOG glass-dev issue (n)); then the page is reloaded.
 */
export async function clickMenuItem(page: Page, groupName: string, item: string) {
    const group = page.locator(`[data-current-group-name="${groupName}"]`);
    const menuItem = page.locator(`[data-group-name="${groupName}"]`).getByText(item, { exact: true });
    await expect(async () => {
        if ((await group.count()) === 0) {
            await page.reload();
            await waitForIdle(page);
        }
        if (!(await menuItem.isVisible())) await group.click({ timeout: 5_000 });
        await menuItem.click({ timeout: 5_000 });
    }).toPass({ timeout: 120_000 });
}

export async function openDatasets(page: Page, module: ModuleKey) {
    await openSubmission(page, module);
    await page
        .getByRole("button", { name: /Upload\/Delete datasets/i })
        .first()
        .click();
    // The add button (or the notice that replaces it) only renders once the uploads and the status have loaded.
    const loaded = addNewDatasets(page).or(page.getByText(/You can upload (data from )?only one/));
    await expect(loaded.first()).toBeVisible({ timeout: 120_000 });
    await waitForIdle(page);
}

// A MUI button rendered as a router link: its role depends on the MUI version, so accept either.
const addNewDatasets = (page: Page) =>
    page.getByRole("button", { name: "Add New Datasets" }).or(page.getByRole("link", { name: "Add New Datasets" }));

type UploadOptions = { primary?: string; secondary?: string; fileType?: string; batch?: string };

async function openUploadPage(page: Page, module: ModuleKey, fileType?: string) {
    await openDatasets(page, module);
    await addNewDatasets(page).click();
    await waitForIdle(page);
    if (fileType) await choose(page, fileType);
}

/** Picks an option in the page's drop-down (file type or batch): their labels are not linked to them. */
export async function choose(page: Page, option: string) {
    // The header's country selector is a drop-down too: skip it.
    await page.locator('[aria-haspopup="listbox"]:not(header [aria-haspopup="listbox"])').first().click();
    await page.getByRole("option", { name: option, exact: true }).click();
}

/** Downloads the module's empty template from the upload page, as a user would; returns where it was saved. */
export async function downloadTemplate(page: Page, module: ModuleKey, fileType?: string): Promise<string> {
    await openUploadPage(page, module, fileType);
    const download = page.waitForEvent("download", { timeout: 300_000 });
    await page.getByRole("button", { name: "Download empty template" }).click();
    const file = path.join(
        __dirname,
        "..",
        ".fixtures",
        `template_${module}_${fileType ?? "data"}.xlsx`.replace(/ /g, "_")
    );
    await (await download).saveAs(file);
    return file;
}

/** Opens the upload page, attaches the files and waits for the file checks to finish. */
export async function attachFiles(page: Page, module: ModuleKey, options: UploadOptions) {
    await openUploadPage(page, module, options.fileType);
    if (options.batch) await choose(page, options.batch);
    const inputs = page.locator('input[type="file"]');
    if (options.primary) await inputs.nth(0).setInputFiles(options.primary);
    if (options.secondary) await inputs.nth(options.primary ? 1 : 0).setInputFiles(options.secondary);
    await waitForIdle(page, longWait.timeout);
}

export const continueButton = (page: Page) => page.getByRole("button", { name: "Continue" });

/** Test uploads that still exist in DHIS2 and are not queued for the async-deletions server. */
async function uploadsToDelete(module: ModuleKey) {
    const queued = new Set((await get<{ uploadId: string }[]>("dataStore/glass/async-deletions")).map(i => i.uploadId));
    return (await getUploads(module)).filter(upload => isTestUpload(upload) && !queued.has(upload.id));
}

/**
 * Deletes every test upload of the module through the datasets tab, as a user would; large ones are only queued
 * for the async-deletions server. DHIS2 says what is left, because the table fills its rows after it appears.
 * Rows are picked by file name: the AMR - Individual tab also lists the AMR aggregate SAMPLE files it shares.
 */
export async function deleteTestUploads(page: Page, module: ModuleKey) {
    for (let round = 0; round < 10; round++) {
        const remaining = await uploadsToDelete(module);
        const [next] = remaining;
        if (!next) return;
        await openDatasets(page, module);
        const row = page
            .locator("tr")
            .filter({ has: page.getByTitle(next.values.fileName ?? "", { exact: true }) })
            .filter({ hasNotText: /Marked to be deleted/i })
            .first();
        // Deleting an upload can delete its pair too (an AMR RIS takes its SAMPLE along): if DHIS2 drops this one
        // while its row is gone from the table, there is nothing left to click.
        const stillListed = async () => (await uploadsToDelete(module)).some(upload => upload.id === next.id);
        await expect
            .poll(async () => (await row.isVisible()) || !(await stillListed()), { timeout: 120_000 })
            .toBe(true);
        if (!(await row.isVisible())) continue;
        // Delete is the first icon in a row (validated rows also have Complete and an import-summary arrow).
        await row.locator("svg").first().click();
        const dialog = page.getByRole("dialog");
        // The reason field has no id, so its label is not linked to it.
        await dialog.locator("input, textarea").first().fill("Automated browser test clean-up");
        await dialog.getByRole("button", { name: /^ok$/i }).click();
        await expect(dialog).toBeHidden(longWait);
        // The dialog closes before a deletion in the browser has finished: wait until DHIS2 shows it done (or queued).
        await expect.poll(async () => (await uploadsToDelete(module)).length, longWait).toBeLessThan(remaining.length);
    }
    throw new Error(`Test uploads in ${modules[module].name} were still listed after 10 deletions`);
}
