import { test } from "@playwright/test";
import { attachFiles, deleteTestUploads, downloadTemplate } from "./support/app";
import { normalise, takeSnapshot } from "./support/dhis2";
import { egaspFile } from "./support/fixtures";
import { expectEmpty, importInBrowser, startFromEmpty } from "./support/flows";
import { expectGolden } from "./support/golden";

const egaspProgram = "SOjanrinfuG";
const encryptedPatientId = "aocFHBxcQa0";

type TrackerPayload = { events?: { program?: string; dataValues: { dataElement: string; value: unknown }[] }[] };

/** The events the app sent, one line each: data values sorted, the encrypted patient id (random per run) masked. */
function payloadLines(payloads: TrackerPayload[]): string[] {
    return payloads
        .flatMap(payload => payload.events ?? [])
        .map(event =>
            event.dataValues
                .map(
                    dv =>
                        `${dv.dataElement}=${
                            dv.dataElement === encryptedPatientId ? "{ENCRYPTED}" : normalise(String(dv.value ?? ""))
                        }`
                )
                .sort()
                .join(" ")
        )
        .sort();
}

/* EGASP imports are the only ones that also run DHIS2's server-side program rules. On DEV these currently reject every
   row ("Unable to assign value to data element ... must be empty or match the calculated value"), with the original
   1.6.45 build as well; see GLASS-knowledge, 2026-10-15 EGASP uploads rejected - to check. So the golden file records
   what the app sends and what DHIS2 answers, which still shows any change between builds. Once the import works it
   also holds the stored events, and the golden file must be recorded again. */
test.describe.serial("EGASP", () => {
    test("starts from an empty test country and year", async ({ page }, testInfo) => {
        await startFromEmpty(page, "EGASP", testInfo);
    });

    test("sends an EGASP file to DHIS2 exactly as the golden file", async ({ page }, testInfo) => {
        const payloads: TrackerPayload[] = [];
        page.on("request", request => {
            if (request.method() !== "POST" || !request.url().includes("/api/tracker")) return;
            const body = request.postDataJSON() as TrackerPayload | null;
            if (body?.events?.[0]?.program === egaspProgram) payloads.push(body);
        });
        const file = await egaspFile(await downloadTemplate(page, "EGASP"));
        await attachFiles(page, "EGASP", { primary: file });
        const errors = await importInBrowser(page);
        const snapshot = await takeSnapshot("EGASP");
        await expectGolden(
            "egasp",
            { ...snapshot, payload: payloadLines(payloads), errors: [...errors].sort() },
            testInfo
        );
    });

    test("deletes the EGASP file and its events", async ({ page }) => {
        await deleteTestUploads(page, "EGASP");
        await expectEmpty("EGASP");
    });
});
