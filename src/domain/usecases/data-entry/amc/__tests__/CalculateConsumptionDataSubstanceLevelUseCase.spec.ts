import { Blob as NodeBlob } from "buffer";
import { Future } from "../../../../entities/Future";
import { CODE_PRODUCT_NOT_HAVE_ATC, GlassAtcVersionData } from "../../../../entities/GlassAtcVersionData";
import { GlassModule } from "../../../../entities/GlassModule";
import { GlassUploads } from "../../../../entities/GlassUploads";
import { RawSubstanceConsumptionData } from "../../../../entities/data-entry/amc/RawSubstanceConsumptionData";
import { TrackerImportResult } from "../../../../entities/data-entry/TrackerImportResult";
import { GlassATCRepository } from "../../../../repositories/GlassATCRepository";
import { GlassDocumentsRepository } from "../../../../repositories/GlassDocumentsRepository";
import { GlassModuleRepository } from "../../../../repositories/GlassModuleRepository";
import { GlassUploadsRepository } from "../../../../repositories/GlassUploadsRepository";
import { MetadataRepository } from "../../../../repositories/MetadataRepository";
import { AMCSubstanceDataRepository } from "../../../../repositories/data-entry/AMCSubstanceDataRepository";
import { setupLoggerForTesting } from "../../../../../utils/logger";
import { CalculateConsumptionDataSubstanceLevelUseCase } from "../CalculateConsumptionDataSubstanceLevelUseCase";

// jest's jsdom Blob has no text(); Node's Blob does, like a browser's.
const nodeBlob = (parts: string[]) => new NodeBlob(parts) as unknown as Blob;

const UPLOAD_ID = "upload0001";
const ORG_UNIT_ID = "orgUnit1";
const PERIOD = "2023";

const atcVersion: GlassAtcVersionData = {
    atcs: [{ CODE: "J01AA01", NAME: "test", LEVEL: 5, PATH: "/J/J01/J01A/J01AA/J01AA01" }],
    ddds: [
        {
            ARS: "J01AA01_OXXXX",
            ATC5: "J01AA01",
            ROA: "O",
            SALT: "XXXX",
            DDD: 0.1,
            DDD_UNIT: "G",
            DDD_GRAMS: 0.1,
            DDD_STD: 0.1,
            NOTES: null,
        },
    ],
    combinations: [],
    conversions_iu_g: [],
    conversions_ddd_g: [],
    changes: [],
    salts: [],
    roas: [],
    units: [{ UNIT: "G", NAME: "gram" as any, UNIT_STD: "G", BASE_CONV: 1, USE_STRENGTH: true, USE_VOLUME: false }],
    am_classification: { classification: [], atc_am_mapping: [] },
    aware_classification: { classification: [], atc_awr_mapping: [] },
};

const rawSubstance = (overrides: Partial<RawSubstanceConsumptionData> = {}): RawSubstanceConsumptionData => ({
    id: "sub-001",
    atc_manual: "J01AA01",
    route_admin_manual: "O",
    salt_manual: "XXXX",
    packages_manual: 100,
    ddds_manual: 300,
    atc_version_manual: "ATC-2023-v1",
    tons_manual: undefined,
    data_status_manual: 1,
    health_sector_manual: "PUB",
    health_level_manual: "C",
    report_date: "2023-01-01",
    ...overrides,
});

const importResult = (status: TrackerImportResult["status"], uids: string[]) =>
    ({
        status,
        message: "",
        stats: { created: uids.length, updated: 0, deleted: 0, ignored: 0, total: uids.length },
        validationReport: { errorReports: [], warningReports: [] },
        bundleReport: {
            typeReportMap: {
                EVENT: { objectReports: uids.map(uid => ({ uid })) },
                TRACKED_ENTITY: { objectReports: [] },
            },
        },
    } as TrackerImportResult);

type Setup = {
    upload?: Partial<GlassUploads> | undefined;
    substanceIds?: string[];
    module?: Partial<GlassModule>;
    raw?: RawSubstanceConsumptionData[] | undefined;
    atcHistory?: { currentVersion: boolean; year: number; version: number }[];
    importResponse?: TrackerImportResult;
};

function setup(options: Setup = {}) {
    const {
        upload = { eventListFileId: "list-file" },
        substanceIds = ["sub-001"],
        module = { chunkSizes: { substanceIds: 50, importCalculations: 100 } },
        raw = [rawSubstance()],
        atcHistory = [{ currentVersion: true, year: 2023, version: 1 }],
        importResponse = importResult("OK", ["calc-1"]),
    } = options;

    const setCalculatedEventListFileId = jest.fn((_uploadId: string, _fileId: string) => Future.success(undefined));
    const save = jest.fn((_file: File, _moduleName: string) => Future.success("calculated-list-file"));
    const importCalculations = jest.fn((_params: { orgUnitId: string; chunkSize?: number }) =>
        Future.success({ response: importResponse, eventIdLineNoMap: [] })
    );
    const getRaw = jest.fn((_orgUnitId: string, _ids: string[], _chunk: number, _chunked?: boolean) =>
        Future.success(raw)
    );

    const glassUploadsRepository = {
        getById: () => Future.success(upload),
        setCalculatedEventListFileId,
    } as unknown as GlassUploadsRepository;
    const glassDocumentsRepository = {
        download: () => Future.success(nodeBlob([JSON.stringify(substanceIds)])),
        save,
    } as unknown as GlassDocumentsRepository;
    const amcSubstanceDataRepository = {
        getRawSubstanceConsumptionDataByEventsIds: getRaw,
        importCalculations,
    } as unknown as AMCSubstanceDataRepository;
    const atcRepository = {
        getAtcHistory: () => Future.success(atcHistory),
        getAtcVersion: () => Future.success(atcVersion),
    } as unknown as GlassATCRepository;
    const metadataRepository = { getD2Ids: () => Future.success([]) } as unknown as MetadataRepository;
    const glassModuleRepository = { getByName: () => Future.success(module) } as unknown as GlassModuleRepository;

    const useCase = new CalculateConsumptionDataSubstanceLevelUseCase(
        glassUploadsRepository,
        glassDocumentsRepository,
        amcSubstanceDataRepository,
        atcRepository,
        metadataRepository,
        glassModuleRepository
    );
    const run = () => useCase.execute(UPLOAD_ID, PERIOD, ORG_UNIT_ID, "AMC").runAsync();
    return { run, save, setCalculatedEventListFileId, importCalculations, getRaw };
}

describe("CalculateConsumptionDataSubstanceLevelUseCase", () => {
    beforeAll(async () => {
        await setupLoggerForTesting();
    });

    describe("stops with an error, importing nothing, when", () => {
        it("the upload has no list of substance events", async () => {
            const { run, importCalculations } = setup({ upload: {} });

            expect((await run()).error).toBe("Cannot find upload");
            expect(importCalculations).not.toHaveBeenCalled();
        });

        it("the list of substance events is empty", async () => {
            const { run, importCalculations } = setup({ substanceIds: [] });

            expect((await run()).error).toBe("Substances not found.");
            expect(importCalculations).not.toHaveBeenCalled();
        });

        it("the module has no chunk size for substance ids", async () => {
            const { run, importCalculations } = setup({ module: { chunkSizes: undefined } });

            expect((await run()).error).toBe("Cannot find substance ids chunk size.");
            expect(importCalculations).not.toHaveBeenCalled();
        });

        it("no ATC version is the current one", async () => {
            const { run, importCalculations } = setup({
                atcHistory: [{ currentVersion: false, year: 2023, version: 1 }],
            });

            expect((await run()).error).toBe("Cannot find current version of ATC in version history.");
            expect(importCalculations).not.toHaveBeenCalled();
        });
    });

    it("reads the raw substances of the org unit in the module's chunk size", async () => {
        const { run, getRaw } = setup({ substanceIds: ["sub-001", "sub-002"] });

        await run();

        expect(getRaw).toHaveBeenCalledWith(ORG_UNIT_ID, ["sub-001", "sub-002"], 50, true);
    });

    // Raw substances without an ATC code (Z99ZZ99) are left out; with nothing left there is nothing to import.
    it("returns an ERROR summary and imports nothing when there is nothing to calculate", async () => {
        const { run, importCalculations, save } = setup({
            raw: [rawSubstance({ atc_manual: CODE_PRODUCT_NOT_HAVE_ATC })],
        });

        const { data } = await run();

        expect(data).toEqual({
            status: "ERROR",
            importCount: { ignored: 0, imported: 0, deleted: 0, updated: 0, total: 0 },
            nonBlockingErrors: [],
            blockingErrors: [],
        });
        expect(importCalculations).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });

    it("imports the calculations and keeps the ids of the created events on the upload", async () => {
        const { run, importCalculations, save, setCalculatedEventListFileId } = setup();

        const { data } = await run();

        expect(importCalculations).toHaveBeenCalledTimes(1);
        expect(importCalculations.mock.calls[0]?.[0]).toMatchObject({
            importStrategy: "CREATE_AND_UPDATE",
            orgUnitId: ORG_UNIT_ID,
            chunkSize: 100,
        });
        expect(data?.status).toBe("SUCCESS");
        expect(save).toHaveBeenCalledTimes(1);
        const [file, moduleName] = save.mock.calls[0] ?? [];
        expect(file?.name).toBe(`${UPLOAD_ID}_calculatedEventListFileId`);
        expect(moduleName).toBe("AMC");
        expect(setCalculatedEventListFileId).toHaveBeenCalledWith(UPLOAD_ID, "calculated-list-file");
    });

    // DHIS2 saved the events with warnings: their ids must be kept, or deleting the upload leaves them behind.
    it("keeps the ids of events saved with warnings too", async () => {
        const { run, setCalculatedEventListFileId } = setup({ importResponse: importResult("WARNING", ["calc-1"]) });

        await run();

        expect(setCalculatedEventListFileId).toHaveBeenCalledWith(UPLOAD_ID, "calculated-list-file");
    });

    it("keeps no list when DHIS2 created no event", async () => {
        const { run, save, setCalculatedEventListFileId } = setup({ importResponse: importResult("ERROR", []) });

        const { data } = await run();

        expect(data?.status).toBe("ERROR");
        expect(save).not.toHaveBeenCalled();
        expect(setCalculatedEventListFileId).not.toHaveBeenCalled();
    });
});
