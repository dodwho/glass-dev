import { TrackerImportResult } from "../../../entities/data-entry/TrackerImportResult";
import { Future } from "../../../entities/Future";
import { MetadataRepository } from "../../../repositories/MetadataRepository";
import { mapToImportSummary } from "../ImportBLTemplateEventProgram";

const metadataRepository = { getD2Ids: () => Future.success([]) } as unknown as MetadataRepository;

const invalidOption = (uid: string) => ({
    message: "Value `SECCARE` is not a valid option code in option set `XRVhrEyGN62`",
    errorCode: "E1125",
    trackerType: "ENROLLMENT",
    uid,
});

const cascade = (eventUid: string, enrollmentUid: string) => ({
    message: `"event" \`${eventUid}\` cannot be persisted because "enrollment" \`${enrollmentUid}\` referenced by it cannot be persisted.`,
    errorCode: "E5000",
    trackerType: "EVENT",
    uid: eventUid,
});

function report(errorReports: object[]): TrackerImportResult {
    return {
        status: "ERROR",
        validationReport: { errorReports, warningReports: [] },
        stats: { created: 0, updated: 0, deleted: 0, ignored: 6, total: 6 },
    } as unknown as TrackerImportResult;
}

function summarise(errorReports: object[]) {
    return mapToImportSummary(report(errorReports), "trackedEntity", metadataRepository).toPromise();
}

describe("mapToImportSummary", () => {
    it("reports root-cause errors and leaves out the cascade errors they cause", async () => {
        const { importSummary } = await summarise([
            invalidOption("enrollment1"),
            cascade("event0000001", "enrollment1"),
            invalidOption("enrollment2"),
            cascade("event0000002", "enrollment2"),
        ]);

        expect(importSummary.status).toBe("ERROR");
        expect(importSummary.blockingErrors).toEqual([
            {
                error: "Value `SECCARE` is not a valid option code in option set `XRVhrEyGN62`",
                count: 2,
                lines: [],
            },
        ]);
    });

    it("keeps cascade errors when no other error is reported", async () => {
        const { importSummary } = await summarise([cascade("event0000001", "enrollment1")]);

        expect(importSummary.blockingErrors).toHaveLength(1);
        expect(importSummary.blockingErrors[0]?.error).toContain("cannot be persisted");
    });
});

describe("mapToImportSummary: ids of the saved data and error lines", () => {
    const namingRepository = {
        getD2Ids: (ids: string[]) => Future.success(ids.map(id => ({ id, name: `Name of ${id}` }))),
    } as unknown as MetadataRepository;

    function result(overrides: Partial<TrackerImportResult>): TrackerImportResult {
        return {
            status: "OK",
            message: "",
            stats: { created: 2, updated: 0, deleted: 0, ignored: 0, total: 2 },
            validationReport: { errorReports: [], warningReports: [] },
            bundleReport: {
                typeReportMap: {
                    EVENT: { objectReports: [{ uid: "evt00000001" }, { uid: "evt00000002" }] },
                    TRACKED_ENTITY: { objectReports: [] },
                },
            },
            ...overrides,
        };
    }

    it("returns the ids of the created events so the upload can delete them later", async () => {
        const { importSummary, eventIdList } = await mapToImportSummary(
            result({}),
            "event",
            namingRepository
        ).toPromise();

        expect(importSummary.status).toBe("SUCCESS");
        expect(importSummary.importCount).toEqual({ imported: 2, updated: 0, deleted: 0, ignored: 0, total: 2 });
        expect(eventIdList).toEqual(["evt00000001", "evt00000002"]);
    });

    // DHIS2 answers WARNING when the data is saved with warnings: the events exist and must be deletable.
    it("also returns the ids when DHIS2 saved the data with warnings", async () => {
        const warning = result({
            status: "WARNING",
            validationReport: {
                errorReports: [],
                warningReports: [{ message: "Value is out of range", errorCode: "E1300", uid: "evt00000001" }],
            },
        });

        const { importSummary, eventIdList } = await mapToImportSummary(warning, "event", namingRepository).toPromise();

        expect(importSummary.status).toBe("WARNING");
        expect(eventIdList).toEqual(["evt00000001", "evt00000002"]);
    });

    it("returns no ids when the import failed", async () => {
        const failed = result({
            status: "ERROR",
            stats: { created: 0, updated: 0, deleted: 0, ignored: 2, total: 2 },
            validationReport: {
                errorReports: [{ message: "Value not valid", errorCode: "E1007", uid: "evt00000001" }],
                warningReports: [],
            },
        });

        const { importSummary, eventIdList } = await mapToImportSummary(failed, "event", namingRepository).toPromise();

        expect(importSummary.status).toBe("ERROR");
        expect(eventIdList).toEqual([]);
    });

    it("reports each error once with the file line of every event, naming DHIS2 ids in the message", async () => {
        const message = "Data element dataElemnt1 has an invalid value";
        const failed = result({
            status: "ERROR",
            validationReport: {
                errorReports: [
                    { message, errorCode: "E1007", uid: "evt00000001" },
                    { message, errorCode: "E1007", uid: "evt00000002" },
                ],
                warningReports: [],
            },
        });

        const { importSummary } = await mapToImportSummary(failed, "event", namingRepository, {
            eventIdLineNoMap: [
                { id: "evt00000001", lineNo: 6 },
                { id: "evt00000002", lineNo: 9 },
            ],
        }).toPromise();

        expect(importSummary.blockingErrors).toEqual([
            { error: "Data element Name of dataElemnt1 has an invalid value", count: 2, lines: [6, 9] },
        ]);
    });

    it("returns tracked entity ids for tracked entity imports", async () => {
        const teis = result({
            bundleReport: {
                typeReportMap: {
                    EVENT: { objectReports: [{ uid: "evt00000001" }] },
                    TRACKED_ENTITY: { objectReports: [{ uid: "tei00000001" }] },
                },
            },
        });

        const { eventIdList } = await mapToImportSummary(teis, "trackedEntity", namingRepository).toPromise();

        expect(eventIdList).toEqual(["tei00000001"]);
    });
});
