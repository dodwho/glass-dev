import { TrackerImportResult } from "../../../../entities/data-entry/TrackerImportResult";
import { AsyncUploadProgress, ASYNC_UPLOAD_STALE_AFTER_MS } from "../../../../entities/AsyncUploadProgress";
import { CustomDataColumns } from "../../../../entities/data-entry/amr-individual-fungal-external/RISIndividualFungalData";
import { ImportSummary } from "../../../../entities/data-entry/ImportSummary";
import { Future, FutureData } from "../../../../entities/Future";
import { GlassModule } from "../../../../entities/GlassModule";
import { Id } from "../../../../entities/Ref";
import { TrackerPostRequest, TrackerTrackedEntity } from "../../../../entities/TrackedEntityInstance";
import { AsyncUploadProgressRepository } from "../../../../repositories/AsyncUploadProgressRepository";
import { GlassDocumentsRepository } from "../../../../repositories/GlassDocumentsRepository";
import { GlassUploadsRepository } from "../../../../repositories/GlassUploadsRepository";
import { MetadataRepository } from "../../../../repositories/MetadataRepository";
import { TrackerRepository } from "../../../../repositories/TrackerRepository";
import { RISIndividualFungalDataRepository } from "../../../../repositories/data-entry/RISIndividualFungalDataRepository";
import { recoverInterruptedAsyncUploads } from "../../utils/AsyncUploadProgressTracker";
import { AsyncImportRISIndividualFungalFile } from "../AsyncImportRISIndividualFungalFile";

const ORG_UNIT = "countryOu01";
const UPLOAD_ID = "uploadId001";

const programMetadata = {
    programAttributes: [
        { id: "qKWPfeSgTnc", name: "Patient id", code: "PATIENT_ID", valueType: "TEXT" },
        { id: "uSGcLbT5gJJ", name: "Patient counter", code: "PATIENTCOUNTER", valueType: "NUMBER" },
        {
            id: "hcfTypeAttr",
            name: "HCF type",
            code: "HCF_TYPE",
            valueType: "TEXT",
            optionSetValue: true,
            optionSet: { options: [{ code: "PRCARE" }, { code: "SECARE" }] },
        },
    ],
    programStageDataElements: [{ id: "Xtn5zEL9mGx", name: "Sample date", code: "SAMPLE_DATE", valueType: "DATE" }],
};

function row(index: number, hcfType = "SECARE"): CustomDataColumns {
    return [
        { key: "COUNTRY", type: "string", value: "CPV" },
        { key: "YEAR", type: "number", value: 2024 },
        { key: "PATIENT_ID", type: "string", value: `patient-${index}` },
        { key: "PATIENTCOUNTER", type: "number", value: index },
        { key: "HCF_TYPE", type: "string", value: hcfType },
        { key: "SAMPLE_DATE", type: "string", value: "2024-03-01" },
    ];
}

/** In-memory DHIS2: tracked entities by id with their org unit. */
class FakeDhis2 implements Partial<TrackerRepository> {
    trackedEntities = new Map<Id, Id>();
    importCalls = 0;
    rejectImportCall?: number;
    failImportCall?: number;
    failDeletes = false;

    import(req: TrackerPostRequest, options: { action: string }): FutureData<TrackerImportResult> {
        const entities = req.trackedEntities ?? [];
        if (options.action === "DELETE") {
            if (this.failDeletes) return Future.error("network error while deleting");
            entities.forEach(({ trackedEntity }) => this.trackedEntities.delete(trackedEntity));
            return Future.success(response("OK", { deleted: entities.length }));
        }

        this.importCalls++;
        if (this.importCalls === this.failImportCall) return Future.error("socket hang up");
        if (this.importCalls === this.rejectImportCall) {
            return Future.success(
                response("ERROR", { ignored: entities.length }, [
                    {
                        message: "Value `X` is not valid",
                        errorCode: "E1125",
                        trackerType: "ENROLLMENT",
                        uid: enrollmentId(entities[0]),
                    },
                ])
            );
        }
        entities.forEach(entity => this.trackedEntities.set(entity.trackedEntity, entity.orgUnit));
        return Future.success(response("OK", { created: entities.length }, [], entities));
    }

    getExistingTrackedEntities(ids: Id[]): FutureData<{ trackedEntity: Id; orgUnit: Id }[]> {
        return Future.success(
            ids.flatMap(id => {
                const orgUnit = this.trackedEntities.get(id);
                return orgUnit ? [{ trackedEntity: id, orgUnit }] : [];
            })
        );
    }

    getProgramMetadata(): FutureData<any> {
        return Future.success(programMetadata);
    }
}

function enrollmentId(entity: TrackerTrackedEntity | undefined): Id {
    return entity?.enrollments[0]?.enrollment ?? "";
}

function response(
    status: "OK" | "ERROR",
    stats: Partial<TrackerImportResult["stats"]>,
    errorReports: object[] = [],
    created: TrackerTrackedEntity[] = []
): TrackerImportResult {
    return {
        status,
        validationReport: { errorReports, warningReports: [] },
        stats: { created: 0, updated: 0, deleted: 0, ignored: 0, total: 0, ...stats },
        bundleReport: {
            typeReportMap: { TRACKED_ENTITY: { objectReports: created.map(e => ({ uid: e.trackedEntity })) } },
        },
    } as unknown as TrackerImportResult;
}

class FakeProgressRepository implements AsyncUploadProgressRepository {
    records = new Map<Id, AsyncUploadProgress>();
    ids = new Map<string, Id[]>();

    get(uploadId: Id) {
        return Future.success<AsyncUploadProgress | undefined, string>(this.records.get(uploadId));
    }
    getAll() {
        return Future.success<AsyncUploadProgress[], string>(Array.from(this.records.values()));
    }
    save(progress: AsyncUploadProgress) {
        this.records.set(progress.uploadId, progress);
        return Future.success<void, string>(undefined);
    }
    saveTrackedEntityIds(uploadId: Id, chunkIndex: number, ids: Id[]) {
        this.ids.set(`${uploadId}-${chunkIndex}`, ids);
        return Future.success<void, string>(undefined);
    }
    getTrackedEntityIds(uploadId: Id, chunkIndex: number) {
        return Future.success<Id[], string>(this.ids.get(`${uploadId}-${chunkIndex}`) ?? []);
    }
    remove(progress: AsyncUploadProgress) {
        this.records.delete(progress.uploadId);
        Array.from(this.ids.keys())
            .filter(key => key.startsWith(progress.uploadId))
            .forEach(key => this.ids.delete(key));
        return Future.success<void, string>(undefined);
    }
}

function setup(rows: CustomDataColumns[]) {
    const dhis2 = new FakeDhis2();
    const progress = new FakeProgressRepository();
    const saved: { summaries?: ImportSummary[]; eventListFileId?: Id } = {};

    const repositories = {
        risIndividualFungalRepository: {
            getFromBlobInChunks: (_columns: unknown, _blob: unknown, chunkSize: number, onChunk: any) => {
                const run = (start: number): FutureData<void> =>
                    start >= rows.length
                        ? Future.success(undefined)
                        : onChunk(rows.slice(start, start + chunkSize)).flatMap((next: boolean) =>
                              next ? run(start + chunkSize) : Future.success(undefined)
                          );
                return run(0);
            },
        } as unknown as RISIndividualFungalDataRepository,
        trackerRepository: dhis2 as unknown as TrackerRepository,
        glassDocumentsRepository: {
            saveBuffer: () => Future.success("eventListFile"),
        } as unknown as GlassDocumentsRepository,
        glassUploadsRepository: {
            saveImportSummaries: ({ importSummaries }: { importSummaries: ImportSummary[] }) => {
                saved.summaries = importSummaries;
                return Future.success(undefined);
            },
            setEventListFileId: (_id: Id, fileId: Id) => {
                saved.eventListFileId = fileId;
                return Future.success(undefined);
            },
            getById: () => Future.success({ asyncImportSummaries: saved.summaries }),
        } as unknown as GlassUploadsRepository,
        metadataRepository: { getD2Ids: () => Future.success([]) } as unknown as MetadataRepository,
        asyncUploadProgressRepository: progress,
    };

    const run = () =>
        new AsyncImportRISIndividualFungalFile(repositories)
            .asyncImportRISIndividualFungalFile({
                uploadId: UPLOAD_ID,
                inputBlob: new Blob([]),
                glassModule: { name: "AMR - Individual" } as GlassModule,
                uploadChunkSize: 2,
                maxConcurrency: 1,
                orgUnitId: ORG_UNIT,
                countryCode: "CPV",
                period: "2024",
                program: undefined,
                dataColumns: [],
                allCountries: [],
            })
            .runAsync();

    return { dhis2, progress, saved, repositories, run };
}

const sixRows = [1, 2, 3, 4, 5, 6].map(index => row(index));

describe("AsyncImportRISIndividualFungalFile", () => {
    beforeEach(() => {
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "debug").mockImplementation(() => {});
        jest.spyOn(console, "log").mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    it("imports a valid file and keeps a COMPLETED record until the final status is saved", async () => {
        const { dhis2, progress, saved, run } = setup(sixRows);

        const { data, error } = await run();

        expect(error).toBeUndefined();
        expect(dhis2.trackedEntities.size).toBe(6);
        expect(data?.every(summary => summary.blockingErrors.length === 0)).toBe(true);
        expect(saved.eventListFileId).toBe("eventListFile");
        expect(progress.records.get(UPLOAD_ID)?.state).toBe("COMPLETED");
    });

    it("sends nothing when a row is blocked, and reports every blocked line", async () => {
        const { dhis2, progress, run } = setup([row(1, "SECCARE"), row(2), row(3, "SECCARE")]);

        const { data } = await run();

        expect(dhis2.importCalls).toBe(0);
        expect(progress.records.size).toBe(0);
        expect(data?.[0]?.blockingErrors).toEqual([expect.objectContaining({ count: 2, lines: [2, 4] })]);
    });

    it("removes everything already imported when DHIS2 rejects a later chunk", async () => {
        const { dhis2, progress, saved, run } = setup(sixRows);
        dhis2.rejectImportCall = 3;

        const { data, error } = await run();

        expect(error).toBeUndefined();
        expect(dhis2.importCalls).toBe(3);
        expect(dhis2.trackedEntities.size).toBe(0);
        expect(progress.records.size).toBe(0);
        expect(saved.eventListFileId).toBeUndefined();
        expect(data).toEqual([
            expect.objectContaining({
                status: "ERROR",
                importCount: expect.objectContaining({ imported: 0 }),
                blockingErrors: [{ error: "Value `X` is not valid", count: 1, lines: [6] }],
            }),
        ]);
    });

    it("treats a request DHIS2 never answered as a technical failure: undone and retried later", async () => {
        const { dhis2, progress, saved, run } = setup(sixRows);
        dhis2.failImportCall = 2;

        const { data, error } = await run();

        expect(data).toBeUndefined();
        expect(error).toContain("DHIS2 could not be reached: socket hang up");
        expect(dhis2.trackedEntities.size).toBe(0);
        expect(progress.records.size).toBe(0);
        expect(saved.summaries).toBeUndefined();
    });

    it("keeps the record for a later retry when the undo itself fails, then recovers", async () => {
        const { dhis2, progress, repositories, run } = setup(sixRows);
        dhis2.rejectImportCall = 3;
        dhis2.failDeletes = true;

        const { error } = await run();

        expect(error).toBeDefined();
        expect(dhis2.trackedEntities.size).toBe(4);
        expect(progress.records.get(UPLOAD_ID)?.state).toBe("UNDO_REQUIRED");

        dhis2.failDeletes = false;
        const recovered = await recoverInterruptedAsyncUploads(repositories).toPromise();

        expect(recovered).toEqual([UPLOAD_ID]);
        expect(dhis2.trackedEntities.size).toBe(0);
        expect(progress.records.size).toBe(0);
    });

    it("deletes nothing if a recorded id exists in another org unit", async () => {
        const { dhis2, progress, repositories } = setup([]);
        dhis2.trackedEntities.set("mine0000001", ORG_UNIT);
        dhis2.trackedEntities.set("foreign0001", "otherOu0001");
        progress.ids.set(`${UPLOAD_ID}-0`, ["mine0000001", "foreign0001"]);
        progress.records.set(UPLOAD_ID, record({ state: "UNDO_REQUIRED" }));

        const recovered = await recoverInterruptedAsyncUploads(repositories).toPromise();

        expect(recovered).toEqual([]);
        expect(dhis2.trackedEntities.size).toBe(2);
        expect(progress.records.get(UPLOAD_ID)?.state).toBe("UNDO_REQUIRED");
    });

    it("undoes an import whose run stopped updating its record, but not one still running", async () => {
        const { dhis2, progress, repositories } = setup([]);
        dhis2.trackedEntities.set("crashed0001", ORG_UNIT);
        progress.ids.set(`${UPLOAD_ID}-0`, ["crashed0001"]);
        progress.records.set(UPLOAD_ID, record({ heartbeatAt: new Date().toISOString() }));

        expect(await recoverInterruptedAsyncUploads(repositories).toPromise()).toEqual([]);
        expect(dhis2.trackedEntities.size).toBe(1);

        const stale = new Date(Date.now() - ASYNC_UPLOAD_STALE_AFTER_MS - 1000).toISOString();
        progress.records.set(UPLOAD_ID, record({ heartbeatAt: stale }));

        expect(await recoverInterruptedAsyncUploads(repositories).toPromise()).toEqual([UPLOAD_ID]);
        expect(dhis2.trackedEntities.size).toBe(0);
    });

    it("refuses to import an upload another process is importing", async () => {
        const { dhis2, progress, run } = setup(sixRows);
        progress.records.set(UPLOAD_ID, record({ heartbeatAt: new Date().toISOString() }));

        const { error } = await run();

        expect(error).toContain("already being imported");
        expect(dhis2.importCalls).toBe(0);
    });

    it("does not import again an upload an earlier run completed", async () => {
        const { dhis2, run } = setup(sixRows);
        await run();
        const importCalls = dhis2.importCalls;

        const { data, error } = await run();

        expect(error).toBeUndefined();
        expect(dhis2.importCalls).toBe(importCalls);
        expect(dhis2.trackedEntities.size).toBe(6);
        expect(data?.length).toBeGreaterThan(0);
    });
});

function record(changes: Partial<AsyncUploadProgress>): AsyncUploadProgress {
    return {
        uploadId: UPLOAD_ID,
        runId: "run00000001",
        orgUnit: ORG_UNIT,
        trackedEntityType: "CcgnfemKr5U",
        state: "IN_PROGRESS",
        heartbeatAt: new Date(0).toISOString(),
        savedIdChunks: 1,
        ...changes,
    };
}
