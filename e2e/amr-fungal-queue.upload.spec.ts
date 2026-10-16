/* The async-uploads server must not let one failing upload hold up the uploads behind it, but must stop its run after
   two failures in a row (then the cause is probably DHIS2, not the uploads). The failing uploads are queue entries that
   point at no upload, put in front of a real test upload; they are removed again at the end. */
import { expect, test } from "@playwright/test";
import { expectRecordsMatchFile } from "./support/accuracy";
import { attachFiles, deleteTestUploads } from "./support/app";
import { risIndividualFungalFile } from "./support/fixtures";
import { expectEmpty, queueForServer, startFromEmpty } from "./support/flows";
import { getQueue, QueueItem, runServerCycle, setUploadsQueue } from "./support/servers";

const module = "AMR_FUNGAL";
const [firstFailing, secondFailing] = ["E2eFailQ001", "E2eFailQ002"] as const;
const failingIds: string[] = [firstFailing, secondFailing];
const failingEntry = (uploadId: string): QueueItem => ({ uploadId, type: "primary", status: "PENDING", attempts: 0 });
const attemptsOf = (queue: QueueItem[], uploadId: string) => queue.find(item => item.uploadId === uploadId)?.attempts;

test.describe.serial("AMR - Fungal: async-uploads queue with failing uploads", () => {
    const file = risIndividualFungalFile(module, "RIS_queue", 5100);

    test.afterAll(async () => {
        const queue = await getQueue("async-uploads");
        const withoutFailing = queue.filter(item => !failingIds.includes(item.uploadId));
        if (withoutFailing.length !== queue.length) await setUploadsQueue(withoutFailing);
    });

    test("starts from an empty test country and year", async ({ page }, testInfo) => {
        await startFromEmpty(page, module, testInfo);
    });

    test("two uploads failing in a row stop the run: the upload behind them waits for the next run", async ({
        page,
    }, testInfo) => {
        await attachFiles(page, module, { primary: file });
        await queueForServer(page);
        const queued = await getQueue("async-uploads");
        expect(queued, "only the test upload is queued").toHaveLength(1);
        const testUpload = queued[0] as QueueItem;
        await setUploadsQueue([failingEntry(firstFailing), failingEntry(secondFailing), ...queued]);

        await runServerCycle("uploads", testInfo, { fakeUploadIds: failingIds, expectQueueEmptied: false });

        const after = await getQueue("async-uploads");
        expect(attemptsOf(after, firstFailing), "attempts of the first failing upload").toBe(1);
        expect(attemptsOf(after, secondFailing), "attempts of the second failing upload").toBe(1);
        expect(attemptsOf(after, testUpload.uploadId), "the test upload was not tried").toBe(0);
    });

    // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern, and this test uses no fixture
    test("an upload failing alone does not stop the upload behind it, which is imported exactly as written", async ({}, testInfo) => {
        const queue = await getQueue("async-uploads");
        await setUploadsQueue(queue.filter(item => item.uploadId !== secondFailing));

        await runServerCycle("uploads", testInfo, { fakeUploadIds: failingIds, expectQueueEmptied: false });

        const after = await getQueue("async-uploads");
        expect(
            after.map(item => item.uploadId),
            "left in the queue"
        ).toEqual([firstFailing]);
        expect(attemptsOf(after, firstFailing), "attempts of the failing upload").toBe(2);
        await expectRecordsMatchFile(module, file);
    });

    test("deletes the file and leaves no data", async ({ page }, testInfo) => {
        await deleteTestUploads(page, module);
        await runServerCycle("deletions", testInfo);
        await expectEmpty(module);
    });
});
