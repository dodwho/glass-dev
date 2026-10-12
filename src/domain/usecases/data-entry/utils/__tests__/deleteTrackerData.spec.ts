import _ from "lodash";
import { TrackerImportResult } from "../../../../entities/data-entry/TrackerImportResult";
import { Future, FutureData } from "../../../../entities/Future";
import { Id } from "../../../../entities/Ref";
import { TrackerPostRequest } from "../../../../entities/TrackedEntityInstance";
import { TrackerRepository } from "../../../../repositories/TrackerRepository";
import { deleteEvents, deleteTrackedEntities, getDeleteImportSummary } from "../deleteTrackerData";

const TARGET = { orgUnit: "countryOu01", trackedEntityType: "teType00001" };

/** In-memory DHIS2 that answers each delete request after a short delay, so requests overlap. */
class FakeDhis2 {
    existing: Set<Id>;
    requests: TrackerPostRequest[] = [];
    inFlight = 0;
    maxInFlight = 0;
    /** Ids whose request fails without an answer. */
    unreachable = new Set<Id>();
    /** Ids whose request goes through but is answered with an error, as when a resend follows a lost answer. */
    answeredWithError = new Set<Id>();

    constructor(ids: Id[]) {
        this.existing = new Set(ids);
    }

    import(req: TrackerPostRequest, options: { action: string }): FutureData<TrackerImportResult> {
        expect(options).toMatchObject({ action: "DELETE", async: false, retryTransientErrors: true });
        this.requests.push(req);
        const ids = [...(req.trackedEntities ?? []).map(t => t.trackedEntity), ...(req.events ?? []).map(e => e.event)];

        // Lazy like the real repository: the request starts only when the future runs.
        return Future.fromComputation<string, TrackerImportResult>((resolve, reject) => {
            this.inFlight++;
            this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
            const timer = setTimeout(() => {
                this.inFlight--;
                if (ids.some(id => this.unreachable.has(id))) return reject("socket hang up");
                ids.forEach(id => this.existing.delete(id));
                resolve(result(ids.some(id => this.answeredWithError.has(id)) ? "ERROR" : "OK"));
            }, 5);
            return () => clearTimeout(timer);
        });
    }

    getExistingIds = (ids: Id[]): FutureData<Id[]> => Future.success(ids.filter(id => this.existing.has(id)));

    asRepository(): TrackerRepository {
        return this as unknown as TrackerRepository;
    }
}

function result(status: "OK" | "ERROR"): TrackerImportResult {
    return {
        status,
        message: "",
        stats: { created: 0, updated: 0, deleted: 0, ignored: 0, total: 0 },
        validationReport: {
            errorReports:
                status === "ERROR" ? [{ message: "Tracked entity does not exist", errorCode: "E1063", uid: "" }] : [],
            warningReports: [],
        },
        bundleReport: { typeReportMap: { EVENT: { objectReports: [] }, TRACKED_ENTITY: { objectReports: [] } } },
    };
}

function ids(count: number): Id[] {
    return _.range(count).map(index => `id${String(index).padStart(9, "0")}`);
}

describe("deleteTrackerData", () => {
    it("deletes tracked entities in requests of at most 20, at most 10 at a time", async () => {
        const all = ids(450);
        const dhis2 = new FakeDhis2(all);

        const deleted = await deleteTrackedEntities(
            all,
            TARGET,
            dhis2.getExistingIds,
            dhis2.asRepository()
        ).toPromise();

        expect(dhis2.requests).toHaveLength(23);
        expect(_.max(dhis2.requests.map(req => req.trackedEntities?.length))).toBe(20);
        expect(dhis2.maxInFlight).toBe(10);
        expect(dhis2.requests[0]?.trackedEntities?.[0]).toEqual({
            trackedEntity: all[0],
            ...TARGET,
            attributes: [],
            enrollments: [],
        });
        expect(deleted).toEqual({ total: 450, remaining: [], failures: [] });
        expect(getDeleteImportSummary(deleted)).toEqual({
            status: "SUCCESS",
            importCount: { imported: 0, updated: 0, ignored: 0, deleted: 450, total: 450 },
            nonBlockingErrors: [],
            blockingErrors: [],
        });
    });

    it("deletes events by id", async () => {
        const all = ids(30);
        const dhis2 = new FakeDhis2(all);

        const deleted = await deleteEvents(all, dhis2.getExistingIds, dhis2.asRepository()).toPromise();

        expect(dhis2.requests.flatMap(req => req.events?.map(event => event.event))).toEqual(all);
        expect(deleted.remaining).toEqual([]);
    });

    it("keeps going after a failed request and reports what is left as an error", async () => {
        const all = ids(100);
        const dhis2 = new FakeDhis2(all);
        dhis2.unreachable.add(all[25] ?? "");

        const deleted = await deleteTrackedEntities(
            all,
            TARGET,
            dhis2.getExistingIds,
            dhis2.asRepository()
        ).toPromise();

        expect(dhis2.requests).toHaveLength(5);
        expect(deleted.remaining).toEqual(all.slice(20, 40));
        expect(getDeleteImportSummary(deleted)).toEqual({
            status: "ERROR",
            importCount: { imported: 0, updated: 0, ignored: 20, deleted: 80, total: 100 },
            nonBlockingErrors: [],
            blockingErrors: [
                { error: "20 of 100 records could not be deleted. Delete the upload again to retry.", count: 20 },
                { error: "Delete request failed: socket hang up", count: 1 },
            ],
        });
    });

    it("succeeds when a request answered with an error but its records are gone", async () => {
        const all = ids(40);
        const dhis2 = new FakeDhis2(all);
        dhis2.answeredWithError.add(all[0] ?? "");

        const deleted = await deleteTrackedEntities(
            all,
            TARGET,
            dhis2.getExistingIds,
            dhis2.asRepository()
        ).toPromise();

        expect(deleted.failures).toEqual(["Tracked entity does not exist"]);
        expect(getDeleteImportSummary(deleted).status).toBe("SUCCESS");
        expect(getDeleteImportSummary(deleted).blockingErrors).toEqual([]);
    });

    it("sends nothing for an empty list and each id only once", async () => {
        const dhis2 = new FakeDhis2(ids(3));

        const empty = await deleteEvents([], dhis2.getExistingIds, dhis2.asRepository()).toPromise();
        const repeated = await deleteEvents(
            [...ids(3), ...ids(3)],
            dhis2.getExistingIds,
            dhis2.asRepository()
        ).toPromise();

        expect(getDeleteImportSummary(empty)).toMatchObject({ status: "SUCCESS", importCount: { total: 0 } });
        expect(dhis2.requests).toHaveLength(1);
        expect(dhis2.requests[0]?.events).toHaveLength(3);
        expect(repeated).toEqual({ total: 3, remaining: [], failures: [] });
    });

    it("fails when the ids left cannot be read, instead of reporting a success", async () => {
        const all = ids(5);
        const dhis2 = new FakeDhis2(all);

        const run = deleteTrackedEntities(
            all,
            TARGET,
            () => Future.error("lookup failed"),
            dhis2.asRepository()
        ).toPromise();

        await expect(run).rejects.toBe("lookup failed");
    });
});
