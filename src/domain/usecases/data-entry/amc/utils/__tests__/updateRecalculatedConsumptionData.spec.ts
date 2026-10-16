import { vi } from "vitest";
import { Future } from "../../../../../entities/Future";
import { SubstanceConsumptionCalculated } from "../../../../../entities/data-entry/amc/SubstanceConsumptionCalculated";
import { TrackerImportResult } from "../../../../../entities/data-entry/TrackerImportResult";
import { AMCSubstanceDataRepository } from "../../../../../repositories/data-entry/AMCSubstanceDataRepository";
import { setupLoggerForTesting } from "../../../../../../utils/logger";
import { updateRecalculatedConsumptionData } from "../updateRecalculatedConsumptionData";

/*
 * Recalculating AMC data replaces the stored calculated events. Stored events the recalculation does not
 * match are deleted, so these tests pin down exactly when that may and may not happen.
 */

const okResult = (overrides: Partial<TrackerImportResult["stats"]> = {}): TrackerImportResult =>
    ({
        status: "OK",
        message: "",
        stats: { created: 0, updated: 0, deleted: 0, ignored: 0, total: 0, ...overrides },
        validationReport: { errorReports: [], warningReports: [] },
        bundleReport: { typeReportMap: { EVENT: { objectReports: [] }, TRACKED_ENTITY: { objectReports: [] } } },
    } as TrackerImportResult);

function row(atc: string, overrides: Partial<SubstanceConsumptionCalculated> = {}): SubstanceConsumptionCalculated {
    return {
        atc_autocalculated: atc,
        route_admin_autocalculated: "O",
        salt_autocalculated: "XXXX",
        combination_code_autocalculated: undefined,
        packages_autocalculated: 10,
        ddds_autocalculated: 100,
        atc_version_autocalculated: "ATC-2025-v1",
        kilograms_autocalculated: 1,
        data_status_autocalculated: 1,
        health_sector_autocalculated: "1",
        health_level_autocalculated: "1",
        am_class: undefined,
        atc2: undefined,
        atc3: undefined,
        atc4: undefined,
        aware: undefined,
        period: "2024",
        orgUnitId: "MLT",
        report_date: "2024-01-01",
        ...overrides,
    };
}

const stored = (atc: string, eventId: string) => row(atc, { eventId });

type ImportCalculationsParams = Parameters<AMCSubstanceDataRepository["importCalculations"]>[0];

function setup() {
    const importCalculations = vi.fn((_params: ImportCalculationsParams) =>
        Future.success({ response: okResult({ updated: 1, total: 1 }), eventIdLineNoMap: [] })
    );
    const deleteCalculatedSubstanceConsumptionDataById = vi.fn(() =>
        Future.success(okResult({ deleted: 1, total: 1 }))
    );
    const repository = {
        importCalculations,
        deleteCalculatedSubstanceConsumptionDataById,
    } as unknown as AMCSubstanceDataRepository;

    const run = (params: {
        next: SubstanceConsumptionCalculated[];
        current?: SubstanceConsumptionCalculated[];
        allowCreation: boolean;
        preserveUnmatched?: boolean;
        remap?: (atc: string) => string;
    }) =>
        updateRecalculatedConsumptionData(
            "MLT",
            "2024",
            params.next,
            params.current,
            repository,
            params.allowCreation,
            500,
            params.remap ?? (atc => atc),
            params.preserveUnmatched
        ).toPromise();

    return { run, importCalculations, deleteCalculatedSubstanceConsumptionDataById };
}

describe("updateRecalculatedConsumptionData", () => {
    beforeAll(async () => await setupLoggerForTesting());

    it("updates the matching stored events and deletes nothing when every stored event was recalculated", async () => {
        const { run, importCalculations, deleteCalculatedSubstanceConsumptionDataById } = setup();

        await run({ next: [row("J01CA04")], current: [stored("J01CA04", "evt1")], allowCreation: false });

        expect(importCalculations).toHaveBeenCalledWith({
            importStrategy: "UPDATE",
            orgUnitId: "MLT",
            calculatedConsumptionSubstanceLevelData: [
                expect.objectContaining({ atc_autocalculated: "J01CA04", eventId: "evt1" }),
            ],
            chunkSize: 500,
        });
        expect(deleteCalculatedSubstanceConsumptionDataById).not.toHaveBeenCalled();
    });

    describe("update only (no creation allowed)", () => {
        it("sends only the rows that have a stored event, and deletes stored events with no new row when nothing needed creating", async () => {
            const { run, importCalculations, deleteCalculatedSubstanceConsumptionDataById } = setup();

            await run({
                next: [row("J01CA04")],
                current: [stored("J01CA04", "evt1"), stored("J01XX08", "evt2")],
                allowCreation: false,
            });

            expect(importCalculations.mock.calls[0]?.[0].calculatedConsumptionSubstanceLevelData).toHaveLength(1);
            expect(deleteCalculatedSubstanceConsumptionDataById).toHaveBeenCalledWith(["evt2"], 500);
        });

        it("does NOT delete stale events while some recalculated rows could not be written (they would be lost with no replacement)", async () => {
            const { run, deleteCalculatedSubstanceConsumptionDataById } = setup();

            await run({
                next: [row("J01CA04"), row("J01XX08")],
                current: [stored("J01CA04", "evt1"), stored("J01OLD01", "evt-old")],
                allowCreation: false,
            });

            expect(deleteCalculatedSubstanceConsumptionDataById).not.toHaveBeenCalled();
        });
    });

    describe("with creation allowed", () => {
        it("creates the new rows and updates the existing ones in one import", async () => {
            const { run, importCalculations } = setup();

            await run({
                next: [row("J01CA04"), row("J01XX08")],
                current: [stored("J01CA04", "evt1")],
                allowCreation: true,
            });

            const call = importCalculations.mock.calls[0]?.[0];
            expect(call?.importStrategy).toBe("CREATE_AND_UPDATE");
            expect(call?.calculatedConsumptionSubstanceLevelData.map(r => [r.atc_autocalculated, r.eventId])).toEqual([
                ["J01CA04", "evt1"],
                ["J01XX08", undefined],
            ]);
        });

        it("deletes stored events that no new row replaces", async () => {
            const { run, deleteCalculatedSubstanceConsumptionDataById } = setup();

            await run({
                next: [row("J01CA04")],
                current: [stored("J01CA04", "evt1"), stored("J01OLD01", "evt-old")],
                allowCreation: true,
            });

            expect(deleteCalculatedSubstanceConsumptionDataById).toHaveBeenCalledWith(["evt-old"], 500);
        });
    });

    it("never deletes unmatched events when another calculation wrote them (preserveUnmatchedEvents)", async () => {
        const { run, deleteCalculatedSubstanceConsumptionDataById } = setup();

        await run({
            next: [row("J01CA04")],
            current: [stored("J01CA04", "evt1"), stored("J01OLD01", "evt-product-level")],
            allowCreation: true,
            preserveUnmatched: true,
        });

        expect(deleteCalculatedSubstanceConsumptionDataById).not.toHaveBeenCalled();
    });

    it("keeps the stored event of a code that the new ATC version replaced, and updates it with the new code", async () => {
        const { run, importCalculations, deleteCalculatedSubstanceConsumptionDataById } = setup();

        await run({
            next: [row("J01XX08")],
            current: [stored("J01AA99", "evt-old-code")],
            allowCreation: false,
            remap: atc => (atc === "J01AA99" ? "J01XX08" : atc),
        });

        expect(importCalculations.mock.calls[0]?.[0].calculatedConsumptionSubstanceLevelData).toEqual([
            expect.objectContaining({ atc_autocalculated: "J01XX08", eventId: "evt-old-code" }),
        ]);
        expect(deleteCalculatedSubstanceConsumptionDataById).not.toHaveBeenCalled();
    });

    it("works when nothing is stored yet", async () => {
        const { run, importCalculations, deleteCalculatedSubstanceConsumptionDataById } = setup();

        await run({ next: [row("J01CA04")], current: undefined, allowCreation: true });

        expect(importCalculations.mock.calls[0]?.[0].calculatedConsumptionSubstanceLevelData).toHaveLength(1);
        expect(deleteCalculatedSubstanceConsumptionDataById).not.toHaveBeenCalled();
    });

    it("does not delete events twice when the stored list repeats an id that was updated", async () => {
        const { run, deleteCalculatedSubstanceConsumptionDataById } = setup();

        await run({
            next: [row("J01CA04")],
            current: [stored("J01CA04", "evt1"), stored("J01CA04", "evt1")],
            allowCreation: true,
        });

        expect(deleteCalculatedSubstanceConsumptionDataById).not.toHaveBeenCalled();
    });
});
