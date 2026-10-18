import { Future } from "../../../../entities/Future";
import { ImportSummary } from "../../../../entities/data-entry/ImportSummary";
import { TrackerImportResult } from "../../../../entities/data-entry/TrackerImportResult";
import { ExcelRepository } from "../../../../repositories/ExcelRepository";
import { GlassATCRepository } from "../../../../repositories/GlassATCRepository";
import { GlassDocumentsRepository } from "../../../../repositories/GlassDocumentsRepository";
import { GlassUploadsRepository } from "../../../../repositories/GlassUploadsRepository";
import { InstanceRepository } from "../../../../repositories/InstanceRepository";
import { MetadataRepository } from "../../../../repositories/MetadataRepository";
import { TrackerRepository } from "../../../../repositories/TrackerRepository";
import { AMCProductDataRepository } from "../../../../repositories/data-entry/AMCProductDataRepository";
import { AMCSubstanceDataRepository } from "../../../../repositories/data-entry/AMCSubstanceDataRepository";
import { ProgramRulesMetadataRepository } from "../../../../repositories/program-rules/ProgramRulesMetadataRepository";
import { downloadIdsAndDeleteTrackedEntities } from "../../utils/downloadIdsAndDeleteTrackedEntities";
import { ImportAMCProductLevelData } from "../ImportAMCProductLevelData";
import * as ImportBLTemplateEventProgram from "../../ImportBLTemplateEventProgram";
import { readTemplate } from "../../ImportBLTemplateEventProgram";

// Jest 27's types have no jest.mocked: the typed equivalent of Vitest's vi.mocked.
const mocked = <T extends (...args: any[]) => any>(fn: T) => fn as jest.MockedFunction<T>;

// Reading the Excel template and deleting the product tracked entities have their own code and tests; here they are
// replaced, to test what this use case does around them.
jest.mock("../../utils/downloadIdsAndDeleteTrackedEntities", () => ({
    downloadIdsAndDeleteTrackedEntities: jest.fn(),
}));
// A spy rather than a partial module mock: that module is part of an import cycle, which Jest's requireActual breaks.
jest.spyOn(ImportBLTemplateEventProgram, "readTemplate");

const summary = (
    status: ImportSummary["status"],
    deleted: number,
    extra: Partial<ImportSummary> = {}
): ImportSummary => ({
    status,
    importCount: { imported: 0, updated: 0, ignored: 0, deleted, total: deleted },
    nonBlockingErrors: [],
    blockingErrors: [],
    ...extra,
});

const substanceDeleteResult = (status: TrackerImportResult["status"], deleted: number) =>
    ({
        status,
        message: "",
        stats: { created: 0, updated: 0, deleted, ignored: 0, total: deleted },
        validationReport: { errorReports: [], warningReports: [] },
        bundleReport: { typeReportMap: { EVENT: { objectReports: [] }, TRACKED_ENTITY: { objectReports: [] } } },
    } as TrackerImportResult);

function setup(options: { integrityErrors?: { error: string; count: number }[]; productDelete?: ImportSummary } = {}) {
    const { integrityErrors = [], productDelete = summary("SUCCESS", 3) } = options;

    mocked(downloadIdsAndDeleteTrackedEntities).mockReset();
    mocked(downloadIdsAndDeleteTrackedEntities).mockReturnValue(Future.success(productDelete));
    mocked(readTemplate).mockReset();
    mocked(readTemplate).mockReturnValue(Future.success({ type: "trackerPrograms" } as never));

    const loadTemplate = jest.fn((_buffer: ArrayBuffer, _programId: string) => Future.success("template"));
    const deleteCalculated = jest.fn((_ids: string[]) => Future.success(substanceDeleteResult("OK", 2)));
    const trackerImport = jest.fn(() => Future.success({} as TrackerImportResult));

    const useCase = new ImportAMCProductLevelData(
        { loadTemplateFromArrayBuffer: loadTemplate } as unknown as ExcelRepository,
        { getProgram: () => Future.success({}) } as unknown as InstanceRepository,
        { import: trackerImport } as unknown as TrackerRepository,
        {
            download: () => Future.success(new Blob([JSON.stringify(["calc-1", "calc-2"])])),
        } as unknown as GlassDocumentsRepository,
        {} as GlassUploadsRepository,
        { getD2Ids: () => Future.success([]) } as unknown as MetadataRepository,
        {} as ProgramRulesMetadataRepository,
        {} as GlassATCRepository,
        {
            checkTeiIdIntegrityFromArrayBuffer: () => Future.success(integrityErrors),
        } as unknown as AMCProductDataRepository,
        { deleteCalculatedSubstanceConsumptionDataById: deleteCalculated } as unknown as AMCSubstanceDataRepository
    );
    const run = (action: "CREATE_AND_UPDATE" | "DELETE", calculatedEventListFileId?: string) =>
        useCase
            .importAMCProductFileAsBuffer(
                new ArrayBuffer(8),
                action,
                "event-list-file",
                "orgUnit1",
                "Korea",
                "AMC",
                "2023",
                "upload0001",
                [],
                calculatedEventListFileId
            )
            .runAsync();
    return { run, loadTemplate, deleteCalculated, trackerImport };
}

describe("ImportAMCProductLevelData.importAMCProductFileAsBuffer", () => {
    it("returns the problems with the product ids in the file as blocking errors, reading and sending nothing", async () => {
        const integrityErrors = [{ error: "Product id is blank", count: 2 }];
        const { run, loadTemplate, trackerImport } = setup({ integrityErrors });

        const { data } = await run("CREATE_AND_UPDATE");

        expect(data).toEqual(summary("ERROR", 0, { blockingErrors: integrityErrors }));
        expect(loadTemplate).not.toHaveBeenCalled();
        expect(trackerImport).not.toHaveBeenCalled();
    });

    describe("when deleting", () => {
        // The ids of the file are only a check for imports: a deletion works from the saved list of event ids.
        it("does not check the ids of the file", async () => {
            const { run } = setup({ integrityErrors: [{ error: "Product id is blank", count: 2 }] });

            const { data } = await run("DELETE");

            expect(data?.status).toBe("SUCCESS");
        });

        it("also deletes the calculated substance events of the upload and adds up the counts", async () => {
            const { run, deleteCalculated } = setup({ productDelete: summary("SUCCESS", 3) });

            const { data } = await run("DELETE", "calculated-list-file");

            expect(deleteCalculated).toHaveBeenCalledWith(["calc-1", "calc-2"]);
            expect(data?.importCount).toMatchObject({ deleted: 5, total: 5 });
        });

        it("also deletes the calculated substance events when the product deletion had warnings", async () => {
            const { run, deleteCalculated } = setup({ productDelete: summary("WARNING", 3) });

            await run("DELETE", "calculated-list-file");

            expect(deleteCalculated).toHaveBeenCalledTimes(1);
        });

        it("keeps the calculated substance events when the product deletion failed", async () => {
            const productDelete = summary("ERROR", 0, { blockingErrors: [{ error: "Could not delete", count: 1 }] });
            const { run, deleteCalculated } = setup({ productDelete });

            const { data } = await run("DELETE", "calculated-list-file");

            expect(deleteCalculated).not.toHaveBeenCalled();
            expect(data).toEqual(productDelete);
        });

        it("deletes no calculated substance events when the upload has none", async () => {
            const { run, deleteCalculated } = setup();

            await run("DELETE");

            expect(deleteCalculated).not.toHaveBeenCalled();
        });
    });
});
