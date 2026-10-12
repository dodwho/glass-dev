import { TrackerImportResult } from "../../../entities/data-entry/TrackerImportResult";
import { Future, FutureData } from "../../../entities/Future";
import { GlassUploads } from "../../../entities/GlassUploads";
import { Id } from "../../../entities/Ref";
import { TrackerPostRequest } from "../../../entities/TrackedEntityInstance";
import { TrackerRepository } from "../../../repositories/TrackerRepository";
import { DeleteBLTemplateEventProgram } from "../DeleteBLTemplateEventProgram";

const PROGRAM = "program0001";
const CALCULATED_PROGRAM = "program0002";
const RAW_IDS = ["raw00000001", "raw00000002", "raw00000003"];
const CALCULATED_IDS = ["calc0000001", "calc0000002"];

/** Stands for a repository the delete must not use: any call fails the test. */
const unused = <T>(name: string): T =>
    new Proxy(
        {},
        { get: (_target, key) => () => Promise.reject(new Error(`${name}.${String(key)} must not be called`)) }
    ) as T;

class FakeDhis2 {
    existing = new Set<Id>([...RAW_IDS, ...CALCULATED_IDS]);
    /** Events whose delete request is answered with an error and does nothing. */
    stuck = new Set<Id>();
    requests: Id[][] = [];

    import(req: TrackerPostRequest): FutureData<TrackerImportResult> {
        const ids = (req.events ?? []).map(({ event }) => event);
        this.requests.push(ids);
        ids.filter(id => !this.stuck.has(id)).forEach(id => this.existing.delete(id));
        return ids.some(id => this.stuck.has(id)) ? Future.error("socket hang up") : Future.success(okResult());
    }

    getExistingEventsIdsByIds(ids: Id[]): FutureData<Id[]> {
        return Future.success(ids.filter(id => this.existing.has(id)));
    }
}

function okResult(): TrackerImportResult {
    return {
        status: "OK",
        message: "",
        stats: { created: 0, updated: 0, deleted: 0, ignored: 0, total: 0 },
        validationReport: { errorReports: [], warningReports: [] },
        bundleReport: { typeReportMap: { EVENT: { objectReports: [] }, TRACKED_ENTITY: { objectReports: [] } } },
    };
}

function setup(dhis2 = new FakeDhis2()) {
    const flagsSet: string[] = [];
    const documents: Record<string, Id[]> = { rawList: RAW_IDS, calculatedList: CALCULATED_IDS };
    const deleteProgram = new DeleteBLTemplateEventProgram(
        unused("excelRepository"),
        unused("instanceRepository"),
        {
            download: (id: string) => Future.success({ text: () => Promise.resolve(JSON.stringify(documents[id])) }),
        } as never,
        unused("dhis2EventsDefaultRepository"),
        unused("metadataRepository"),
        {
            setEventListDataDeleted: () => {
                flagsSet.push("events");
                return Future.success(undefined);
            },
            setCalculatedEventListDataDeleted: () => {
                flagsSet.push("calculated");
                return Future.success(undefined);
            },
        } as never,
        dhis2 as unknown as TrackerRepository
    );
    const upload = (fields: Partial<GlassUploads>) => ({ id: "upload00001", ...fields } as GlassUploads);
    const run = (uploadFields: Partial<GlassUploads>, calculatedProgramId?: Id) =>
        deleteProgram
            .delete({
                arrayBuffer: new ArrayBuffer(0),
                programId: PROGRAM,
                upload: upload(uploadFields),
                calculatedProgramId,
            })
            .toPromise();

    return { dhis2, flagsSet, run };
}

describe("DeleteBLTemplateEventProgram", () => {
    it("deletes the events and the calculated events of an upload without reading its file", async () => {
        const { dhis2, flagsSet, run } = setup();

        const summary = await run(
            { eventListFileId: "rawList", calculatedEventListFileId: "calculatedList" },
            CALCULATED_PROGRAM
        );

        expect(dhis2.requests.flat()).toEqual([...RAW_IDS, ...CALCULATED_IDS]);
        expect(dhis2.existing.size).toBe(0);
        expect(flagsSet).toEqual(["events", "calculated"]);
        expect(summary).toEqual({
            status: "SUCCESS",
            importCount: { imported: 0, updated: 0, ignored: 0, deleted: 5, total: 5 },
            nonBlockingErrors: [],
            blockingErrors: [],
        });
    });

    it("deletes the events alone when the upload has no calculated events", async () => {
        const { dhis2, flagsSet, run } = setup();

        const summary = await run({ eventListFileId: "rawList" });

        expect(dhis2.existing).toEqual(new Set(CALCULATED_IDS));
        expect(flagsSet).toEqual(["events", "calculated"]);
        expect(summary.importCount).toMatchObject({ deleted: 3, total: 3 });
    });

    it("reports an error, keeps the flag unset and leaves the calculated events when an event is not deleted", async () => {
        const dhis2 = new FakeDhis2();
        dhis2.stuck.add("raw00000002");
        const { flagsSet, run } = setup(dhis2);

        const summary = await run(
            { eventListFileId: "rawList", calculatedEventListFileId: "calculatedList" },
            CALCULATED_PROGRAM
        );

        expect(summary.status).toBe("ERROR");
        expect(summary.importCount).toMatchObject({ deleted: 2, ignored: 1, total: 3 });
        expect(flagsSet).toEqual([]);
        expect(dhis2.existing).toEqual(new Set(["raw00000002", ...CALCULATED_IDS]));
    });

    it("marks an upload with nothing left to delete as deleted", async () => {
        const { dhis2, flagsSet, run } = setup();
        dhis2.existing.clear();

        const summary = await run({ eventListFileId: "rawList" });

        expect(dhis2.requests).toEqual([]);
        expect(flagsSet).toEqual(["events", "calculated"]);
        expect(summary.status).toBe("SUCCESS");
    });
});
