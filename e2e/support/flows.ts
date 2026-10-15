/* Steps shared by the upload specs. */
import { expect, Page, test, TestInfo } from "@playwright/test";
import { expectRecordsMatchFile } from "./accuracy";
import { attachFiles, continueButton, deleteTestUploads, waitForIdle } from "./app";
import { ModuleKey, modules } from "./config";
import { get, getTestUploadIds, takeSnapshot } from "./dhis2";
import { risIndividualFungalFile } from "./fixtures";
import { expectGolden } from "./golden";
import { runServerCycle } from "./servers";

const tenMinutes = { timeout: 10 * 60_000 };

/** Removes test uploads left by an earlier, interrupted run, then requires the test country and year to be empty. */
export async function startFromEmpty(page: Page, module: ModuleKey, testInfo: TestInfo) {
    await deleteTestUploads(page, module);
    const testUploads = await getTestUploadIds();
    const queued = await get<{ uploadId: string }[]>("dataStore/glass/async-deletions");
    if (queued.some(item => testUploads.has(item.uploadId))) await runServerCycle("deletions", testInfo);
    await expectEmpty(module);
}

export async function expectEmpty(module: ModuleKey) {
    const snapshot = await takeSnapshot(module);
    const left = Object.entries(snapshot).filter(([, lines]) => lines.length > 0);
    expect(left, `${modules[module].name}: data left for the test country and year`).toEqual([]);
}

/** Lists the blocking errors shown on the consistency checks step as "error (count)". */
async function blockingErrors(page: Page): Promise<string[]> {
    const table = page
        .locator("div")
        .filter({ has: page.getByRole("heading", { name: "Blocking Errors" }) })
        .last();
    if ((await table.count()) === 0) return [];
    return table.locator("tbody tr").evaluateAll(rows =>
        rows.map(row => {
            const cells = [...row.querySelectorAll("td")].map(cell => cell.textContent?.trim() ?? "");
            return `${cells[0]} (${cells[1]})`;
        })
    );
}

/**
 * Imports a file small enough for the browser and stops at the summary, once the data is in DHIS2; returns the
 * blocking errors shown instead, if any. It does not click the summary's final Continue: that marks the upload
 * complete, which for AMC and EGASP completes the data submission and messages the module's user groups.
 */
export async function importInBrowser(page: Page): Promise<string[]> {
    await continueButton(page).click();
    await expect(page.getByText("These Consistency Checks ensure that incorrect data is not imported.")).toBeVisible(
        tenMinutes
    );
    await waitForIdle(page, tenMinutes.timeout);
    const errors = await blockingErrors(page);
    if (errors.length > 0) return errors;

    await continueButton(page).click();
    await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible(tenMinutes);
    return [];
}

/** Clicks Continue for a file too large to import in the browser: it is queued for the async-uploads server. */
export async function queueForServer(page: Page) {
    await expect(continueButton(page)).toBeEnabled(tenMinutes);
    await continueButton(page).click();
    await expect(page.getByText("File marked to be uploaded asynchronously")).toBeVisible(tenMinutes);
}

/** The full set of tests for AMR - Individual and AMR - Fungal, which share one program and one upload flow. */
export function describeRisIndividualFungal(module: "AMR_INDIVIDUAL" | "AMR_FUNGAL") {
    const name = module === "AMR_INDIVIDUAL" ? "amr-individual" : "amr-fungal";
    const fileType = module === "AMR_INDIVIDUAL" ? "RIS Individual" : "RIS Fungal";

    test.describe.serial(modules[module].name, () => {
        test("starts from an empty test country and year", async ({ page }, testInfo) => {
            await startFromEmpty(page, module, testInfo);
        });

        test("rejects a file with blocking errors and imports nothing", async ({ page }) => {
            const file = risIndividualFungalFile(module, "RIS_with_errors", 40, 3);
            await attachFiles(
                page,
                module,
                module === "AMR_INDIVIDUAL" ? { primary: file, fileType } : { primary: file }
            );
            const errors = await importInBrowser(page);
            expect(errors.length, "blocking errors shown").toBeGreaterThan(0);
            const snapshot = await takeSnapshot(module);
            expect(snapshot.records, "records imported from a rejected file").toEqual([]);
            await deleteTestUploads(page, module);
            await expectEmpty(module);
        });

        test("imports a small file in the browser exactly as written", async ({ page }, testInfo) => {
            const file = risIndividualFungalFile(module, "RIS_small", 150);
            await attachFiles(
                page,
                module,
                module === "AMR_INDIVIDUAL" ? { primary: file, fileType } : { primary: file }
            );
            expect(await importInBrowser(page), "blocking errors").toEqual([]);
            await expectRecordsMatchFile(module, file);
            await expectGolden(`${name}-small`, await takeSnapshot(module), testInfo);
        });

        test("deletes the small file in the browser and leaves no data", async ({ page }) => {
            await deleteTestUploads(page, module);
            await expectEmpty(module);
        });

        test("imports a large file on the async-uploads server exactly as written", async ({ page }, testInfo) => {
            const file = risIndividualFungalFile(module, "RIS_large", 5100);
            await attachFiles(
                page,
                module,
                module === "AMR_INDIVIDUAL" ? { primary: file, fileType } : { primary: file }
            );
            await queueForServer(page);
            await runServerCycle("uploads", testInfo);
            await expectRecordsMatchFile(module, file);
            await expectGolden(`${name}-large`, await takeSnapshot(module), testInfo);
        });

        test("deletes the large file on the async-deletions server and leaves no data", async ({ page }, testInfo) => {
            await deleteTestUploads(page, module);
            await runServerCycle("deletions", testInfo);
            await expectEmpty(module);
        });
    });
}
