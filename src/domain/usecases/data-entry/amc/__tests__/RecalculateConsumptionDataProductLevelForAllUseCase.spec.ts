import { Future } from "../../../../entities/Future";
import { GlassAtcVersionData, CODE_PRODUCT_NOT_HAVE_ATC } from "../../../../entities/GlassAtcVersionData";
import {
    AMC_RAW_SUBSTANCE_CONSUMPTION_CALCULATED_STAGE_ID,
    AMR_GLASS_AMC_TEA_ATC,
    AMR_GLASS_AMC_TEA_PRODUCT_ID,
} from "../../../../entities/data-entry/amc/amcProgramIds";
import { ProductRegisterProgramMetadata } from "../../../../entities/data-entry/amc/ProductRegisterProgram";
import { RAW_SUBSTANCE_CONSUMPTION_CALCULATED_KEYS } from "../../../../entities/data-entry/amc/RawSubstanceConsumptionCalculated";
import { RawSubstanceConsumptionCalculated } from "../../../../entities/data-entry/amc/RawSubstanceConsumptionCalculated";
import { TrackerImportResult } from "../../../../entities/data-entry/TrackerImportResult";
import { AMCProductDataRepository } from "../../../../repositories/data-entry/AMCProductDataRepository";
import { AMCSubstanceDataRepository } from "../../../../repositories/data-entry/AMCSubstanceDataRepository";
import { setupLoggerForTesting } from "../../../../../utils/logger";
import { RecalculateConsumptionDataProductLevelForAllUseCase } from "../RecalculateConsumptionDataProductLevelForAllUseCase";
import { getConsumptionDataProductLevel } from "../utils/getConsumptionDataProductLevel";
import { mapRawSubstanceCalculatedToSubstanceCalculated } from "../utils/mapRawSubstanceCalculatedToSubstanceCalculated";
import { matchCalculatedEvents } from "../utils/matchCalculatedEvents";
import { updateRecalculatedConsumptionData } from "../utils/updateRecalculatedConsumptionData";

// Jest 27's types have no jest.mocked: the typed equivalent of Vitest's vi.mocked.
const mocked = <T extends (...args: any[]) => any>(fn: T) => fn as jest.MockedFunction<T>;

// The calculation, the matching of stored events and the substance-level update have their own specs; here they are
// replaced, to test what this use case does with their results: what is imported, and above all what is deleted.
jest.mock("../utils/getConsumptionDataProductLevel", () => ({ getConsumptionDataProductLevel: jest.fn() }));
jest.mock("../utils/matchCalculatedEvents", () => ({ matchCalculatedEvents: jest.fn() }));
jest.mock("../utils/mapRawSubstanceCalculatedToSubstanceCalculated", () => ({
    mapRawSubstanceCalculatedToSubstanceCalculated: jest.fn(),
}));
jest.mock("../utils/updateRecalculatedConsumptionData", () => ({ updateRecalculatedConsumptionData: jest.fn() }));

const ORG_UNIT_ID = "orgUnit1";
const PERIOD = "2023";
const CHUNK_SIZE = 100;
const remapAtc = (atc: string) => atc;

const KEY = RAW_SUBSTANCE_CONSUMPTION_CALCULATED_KEYS[0] as string;
const metadata = {
    programStages: [
        {
            id: AMC_RAW_SUBSTANCE_CONSUMPTION_CALCULATED_STAGE_ID,
            dataElements: [{ id: "de-key", code: KEY, valueType: "TEXT", optionSetValue: false }],
        },
    ],
} as unknown as ProductRegisterProgramMetadata;

/** A product with one stored calculated event per given event id. */
const product = (productId: string, eventIds: string[], atc = "J01AA01") => ({
    attributes: [
        { id: AMR_GLASS_AMC_TEA_PRODUCT_ID, value: productId },
        { id: AMR_GLASS_AMC_TEA_ATC, value: atc },
    ],
    events: eventIds.map(eventId => ({ eventId, dataValues: [{ id: "de-key", value: "x" }] })),
});

const row = (eventId?: string) => ({ eventId } as unknown as RawSubstanceConsumptionCalculated);

const importResult = (status: TrackerImportResult["status"]) =>
    ({
        status,
        message: "",
        stats: { created: 0, updated: 1, deleted: 0, ignored: 0, total: 1 },
        validationReport: { errorReports: [], warningReports: [] },
    } as unknown as TrackerImportResult);

type Setup = {
    products?: ReturnType<typeof product>[];
    newCalculated?: RawSubstanceConsumptionCalculated[];
    toUpdate?: RawSubstanceConsumptionCalculated[];
    toCreate?: RawSubstanceConsumptionCalculated[];
    importStatus?: TrackerImportResult["status"];
    program?: ProductRegisterProgramMetadata;
};

function setup(options: Setup = {}) {
    const {
        products = [product("p1", ["ev-1", "ev-2"])],
        newCalculated = [row()],
        toUpdate = [row("ev-1")],
        toCreate = [],
        importStatus = "OK",
        program = metadata,
    } = options;

    mocked(getConsumptionDataProductLevel).mockReset();
    mocked(getConsumptionDataProductLevel).mockReturnValue(Future.success(newCalculated));
    mocked(matchCalculatedEvents).mockReset();
    mocked(matchCalculatedEvents).mockReturnValue({
        withEventId: toUpdate,
        withoutEventId: toCreate,
        remapMatches: 0,
    });
    mocked(mapRawSubstanceCalculatedToSubstanceCalculated).mockReset();
    mocked(mapRawSubstanceCalculatedToSubstanceCalculated).mockReturnValue([]);
    mocked(updateRecalculatedConsumptionData).mockReset();
    mocked(updateRecalculatedConsumptionData).mockReturnValue(Future.success(undefined));

    const importCalculations = jest.fn(
        (_params: { importStrategy: string; rawSubstanceConsumptionCalculatedData: unknown[] }) =>
            Future.success(importResult(importStatus))
    );
    const deleteEvents = jest.fn((_ids: string[], _chunk: number | undefined) =>
        Future.success({ ...importResult("OK"), stats: { created: 0, updated: 0, deleted: 1, ignored: 0, total: 1 } })
    );
    const getCalculatedSubstances = jest.fn((_orgUnitId: string, _period: string) => Future.success([]));

    const useCase = new RecalculateConsumptionDataProductLevelForAllUseCase(
        {
            getAllProductRegisterAndRawProductConsumptionByPeriod: () => Future.success(products),
            importCalculations,
            deleteRawSubstanceConsumptionCalculatedById: deleteEvents,
        } as unknown as AMCProductDataRepository,
        {
            getAllCalculatedSubstanceConsumptionDataByByPeriod: getCalculatedSubstances,
        } as unknown as AMCSubstanceDataRepository
    );
    const run = (allowCreationIfNotExist: boolean) =>
        useCase
            .calculateByOrgUnitAndPeriod(
                program,
                ORG_UNIT_ID,
                PERIOD,
                {} as GlassAtcVersionData,
                "ATC-2023-v1",
                allowCreationIfNotExist,
                CHUNK_SIZE,
                remapAtc
            )
            .runAsync();
    return { run, importCalculations, deleteEvents, getCalculatedSubstances };
}

describe("RecalculateConsumptionDataProductLevelForAllUseCase.calculateByOrgUnitAndPeriod", () => {
    beforeAll(async () => {
        await setupLoggerForTesting();
    });

    describe("does nothing, deleting nothing, when", () => {
        it("the org unit and period have no products", async () => {
            const { run, importCalculations, deleteEvents } = setup({ products: [] });

            expect((await run(true)).data).toEqual({ hadSourceData: false });
            expect(importCalculations).not.toHaveBeenCalled();
            expect(deleteEvents).not.toHaveBeenCalled();
        });

        it("creation is not allowed and no calculated events are stored yet", async () => {
            const { run, importCalculations, deleteEvents } = setup({ products: [product("p1", [])] });

            expect((await run(false)).data).toEqual({ hadSourceData: true });
            expect(mocked(getConsumptionDataProductLevel)).not.toHaveBeenCalled();
            expect(importCalculations).not.toHaveBeenCalled();
            expect(deleteEvents).not.toHaveBeenCalled();
        });

        it("the new calculation gives nothing", async () => {
            const { run, importCalculations, deleteEvents } = setup({ newCalculated: [] });

            expect((await run(true)).data).toEqual({ hadSourceData: true });
            expect(importCalculations).not.toHaveBeenCalled();
            expect(deleteEvents).not.toHaveBeenCalled();
        });
    });

    it("stops with an error when the program has no stage for the calculated consumption", async () => {
        const { run, importCalculations, deleteEvents } = setup({
            program: { programStages: [] } as unknown as ProductRegisterProgramMetadata,
        });

        expect((await run(true)).error).toBe("Cannot find Raw Substance Consumption Calculated program stage metadata");
        expect(importCalculations).not.toHaveBeenCalled();
        expect(deleteEvents).not.toHaveBeenCalled();
    });

    it("leaves products without an ATC code out of the calculation", async () => {
        const withAtc = product("p1", ["ev-1"]);
        const withoutAtc = product("p2", ["ev-2"], CODE_PRODUCT_NOT_HAVE_ATC);
        const { run } = setup({ products: [withoutAtc, withAtc] });

        await run(true);

        expect(mocked(getConsumptionDataProductLevel).mock.calls[0]?.[0].productDataTrackedEntities).toEqual([withAtc]);
    });

    describe("when creation is not allowed (update only)", () => {
        it("updates the matched events and deletes the stored events that were not recalculated", async () => {
            const { run, importCalculations, deleteEvents } = setup({ toUpdate: [row("ev-1")], toCreate: [] });

            await run(false);

            expect(importCalculations.mock.calls[0]?.[0]).toMatchObject({
                importStrategy: "UPDATE",
                rawSubstanceConsumptionCalculatedData: [row("ev-1")],
            });
            expect(deleteEvents).toHaveBeenCalledWith(["ev-2"], CHUNK_SIZE);
        });

        // Rows that would need creating are dropped, so deleting their stored events would lose them for good.
        it("deletes nothing when some recalculated rows could not be created", async () => {
            const { run, importCalculations, deleteEvents } = setup({ toUpdate: [row("ev-1")], toCreate: [row()] });

            await run(false);

            expect(importCalculations.mock.calls[0]?.[0]).toMatchObject({
                importStrategy: "UPDATE",
                rawSubstanceConsumptionCalculatedData: [row("ev-1")],
            });
            expect(deleteEvents).not.toHaveBeenCalled();
        });
    });

    describe("when creation is allowed", () => {
        it("imports the matched and the new rows and deletes the stored events that were not recalculated", async () => {
            const { run, importCalculations, deleteEvents } = setup({ toUpdate: [row("ev-1")], toCreate: [row()] });

            await run(true);

            expect(importCalculations.mock.calls[0]?.[0]).toMatchObject({
                importStrategy: "CREATE_AND_UPDATE",
                rawSubstanceConsumptionCalculatedData: [row("ev-1"), row()],
            });
            expect(deleteEvents).toHaveBeenCalledWith(["ev-2"], CHUNK_SIZE);
        });

        it("deletes nothing when every stored event was recalculated", async () => {
            const { run, deleteEvents } = setup({ toUpdate: [row("ev-1"), row("ev-2")] });

            await run(true);

            expect(deleteEvents).not.toHaveBeenCalled();
        });
    });

    describe("the substance-level totals", () => {
        it("are updated after an OK import", async () => {
            const { run, getCalculatedSubstances } = setup({ importStatus: "OK" });

            await run(true);

            expect(getCalculatedSubstances).toHaveBeenCalledWith(ORG_UNIT_ID, PERIOD);
            expect(mocked(updateRecalculatedConsumptionData)).toHaveBeenCalledTimes(1);
        });

        // Current behaviour, recorded on purpose: events saved with warnings still update the totals.
        it("are updated after an import with warnings", async () => {
            const { run } = setup({ importStatus: "WARNING" });

            await run(true);

            expect(mocked(updateRecalculatedConsumptionData)).toHaveBeenCalledTimes(1);
        });

        it("are not touched after a failed import", async () => {
            const { run } = setup({ importStatus: "ERROR" });

            await run(true);

            expect(mocked(updateRecalculatedConsumptionData)).not.toHaveBeenCalled();
        });
    });

    // Current behaviour, recorded on purpose and a finding for review: the stored events that were not recalculated are
    // deleted before the result of the import is looked at, so a failed import still deletes them and nothing replaces them.
    it("deletes the events that were not recalculated even when the import of the recalculated ones failed", async () => {
        const { run, deleteEvents } = setup({ importStatus: "ERROR" });

        await run(true);

        expect(deleteEvents).toHaveBeenCalledWith(["ev-2"], CHUNK_SIZE);
    });
});
