import { expect, test } from "@playwright/test";
import { expectDataValuesMatchFiles } from "./support/accuracy";
import { attachFiles, deleteTestUploads } from "./support/app";
import { takeSnapshot } from "./support/dhis2";
import { amrAggregateFiles } from "./support/fixtures";
import { expectEmpty, importInBrowser, startFromEmpty } from "./support/flows";
import { expectGolden } from "./support/golden";

const batch = { label: "Dataset 1", id: "DS1" };

test.describe.serial("AMR", () => {
    test("starts from an empty test country and year", async ({ page }, testInfo) => {
        await startFromEmpty(page, "AMR", testInfo);
    });

    test("rejects RIS rows with the wrong year and imports nothing", async ({ page }) => {
        const files = amrAggregateFiles(batch.id, 5);
        await attachFiles(page, "AMR", { batch: batch.label, primary: files.ris, secondary: files.sample });
        expect((await importInBrowser(page)).length, "blocking errors shown").toBeGreaterThan(0);
        const snapshot = await takeSnapshot("AMR");
        expect({ ris: snapshot.ris, sample: snapshot.sample }, "data values from rejected files").toEqual({
            ris: [],
            sample: [],
        });
        await deleteTestUploads(page, "AMR");
        await expectEmpty("AMR");
    });

    test("imports RIS and SAMPLE files exactly as they are written", async ({ page }, testInfo) => {
        const files = amrAggregateFiles(batch.id);
        await attachFiles(page, "AMR", { batch: batch.label, primary: files.ris, secondary: files.sample });
        expect(await importInBrowser(page), "blocking errors").toEqual([]);
        await expectDataValuesMatchFiles(files);
        await expectGolden("amr-aggregate", await takeSnapshot("AMR"), testInfo);
    });

    test("deletes the files and their data values", async ({ page }) => {
        await deleteTestUploads(page, "AMR");
        await expectEmpty("AMR");
    });
});
