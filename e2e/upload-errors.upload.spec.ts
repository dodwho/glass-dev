/* When DHIS2 refuses to save an upload record, the upload screens must say so and must not hang. The browser makes
   every save of an upload record fail (POST /api/tracker: the AMR aggregate data itself goes to dataValueSets), at
   one step at a time, and the test uploads are deleted at the end. */
import { expect, Page, test } from "@playwright/test";
import { attachFiles, choose, continueButton, deleteTestUploads, waitForIdle } from "./support/app";
import { getUploads, isTestUpload } from "./support/dhis2";
import { amrAggregateFiles } from "./support/fixtures";
import { expectEmpty, startFromEmpty } from "./support/flows";

const module = "AMR";
const failure = "E2E: DHIS2 refused the save on purpose";
const consistencyChecks = "These Consistency Checks ensure that incorrect data is not imported.";
type MessagesWindow = { e2eMessages: string[] };

async function failUploadRecordSaves(page: Page) {
    await page.route(
        url => url.pathname.endsWith("/api/tracker"),
        route =>
            route.request().method() === "POST"
                ? route.fulfill({ status: 409, json: { httpStatusCode: 409, status: "ERROR", message: failure } })
                : route.continue()
    );
}

/** Records every message the app shows: one replaces the other, so two in a row cannot both be seen on screen. */
async function recordMessages(page: Page) {
    await page.addInitScript(() => {
        const messages: string[] = [];
        (window as unknown as MessagesWindow).e2eMessages = messages;
        new MutationObserver(() => {
            document.querySelectorAll('[role="alert"]').forEach(element => {
                const text = element.textContent ?? "";
                if (text && !messages.includes(text)) messages.push(text);
            });
        }).observe(document, { childList: true, subtree: true, characterData: true });
    });
}

const expectMessage = (page: Page, text: RegExp) =>
    expect
        .poll(() => page.evaluate(() => (window as unknown as MessagesWindow).e2eMessages))
        .toContainEqual(expect.stringMatching(text));

test.describe.serial("AMR: upload records that cannot be saved", () => {
    const files = amrAggregateFiles("DS1");

    test("starts from an empty test country and year", async ({ page }, testInfo) => {
        await startFromEmpty(page, module, testInfo);
    });

    test("step 1 says so when the Batch ID or the link between the files cannot be saved", async ({ page }) => {
        await recordMessages(page);
        await attachFiles(page, module, { batch: "Dataset 1", primary: files.ris, secondary: files.sample });
        await failUploadRecordSaves(page);

        await choose(page, "Dataset 2");
        await expectMessage(page, /The Batch ID could not be saved: .*refused the save on purpose/);
        await waitForIdle(page, 30_000);

        await continueButton(page).click();
        await expectMessage(page, /Error updating .* file with .* file, error : .*refused the save on purpose/);
        await waitForIdle(page, 30_000);
        await expect(page.getByText(consistencyChecks)).toBeHidden();

        // Nothing was imported: the uploads can go before the next test.
        await page.unrouteAll();
        await deleteTestUploads(page, module);
    });

    test("step 2 says so when the error list and the upload status cannot be saved after the import", async ({
        page,
    }) => {
        await recordMessages(page);
        await attachFiles(page, module, { batch: "Dataset 1", primary: files.ris, secondary: files.sample });
        await continueButton(page).click();
        await expect(page.getByText(consistencyChecks)).toBeVisible({ timeout: 10 * 60_000 });
        await waitForIdle(page, 10 * 60_000);
        await failUploadRecordSaves(page);

        await continueButton(page).click();
        await expectMessage(page, /The list of errors found in the file could not be saved: .*refused the save/);
        await expectMessage(page, /Failed to set upload status: .*refused the save on purpose/);
        await waitForIdle(page, 30_000);
        await expect(page.getByRole("heading", { name: "Summary" })).toBeHidden();

        // The data is in DHIS2 but the uploads are still UPLOADED, and Delete skips the data of an UPLOADED upload.
        // Continue again saves a status. Current behaviour: DHIS2 ignores the values it already holds and the app
        // counts ignored values as blocking errors, so the uploads end IMPORTED (Delete then removes their data).
        await page.unrouteAll();
        await continueButton(page).click();
        await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible({ timeout: 10 * 60_000 });
        await expect
            .poll(async () => (await getUploads(module)).filter(isTestUpload).map(upload => upload.values.status))
            .toEqual(["IMPORTED", "IMPORTED"]);
    });

    test("deletes the test uploads and their data values", async ({ page }) => {
        await deleteTestUploads(page, module);
        await expectEmpty(module);
    });
});
