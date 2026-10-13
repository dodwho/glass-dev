import { TrackerImportResult } from "../../../../entities/data-entry/TrackerImportResult";
import { Future, FutureData } from "../../../../entities/Future";
import { GlassUploads } from "../../../../entities/GlassUploads";
import { Id } from "../../../../entities/Ref";
import { TrackerPostRequest } from "../../../../entities/TrackedEntityInstance";
import { TrackerRepository } from "../../../../repositories/TrackerRepository";
import { DeleteAMCProductLevelData } from "../DeleteAMCProductLevelData";

const PRODUCT_IDS = ["prod0000001", "prod0000002", "prod0000003"];
const CALCULATED_IDS = ["calc0000001", "calc0000002"];

class FakeDhis2 {
    existing = new Set<Id>([...PRODUCT_IDS, ...CALCULATED_IDS]);
    /** Tracked entities whose delete request is answered with an error and does nothing. */
    stuck = new Set<Id>();

    import(req: TrackerPostRequest): FutureData<TrackerImportResult> {
        const ids = [
            ...(req.trackedEntities ?? []).map(({ trackedEntity }) => trackedEntity),
            ...(req.events ?? []).map(({ event }) => event),
        ];
        ids.filter(id => !this.stuck.has(id)).forEach(id => this.existing.delete(id));
        return ids.some(id => this.stuck.has(id)) ? Future.error("socket hang up") : Future.success(okResult());
    }

    getExistingTrackedEntitiesIdsByIds(ids: Id[]): FutureData<Id[]> {
        return Future.success(ids.filter(id => this.existing.has(id)));
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
    const documents: Record<string, Id[]> = { productList: PRODUCT_IDS, calculatedList: CALCULATED_IDS };
    // No excelRepository and no instanceRepository: the delete must not need the original file.
    const deleteProducts = new DeleteAMCProductLevelData({
        trackerRepository: dhis2 as unknown as TrackerRepository,
        glassDocumentsRepository: {
            download: (id: string) => Future.success({ text: () => Promise.resolve(JSON.stringify(documents[id])) }),
        } as never,
        metadataRepository: {} as never,
        amcSubstanceDataRepository: {} as never,
        glassUploadsRepository: {
            setEventListDataDeleted: () => {
                flagsSet.push("products");
                return Future.success(undefined);
            },
            setCalculatedEventListDataDeleted: () => {
                flagsSet.push("calculated");
                return Future.success(undefined);
            },
        } as never,
    });
    const run = (uploadFields: Partial<GlassUploads>) =>
        deleteProducts
            .delete({ id: "upload00001", orgUnit: "orgUnit0001", ...uploadFields } as GlassUploads, undefined)
            .toPromise();

    return { dhis2, flagsSet, run };
}

describe("DeleteAMCProductLevelData", () => {
    it("deletes the products and the calculated events of an upload without reading its file", async () => {
        const { dhis2, flagsSet, run } = setup();

        const summary = await run({ eventListFileId: "productList", calculatedEventListFileId: "calculatedList" });

        expect(dhis2.existing.size).toBe(0);
        expect(flagsSet).toEqual(["products", "calculated"]);
        expect(summary).toMatchObject({ status: "SUCCESS", importCount: { deleted: 5, total: 5 } });
    });

    it("leaves the calculated events and the flags unset when a product is not deleted", async () => {
        const dhis2 = new FakeDhis2();
        dhis2.stuck.add("prod0000002");
        const { flagsSet, run } = setup(dhis2);

        const summary = await run({ eventListFileId: "productList", calculatedEventListFileId: "calculatedList" });

        expect(summary.status).toBe("ERROR");
        expect(summary.importCount).toMatchObject({ deleted: 2, ignored: 1, total: 3 });
        expect(flagsSet).toEqual([]);
        expect(dhis2.existing).toEqual(new Set(["prod0000002", ...CALCULATED_IDS]));
    });

    it("marks an upload without a product list as deleted", async () => {
        const { dhis2, flagsSet, run } = setup();

        const summary = await run({});

        expect(flagsSet).toEqual(["products"]);
        expect(dhis2.existing.size).toBe(5);
        expect(summary.status).toBe("SUCCESS");
    });
});
