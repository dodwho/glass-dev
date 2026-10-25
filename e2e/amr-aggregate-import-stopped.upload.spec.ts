import { expect, Page, test } from "@playwright/test";
import { attachFiles, continueButton, deleteTestUploads, waitForIdle } from "./support/app";
import { dhis2Url } from "./support/config";
import { get, getUploads, isTestUpload, takeSnapshot } from "./support/dhis2";
import { amrAggregateFiles } from "./support/fixtures";
import { expectEmpty, startFromEmpty } from "./support/flows";

/* An AMR aggregate real import that stops part-way (the Norway 2024 case on PROD): DHIS2 runs the import as a job
   and goes on writing after the app stops hearing from it. The upload must then say IMPORTED, never UPLOADED, and
   the app's delete must leave nothing behind. The app is cut off by failing its checks on the job's progress
   (`system/tasks`), only after the dry run, so the real import itself reaches DHIS2. */

const batch = { label: "Dataset 1", id: "DS1" };
const tenMinutes = { timeout: 10 * 60_000 };
const stoppedMessage = /The import stopped and some data may have been saved/;

const testUploadStatuses = async () =>
    (await getUploads("AMR"))
        .filter(isTestUpload)
        .map(upload => `${upload.values.fileType} ${upload.values.status}`)
        .sort();

/** Attaches the files and passes the dry run, stopping on the consistency checks with Continue enabled. */
async function passDryRun(page: Page, files: { ris: string; sample: string }) {
    await attachFiles(page, "AMR", { batch: batch.label, primary: files.ris, secondary: files.sample });
    await continueButton(page).click();
    await expect(page.getByText("These Consistency Checks ensure that incorrect data is not imported.")).toBeVisible(
        tenMinutes
    );
    await waitForIdle(page, tenMinutes.timeout);
    await expect(continueButton(page)).toBeEnabled();
}

/** Sets a test upload's status in DHIS2, as uploads stuck before the fix were left (writes go to DEV only). */
async function setTestUploadStatus(uploadId: string, status: string) {
    const event = await get<{ dataValues: { dataElement: string; value: string }[] }>(
        `tracker/events/${uploadId}?fields=*`
    );
    const statusField = "hj79iVAy2QK";
    const dataValues = event.dataValues.map(dv => (dv.dataElement === statusField ? { ...dv, value: status } : dv));
    const response = await fetch(`${dhis2Url}/api/tracker?async=false&importStrategy=UPDATE`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: [{ ...event, dataValues }] }),
    });
    expect(response.status, `set upload ${uploadId} to ${status}`).toBe(200);
}

test.describe.serial("AMR: an import that stops part-way", () => {
    // The app reports why a clean-up did not finish only in the console: copied into the test log
    test.beforeEach(({ page }) => {
        page.on("console", message => {
            if (message.type() === "error") console.warn(`[browser] ${message.text()}`);
        });
    });

    test("starts from an empty test country and year", async ({ page }, testInfo) => {
        await startFromEmpty(page, "AMR", testInfo);
    });

    test("cleans up at once, keeps the uploads IMPORTED, and its delete leaves nothing", async ({ page }, testInfo) => {
        const files = amrAggregateFiles(batch.id);
        await passDryRun(page, files);

        // Only the first progress check of the real import fails: the clean-up's own delete then runs normally
        let failed = 0;
        await page.route("**/system/tasks/**", route => (failed++ === 0 ? route.abort() : route.continue()));
        await continueButton(page).click();

        await expect(page.getByText(stoppedMessage)).toBeVisible(tenMinutes);
        await expect.poll(testUploadStatuses, tenMinutes).toEqual(["RIS IMPORTED", "SAMPLE IMPORTED"]);
        const left = await takeSnapshot("AMR");
        // What the clean-up removed depends on whether DHIS2 had finished the import job: recorded, not asserted
        testInfo.annotations.push({
            type: "after clean-up",
            description: `${left.ris?.length ?? 0} RIS and ${left.sample?.length ?? 0} SAMPLE values left`,
        });

        await page.unroute("**/system/tasks/**");
        await deleteTestUploads(page, "AMR");
        await expectEmpty("AMR");
    });

    test("keeps the uploads IMPORTED and their data when the clean-up fails too", async ({ page }) => {
        const files = amrAggregateFiles(batch.id);
        await passDryRun(page, files);

        // No progress check succeeds, and the clean-up's delete never reaches DHIS2
        await page.route("**/system/tasks/**", route => route.abort());
        await page.route(/dataValueSets.*importStrategy=DELETE/, route => route.abort());
        await continueButton(page).click();

        await expect(page.getByText(stoppedMessage)).toBeVisible(tenMinutes);
        await expect.poll(testUploadStatuses, tenMinutes).toEqual(["RIS IMPORTED", "SAMPLE IMPORTED"]);
        // Some data is stored with no clean-up. How much varies: when one file's job is lost the app cancels the other
        // file's request, which may or may not have reached DHIS2 yet (DEV, 25 Oct: all of SAMPLE, none of RIS).
        const storedValues = async () => {
            const { ris = [], sample = [] } = await takeSnapshot("AMR");
            return ris.length + sample.length;
        };
        await expect.poll(storedValues, tenMinutes).toBeGreaterThan(0);
        await page.unroute("**/system/tasks/**");
        await page.unroute(/dataValueSets.*importStrategy=DELETE/);
    });

    test("deletes the data of uploads stuck at UPLOADED with their data stored (as before the fix)", async ({
        page,
    }) => {
        const uploads = (await getUploads("AMR")).filter(isTestUpload);
        expect(uploads, "the stuck uploads of the previous test").toHaveLength(2);
        for (const upload of uploads) await setTestUploadStatus(upload.id, "UPLOADED");
        expect(await testUploadStatuses()).toEqual(["RIS UPLOADED", "SAMPLE UPLOADED"]);

        await deleteTestUploads(page, "AMR");
        await expectEmpty("AMR");
    });
});
