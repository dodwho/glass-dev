import { vi } from "vitest";
import { Future } from "../../../../entities/Future";
import { RISData } from "../../../../entities/data-entry/amr-external/RISData";
import { SampleData } from "../../../../entities/data-entry/amr-external/SampleData";
import { GlassModule } from "../../../../entities/GlassModule";
import { DataSet } from "../../../../entities/metadata/DataSet";
import { GlassModuleRepository } from "../../../../repositories/GlassModuleRepository";
import { MetadataRepository } from "../../../../repositories/MetadataRepository";
import { DataValuesImportRepository } from "../../../../repositories/data-entry/DataValuesImportRepository";
import { RISDataRepository } from "../../../../repositories/data-entry/RISDataRepository";
import { SampleDataRepository } from "../../../../repositories/data-entry/SampleDataRepository";
import { RISDataSetImportHelper } from "../RISDataSetImportHelper";
import { SampleDatasetImportHelper } from "../SampleDatasetImportHelper";

// The helpers used by the historical bulk loader (bulkUploadAMRAggFiles.ts).

const ris = (overrides: Partial<RISData> = {}): RISData => ({
    COUNTRY: "KOR",
    YEAR: 2025,
    SPECIMEN: "BLOOD",
    GENDER: "M",
    ORIGIN: "UNK",
    AGEGROUP: "15-24",
    BATCHIDDS: "DS1",
    PATHOGEN: "ESCCOL",
    ANTIBIOTIC: "AMP",
    RESISTANT: 3,
    INTERMEDIATE: 0,
    NONSUSCEPTIBLE: 3,
    SUSCEPTIBLE: 10,
    UNKNOWN_NO_AST: 0,
    UNKNOWN_NO_BREAKPOINTS: 0,
    ABCLASS: "ABCLASS Missing",
    ...overrides,
});

const sample = (overrides: Partial<SampleData> = {}): SampleData => ({
    COUNTRY: "KOR",
    YEAR: 2025,
    SPECIMEN: "BLOOD",
    GENDER: "F",
    ORIGIN: "A",
    AGEGROUP: "25-34",
    BATCHIDDS: "DS1",
    NUMINFECTED: 12,
    NUMSAMPLEDPATIENTS: 400,
    ...overrides,
});

function repositories<Row>(rows: Row[]) {
    const save = vi.fn();
    const emptyDataSet: DataSet = { id: "ds", name: "", categoryCombo: "", dataElements: [] };
    const module = {
        consistencyChecks: { specimenPathogen: { BLOOD: [{ ESCCOL: ["AMP", "CIP", "MEM", "GEN"] }] } },
    } as unknown as GlassModule;
    return {
        save,
        fileRepository: { get: () => Future.success(rows) },
        metadataRepository: {
            getDataSet: () => Future.success(emptyDataSet),
            getCategoryCombination: (id: string) =>
                Future.success({ id, name: "", categories: [], categoryOptionCombos: [] }),
        } as unknown as MetadataRepository,
        dataValuesRepository: { save } as unknown as DataValuesImportRepository,
        moduleRepository: { getByName: () => Future.success(module) } as unknown as GlassModuleRepository,
    };
}

const expectedErrors = [
    { error: "Year is different: Selected Data Submission Year : 2025, Year in file: 2024", count: 1, lines: [2] },
    {
        error: "Country is different: Selected Data Submission Country : KOR, Country in file: UGA",
        count: 1,
        lines: [3],
    },
    expect.objectContaining({ count: 2, lines: [4, 5] }),
];

describe("bulk loader import helpers", () => {
    it("RIS: blocks rows in another year or country and duplicate rows, and writes nothing", async () => {
        const rows = [
            ris(),
            ris({ YEAR: 2024, ANTIBIOTIC: "CIP" }),
            ris({ COUNTRY: "UGA", ANTIBIOTIC: "MEM" }),
            ris({ ANTIBIOTIC: "GEN" }),
            ris({ ANTIBIOTIC: "GEN" }),
        ];
        const repos = repositories(rows);
        const helper = await RISDataSetImportHelper.initialize(
            repos.fileRepository as unknown as RISDataRepository,
            repos.metadataRepository,
            repos.dataValuesRepository,
            repos.moduleRepository
        );

        const summary = await helper.importRISDataValues({
            inputFile: {} as File,
            year: "2025",
            countryCode: "KOR",
            action: "CREATE_AND_UPDATE",
            dryRun: false,
            orgUnitId: "ou-kor",
        });

        expect(repos.save).not.toHaveBeenCalled();
        expect(summary.blockingErrors).toEqual(expect.arrayContaining(expectedErrors));
    });

    it("SAMPLE: blocks rows in another year or country and duplicate rows, and writes nothing", async () => {
        const rows = [
            sample(),
            sample({ YEAR: 2024, AGEGROUP: "35-44" }),
            sample({ COUNTRY: "UGA", AGEGROUP: "45-54" }),
            sample({ AGEGROUP: "55-64" }),
            sample({ AGEGROUP: "55-64" }),
        ];
        const repos = repositories(rows);
        const helper = await SampleDatasetImportHelper.initialize(
            repos.fileRepository as unknown as SampleDataRepository,
            repos.metadataRepository,
            repos.dataValuesRepository,
            repos.moduleRepository
        );

        const summary = await helper.importSampleDataValues(
            {} as File,
            "2025",
            "CREATE_AND_UPDATE",
            "ou-kor",
            false,
            "KOR"
        );

        expect(repos.save).not.toHaveBeenCalled();
        expect(summary.blockingErrors).toEqual(expectedErrors);
    });
});
