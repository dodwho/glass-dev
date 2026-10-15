import { expect, test } from "@playwright/test";
import { attachFiles, deleteTestUploads, downloadTemplate } from "./support/app";
import { getUploads, isTestUpload, takeSnapshot } from "./support/dhis2";
import { amcProductFile, amcSubstanceFile } from "./support/fixtures";
import { expectEmpty, importInBrowser, startFromEmpty } from "./support/flows";
import { expectGolden } from "./support/golden";

// AMC takes one file per submission, product or substance level; consumption is calculated on import.

/** The summary shows before the consumption calculation has finished; it ends by linking its events to the upload. */
async function waitForCalculation() {
    const calculatedList = async () => (await getUploads("AMC")).find(isTestUpload)?.values.calculatedEventList;
    await expect.poll(calculatedList, { timeout: 10 * 60_000 }).toBeTruthy();
}

test.describe.serial("AMC", () => {
    test("starts from an empty test country and year", async ({ page }, testInfo) => {
        await startFromEmpty(page, "AMC", testInfo);
    });

    test("imports substance-level data and calculates consumption as the golden file", async ({ page }, testInfo) => {
        const fileType = "Substance Level Data";
        const file = await amcSubstanceFile(await downloadTemplate(page, "AMC", fileType));
        await attachFiles(page, "AMC", { fileType, secondary: file });
        expect(await importInBrowser(page), "blocking errors").toEqual([]);
        await waitForCalculation();
        const snapshot = await takeSnapshot("AMC");
        expect(snapshot.rawSubstanceConsumption, "one raw consumption event per file row").toHaveLength(40);
        expect(snapshot.calculatedConsumption?.length, "calculated consumption events").toBeGreaterThan(0);
        await expectGolden("amc-substance", snapshot, testInfo);
    });

    test("deletes the substance-level data and its calculated consumption", async ({ page }) => {
        await deleteTestUploads(page, "AMC");
        await expectEmpty("AMC");
    });

    test("imports product-level data and calculates consumption as the golden file", async ({ page }, testInfo) => {
        const fileType = "Product Level Data";
        const file = await amcProductFile(await downloadTemplate(page, "AMC", fileType));
        await attachFiles(page, "AMC", { fileType, primary: file });
        expect(await importInBrowser(page), "blocking errors").toEqual([]);
        await waitForCalculation();
        const snapshot = await takeSnapshot("AMC");
        expect(snapshot.productRegister, "one registered product per file row").toHaveLength(30);
        await expectGolden("amc-product", snapshot, testInfo);
    });

    test("deletes the product-level data and its calculated consumption", async ({ page }) => {
        await deleteTestUploads(page, "AMC");
        await expectEmpty("AMC");
    });
});
