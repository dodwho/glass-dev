import { TrackerPostResponse } from "@eyeseetea/d2-api/api/tracker";
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

function report(errorReports: object[]): TrackerPostResponse {
    return {
        status: "ERROR",
        validationReport: { errorReports, warningReports: [] },
        stats: { created: 0, updated: 0, deleted: 0, ignored: 6, total: 6 },
    } as unknown as TrackerPostResponse;
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
