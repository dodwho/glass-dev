import { vi } from "vitest";
import { Future } from "../../../../entities/Future";
import {
    CODE_PRODUCT_NOT_HAVE_ATC,
    COMB_CODE_PRODUCT_NOT_HAVE_ATC,
    GlassAtcVersionData,
} from "../../../../entities/GlassAtcVersionData";
import { GlassModule } from "../../../../entities/GlassModule";
import { GlassUploads } from "../../../../entities/GlassUploads";
import {
    AMC_RAW_SUBSTANCE_CONSUMPTION_CALCULATED_STAGE_ID,
    AMR_GLASS_AMC_TEA_ATC,
    AMR_GLASS_AMC_TEA_COMBINATION,
} from "../../../../entities/data-entry/amc/amcProgramIds";
import { RawSubstanceConsumptionCalculated } from "../../../../entities/data-entry/amc/RawSubstanceConsumptionCalculated";
import { SubstanceConsumptionCalculated } from "../../../../entities/data-entry/amc/SubstanceConsumptionCalculated";
import { TrackerImportResult } from "../../../../entities/data-entry/TrackerImportResult";
import { ExcelRepository } from "../../../../repositories/ExcelRepository";
import { GlassATCRepository } from "../../../../repositories/GlassATCRepository";
import { GlassDocumentsRepository } from "../../../../repositories/GlassDocumentsRepository";
import { GlassModuleRepository } from "../../../../repositories/GlassModuleRepository";
import { GlassUploadsRepository } from "../../../../repositories/GlassUploadsRepository";
import { InstanceRepository } from "../../../../repositories/InstanceRepository";
import { MetadataRepository } from "../../../../repositories/MetadataRepository";
import { AMCProductDataRepository } from "../../../../repositories/data-entry/AMCProductDataRepository";
import { AMCSubstanceDataRepository } from "../../../../repositories/data-entry/AMCSubstanceDataRepository";
import { setupLoggerForTesting } from "../../../../../utils/logger";
import { CalculateConsumptionDataProductLevelUseCase } from "../CalculateConsumptionDataProductLevelUseCase";
import { getConsumptionDataProductLevel } from "../utils/getConsumptionDataProductLevel";
import { mapRawSubstanceCalculatedToSubstanceCalculated } from "../utils/mapRawSubstanceCalculatedToSubstanceCalculated";

// The calculations themselves are tested on their own (calculationConsumptionProductLevelData.spec.ts and
// mapRawSubstanceCalculatedToSubstanceCalculated.spec.ts); here they are replaced, to test the steps around them.
vi.mock("../utils/getConsumptionDataProductLevel", () => ({ getConsumptionDataProductLevel: vi.fn() }));
vi.mock("../utils/mapRawSubstanceCalculatedToSubstanceCalculated", () => ({
    mapRawSubstanceCalculatedToSubstanceCalculated: vi.fn(),
}));

const UPLOAD_ID = "upload0001";
const ORG_UNIT_ID = "orgUnit1";
const PERIOD = "2023";

const trackedEntity = (atc: string, combination = "") => ({
    id: `te-${atc}-${combination}`,
    attributes: [
        { id: AMR_GLASS_AMC_TEA_ATC, value: atc },
        { id: AMR_GLASS_AMC_TEA_COMBINATION, value: combination },
    ],
});

const calculatedStage = { id: AMC_RAW_SUBSTANCE_CONSUMPTION_CALCULATED_STAGE_ID };
const rawCalculated = [{ id: "calc-1" }] as unknown as RawSubstanceConsumptionCalculated[];
const substanceCalculated = [{ id: "sub-calc-1" }] as unknown as SubstanceConsumptionCalculated[];

const result = (status: TrackerImportResult["status"], uids: string[]) =>
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
    upload?: Partial<GlassUploads>;
    productIds?: string[];
    module?: Partial<GlassModule>;
    products?: ReturnType<typeof trackedEntity>[];
    atcHistory?: { currentVersion: boolean; year: number; version: number }[];
    metadata?: { programStages: { id: string }[] } | undefined;
    calculated?: RawSubstanceConsumptionCalculated[];
    productResponse?: TrackerImportResult;
    substanceResponse?: TrackerImportResult;
};

function setup(options: Setup = {}) {
    const {
        upload = { eventListFileId: "list-file" },
        productIds = ["product-1"],
        module = { chunkSizes: { productIds: 25, importCalculations: 100 } },
        products = [trackedEntity("J01AA01")],
        atcHistory = [{ currentVersion: true, year: 2023, version: 1 }],
        metadata = { programStages: [calculatedStage] },
        calculated = rawCalculated,
        productResponse = result("OK", ["product-calc-1", "product-calc-2"]),
        substanceResponse = result("OK", ["substance-calc-1"]),
    } = options;

    vi.mocked(getConsumptionDataProductLevel).mockReset();
    vi.mocked(getConsumptionDataProductLevel).mockReturnValue(Future.success(calculated));
    vi.mocked(mapRawSubstanceCalculatedToSubstanceCalculated).mockReset();
    vi.mocked(mapRawSubstanceCalculatedToSubstanceCalculated).mockReturnValue(substanceCalculated);

    const save = vi.fn((_file: File, _moduleName: string) => Future.success("calculated-list-file"));
    const setCalculatedEventListFileId = vi.fn((_uploadId: string, _fileId: string) => Future.success(undefined));
    const importProducts = vi.fn((_params: { orgUnitId: string; period: string; chunkSize?: number }) =>
        Future.success(productResponse)
    );
    const importSubstances = vi.fn((_params: { orgUnitId: string; chunkSize?: number }) =>
        Future.success({ response: substanceResponse, eventIdLineNoMap: [] })
    );
    const getProducts = vi.fn(
        (_orgUnitId: string, _ids: string[], _period: string, _chunk: number, _chunked?: boolean) =>
            Future.success(products)
    );

    const useCase = new CalculateConsumptionDataProductLevelUseCase(
        {} as ExcelRepository,
        {} as InstanceRepository,
        {
            getProductRegisterProgramMetadata: () => Future.success(metadata),
            getProductRegisterAndRawProductConsumptionByProductIds: getProducts,
            importCalculations: importProducts,
        } as unknown as AMCProductDataRepository,
        {
            getAtcHistory: () => Future.success(atcHistory),
            getAtcVersion: () => Future.success({} as GlassAtcVersionData),
        } as unknown as GlassATCRepository,
        { getD2Ids: () => Future.success([]) } as unknown as MetadataRepository,
        { getByName: () => Future.success(module) } as unknown as GlassModuleRepository,
        { importCalculations: importSubstances } as unknown as AMCSubstanceDataRepository,
        { getById: () => Future.success(upload), setCalculatedEventListFileId } as unknown as GlassUploadsRepository,
        {
            download: () => Future.success(new Blob([JSON.stringify(productIds)])),
            save,
        } as unknown as GlassDocumentsRepository
    );
    const run = () => useCase.execute(PERIOD, ORG_UNIT_ID, "AMC", UPLOAD_ID).runAsync();
    return { run, save, setCalculatedEventListFileId, importProducts, importSubstances, getProducts };
}

describe("CalculateConsumptionDataProductLevelUseCase", () => {
    beforeAll(async () => {
        await setupLoggerForTesting();
    });

    describe("stops with an error, importing nothing, when", () => {
        it("the upload has no list of products", async () => {
            const { run, importProducts, importSubstances } = setup({ upload: {} });

            expect((await run()).error).toBe("Cannot find upload");
            expect(importProducts).not.toHaveBeenCalled();
            expect(importSubstances).not.toHaveBeenCalled();
        });

        it("the list of products is empty", async () => {
            const { run, importProducts } = setup({ productIds: [] });

            expect((await run()).error).toBe("Products not found.");
            expect(importProducts).not.toHaveBeenCalled();
        });

        it("the module has no chunk size for product ids", async () => {
            const { run, importProducts } = setup({ module: { chunkSizes: undefined } });

            expect((await run()).error).toBe("Cannot find product ids chunk size.");
            expect(importProducts).not.toHaveBeenCalled();
        });

        it("no ATC version is the current one", async () => {
            const { run, importProducts } = setup({ atcHistory: [{ currentVersion: false, year: 2023, version: 1 }] });

            expect((await run()).error).toBe("Cannot find current version of ATC in version history.");
            expect(importProducts).not.toHaveBeenCalled();
        });

        it("the program metadata has no stage for the calculated consumption", async () => {
            const { run, importProducts } = setup({ metadata: { programStages: [{ id: "another-stage" }] } });

            expect((await run()).error).toBe("Cannot find Raw Substance Consumption Calculated program stage metadata");
            expect(importProducts).not.toHaveBeenCalled();
        });
    });

    it("reads the products of the org unit and period in the module's chunk size", async () => {
        const { run, getProducts } = setup({ productIds: ["product-1", "product-2"] });

        await run();

        expect(getProducts).toHaveBeenCalledWith(ORG_UNIT_ID, ["product-1", "product-2"], PERIOD, 25, true);
    });

    it("leaves products without an ATC code or combination code out of the calculation and the import", async () => {
        const valid = trackedEntity("J01AA01");
        const noAtc = trackedEntity(CODE_PRODUCT_NOT_HAVE_ATC);
        const noCombination = trackedEntity("J01AA01", COMB_CODE_PRODUCT_NOT_HAVE_ATC);
        const { run, importProducts } = setup({ products: [noAtc, valid, noCombination] });

        await run();

        const calculationInput = vi.mocked(getConsumptionDataProductLevel).mock.calls[0]?.[0];
        expect(calculationInput?.productDataTrackedEntities).toEqual([valid]);
        expect(importProducts.mock.calls[0]?.[0]).toMatchObject({ productDataTrackedEntities: [valid] });
    });

    it("returns an ERROR summary and imports nothing when there is nothing to calculate", async () => {
        const { run, importProducts, importSubstances, save } = setup({ calculated: [] });

        const { data } = await run();

        expect(data).toEqual({
            status: "ERROR",
            importCount: { ignored: 0, imported: 0, deleted: 0, updated: 0, total: 0 },
            nonBlockingErrors: [],
            blockingErrors: [],
        });
        expect(importProducts).not.toHaveBeenCalled();
        expect(importSubstances).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });

    it("imports the product calculations, then the substance totals, and keeps the substance event ids on the upload", async () => {
        const { run, importProducts, importSubstances, save, setCalculatedEventListFileId } = setup();

        const { data } = await run();

        expect(importProducts.mock.calls[0]?.[0]).toMatchObject({
            importStrategy: "CREATE_AND_UPDATE",
            orgUnitId: ORG_UNIT_ID,
            period: PERIOD,
            chunkSize: 100,
            rawSubstanceConsumptionCalculatedData: rawCalculated,
            rawSubstanceConsumptionCalculatedStageMetadata: calculatedStage,
        });
        expect(vi.mocked(mapRawSubstanceCalculatedToSubstanceCalculated)).toHaveBeenCalledWith(rawCalculated, PERIOD);
        expect(importSubstances.mock.calls[0]?.[0]).toMatchObject({
            orgUnitId: ORG_UNIT_ID,
            calculatedConsumptionSubstanceLevelData: substanceCalculated,
            chunkSize: 100,
        });
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0]?.[0].name).toBe(`${UPLOAD_ID}_calculatedEventListFileId`);
        expect(setCalculatedEventListFileId).toHaveBeenCalledWith(UPLOAD_ID, "calculated-list-file");
        // The summary adds the events created for products (2) and for substances (1).
        expect(data?.status).toBe("SUCCESS");
        expect(data?.importCount).toMatchObject({ total: 3 });
    });

    // Current behaviour, recorded on purpose: a WARNING from the product import (events saved with warnings) goes on to
    // import the substance totals like an OK does.
    it("goes on to the substance totals when the product import has warnings", async () => {
        const { run, importSubstances } = setup({ productResponse: result("WARNING", ["product-calc-1"]) });

        await run();

        expect(importSubstances).toHaveBeenCalledTimes(1);
    });

    it("does not import the substance totals when the product import fails, and keeps no list", async () => {
        const { run, importSubstances, save, setCalculatedEventListFileId } = setup({
            productResponse: result("ERROR", []),
        });

        const { data } = await run();

        expect(data?.status).toBe("ERROR");
        expect(importSubstances).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
        expect(setCalculatedEventListFileId).not.toHaveBeenCalled();
    });
});
