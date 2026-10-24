import { describe, expect, it, vi } from "vitest";
import { Future } from "../../../../entities/Future";
import { RISData } from "../../../../entities/data-entry/amr-external/RISData";
import { SampleData } from "../../../../entities/data-entry/amr-external/SampleData";
import { DataValue } from "../../../../entities/data-entry/DataValue";
import { DataValuesSaveSummary, ImportStrategy } from "../../../../entities/data-entry/DataValuesSaveSummary";
import { DEFAULT_CATEGORY_COMBO_ID } from "../../../../entities/GlassMetadataReferences";
import { GlassModule } from "../../../../entities/GlassModule";
import { CategoryCombo } from "../../../../entities/metadata/CategoryCombo";
import { DataSet } from "../../../../entities/metadata/DataSet";
import { GlassModuleRepository } from "../../../../repositories/GlassModuleRepository";
import { MetadataRepository } from "../../../../repositories/MetadataRepository";
import { DataValuesRepository } from "../../../../repositories/data-entry/DataValuesRepository";
import { RISDataRepository } from "../../../../repositories/data-entry/RISDataRepository";
import { SampleDataRepository } from "../../../../repositories/data-entry/SampleDataRepository";
import { AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID } from "../../utils/getCategoryOptionCombo";
import { AMR_BATCHID_CC_ID, AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID } from "../amrAggMetadataIds";
import { DeleteRISDataset } from "../DeleteRISDataset";
import { DeleteSampleDataset } from "../DeleteSampleDataset";
import { ImportRISFile } from "../ImportRISFile";
import { ImportSampleFile } from "../ImportSampleFile";

// The background deletion server (cliAsyncDeletions) deletes an AMR aggregate upload's data by reading its stored
// file again. Values its import wrote but the delete misses are left behind as orphans, so a delete must send
// exactly the values the import of the same file sent.

const option = (code: string) => ({ id: `opt-${code}`, code });

const demography: CategoryCombo = {
    id: AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID,
    name: "Specimen, gender, origin, age group",
    categories: [],
    categoryOptionCombos: [
        {
            id: "coc-blood-m",
            name: "",
            categoryOptions: [option("BLOOD"), option("M"), option("UNKO"), option("15-24")],
        },
        { id: "coc-urine-f", name: "", categoryOptions: [option("URINE"), option("F"), option("A"), option("25-34")] },
        {
            id: "coc-blood-f",
            name: "",
            categoryOptions: [option("BLOOD"), option("F"), option("UNKO"), option("15-24")],
        },
    ],
};

const pathogenAntibioticBatch: CategoryCombo = {
    id: AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID,
    name: "Pathogen, antibiotic, batch",
    categories: [
        { id: "cat-p", code: "PATHOGEN" },
        { id: "cat-a", code: "ANTIBIOTIC" },
        { id: "cat-b", code: "BATCHIDDS" },
    ],
    categoryOptionCombos: [
        { id: "aoc-escc-amp-ds1", name: "", categoryOptions: [option("ESCCOL"), option("AMP"), option("DS1")] },
        { id: "aoc-escc-cip-ds1", name: "", categoryOptions: [option("ESCCOL"), option("CIP"), option("DS1")] },
    ],
};

const risDataSet: DataSet = {
    id: "ris-ds",
    name: "RIS",
    categoryCombo: AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID,
    dataElements: [
        {
            id: "de-res",
            name: "Resistant",
            code: "RESISTANT",
            categoryCombo: { id: AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID },
        },
        {
            id: "de-int",
            name: "Intermediate",
            code: "INTERMEDIATE",
            categoryCombo: { id: AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID },
        },
        {
            id: "de-sus",
            name: "Susceptible",
            code: "SUSCEPTIBLE",
            categoryCombo: { id: AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID },
        },
        { id: "de-abc", name: "AB class", code: "ABCLASS", categoryCombo: { id: DEFAULT_CATEGORY_COMBO_ID } },
    ],
};

const batch: CategoryCombo = {
    id: AMR_BATCHID_CC_ID,
    name: "Batch",
    categories: [{ id: "cat-b", code: "BATCHIDDS" }],
    categoryOptionCombos: [{ id: "aoc-ds1", name: "", categoryOptions: [option("DS1")] }],
};

const sampleDataSet: DataSet = {
    id: "sample-ds",
    name: "SAMPLE",
    categoryCombo: AMR_BATCHID_CC_ID,
    dataElements: [
        {
            id: "de-sampled",
            name: "Sampled",
            code: "NUMSAMPLEDPATIENTS",
            categoryCombo: { id: AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID },
        },
        {
            id: "de-infected",
            name: "Infected",
            code: "NUMINFECTED",
            categoryCombo: { id: AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID },
        },
    ],
};

function risRow(overrides: Partial<RISData> = {}): RISData {
    return {
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
    };
}

function sampleRow(overrides: Partial<SampleData> = {}): SampleData {
    return {
        COUNTRY: "KOR",
        YEAR: 2025,
        SPECIMEN: "BLOOD",
        GENDER: "M",
        ORIGIN: "UNK",
        AGEGROUP: "15-24",
        BATCHIDDS: "DS1",
        NUMINFECTED: 12,
        NUMSAMPLEDPATIENTS: 400,
        ...overrides,
    };
}

const risRows = [
    risRow(),
    risRow({ ANTIBIOTIC: "CIP", RESISTANT: 1, SUSCEPTIBLE: 0 }),
    risRow({ SPECIMEN: "URINE", GENDER: "F", ORIGIN: "A", AGEGROUP: "25-34", INTERMEDIATE: 2 }),
];
const sampleRows = [
    sampleRow(),
    sampleRow({ SPECIMEN: "URINE", GENDER: "F", ORIGIN: "A", AGEGROUP: "25-34", NUMINFECTED: 0 }),
    sampleRow({ GENDER: "F", NUMINFECTED: 5 }),
];

/** A data values repository that records every save and answers with the count of values it was given. */
function recordingRepository() {
    const save = vi.fn((values: DataValue[], action: ImportStrategy, _dryRun: boolean) =>
        Future.success<DataValuesSaveSummary, string>({
            status: "SUCCESS",
            description: "",
            importCount: {
                imported: action === "DELETE" ? 0 : values.length,
                updated: 0,
                ignored: 0,
                deleted: action === "DELETE" ? values.length : 0,
            },
            importTime: new Date("2026-10-24T10:00:00Z"),
        })
    );
    return { save, repository: { save } as unknown as DataValuesRepository };
}

function metadataRepository(dataSet: DataSet, dataSetCombo: CategoryCombo) {
    return {
        getDataSet: () => Future.success(dataSet),
        getCategoryCombination: (id: string) => Future.success(id === dataSetCombo.id ? dataSetCombo : demography),
        getOrgUnitsByCode: () => Future.success([{ id: "ou-kor", code: "KOR" }]),
        getValidationsDataSet: () => Future.success([]),
        getValidationRuleInstructions: () => Future.success([]),
    } as unknown as MetadataRepository;
}

const sentValues = (save: ReturnType<typeof recordingRepository>["save"]) => save.mock.calls.flatMap(call => call[0]);

describe("DeleteRISDataset", () => {
    const metadata = metadataRepository(risDataSet, pathogenAntibioticBatch);
    const risRepository = {
        get: () => Future.success(risRows),
        getFromArrayBuffer: () => Future.success(risRows),
    } as unknown as RISDataRepository;
    const module = {
        consistencyChecks: { specimenPathogen: { BLOOD: [{ ESCCOL: ["AMP", "CIP"] }], URINE: [{ ESCCOL: ["AMP"] }] } },
    } as unknown as GlassModule;

    async function imported(): Promise<DataValue[]> {
        const { save, repository } = recordingRepository();
        const moduleRepository = { getByName: () => Future.success(module) } as unknown as GlassModuleRepository;
        const summary = await new ImportRISFile(risRepository, metadata, repository, moduleRepository)
            .importRISFile({} as File, "DS1", "2025", "CREATE_AND_UPDATE", "ou-kor", "KOR", false)
            .toPromise();
        expect(summary.blockingErrors).toEqual([]);
        return sentValues(save);
    }

    const deleter = (repository: DataValuesRepository) =>
        new DeleteRISDataset({
            risDataRepository: risRepository,
            metadataRepository: metadata,
            dataValuesRepository: repository,
        });

    it("deletes exactly the values the import of the same file wrote", async () => {
        const { save, repository } = recordingRepository();
        const summary = await deleter(repository).delete(new ArrayBuffer(0), undefined).toPromise();
        expect(sentValues(save)).toEqual(await imported());
        expect(save.mock.calls.map(call => [call[1], call[2]])).toEqual([["DELETE", false]]);
        expect(summary.importCount.deleted).toBe(risRows.length * risDataSet.dataElements.length);
    });

    it("deletes in chunks of the module's delete chunk size, sending every value once", async () => {
        const { save, repository } = recordingRepository();
        const summary = await deleter(repository).delete(new ArrayBuffer(0), 5).toPromise();
        expect(save.mock.calls.map(call => call[0].length)).toEqual([5, 5, 2]);
        expect(sentValues(save)).toEqual(await imported());
        expect(summary.importCount.deleted).toBe(12);
    });
});

describe("DeleteSampleDataset", () => {
    const metadata = metadataRepository(sampleDataSet, batch);
    const sampleRepository = {
        get: () => Future.success(sampleRows),
        getFromArrayBuffer: () => Future.success(sampleRows),
    } as unknown as SampleDataRepository;

    async function imported(): Promise<DataValue[]> {
        const { save, repository } = recordingRepository();
        const summary = await new ImportSampleFile(sampleRepository, metadata, repository)
            .import({} as File, "DS1", "2025", "CREATE_AND_UPDATE", "ou-kor", "KOR", false)
            .toPromise();
        expect(summary.blockingErrors).toEqual([]);
        return sentValues(save);
    }

    const deleter = (repository: DataValuesRepository) =>
        new DeleteSampleDataset({
            sampleDataRepository: sampleRepository,
            metadataRepository: metadata,
            dataValuesRepository: repository,
        });

    it("deletes exactly the values the import of the same file wrote", async () => {
        const { save, repository } = recordingRepository();
        await deleter(repository).delete(new ArrayBuffer(0), undefined).toPromise();
        expect(sentValues(save)).toEqual(await imported());
    });

    it("deletes in chunks, sending every value once", async () => {
        const { save, repository } = recordingRepository();
        const summary = await deleter(repository).delete(new ArrayBuffer(0), 4).toPromise();
        expect(save.mock.calls.map(call => call[0].length)).toEqual([4, 2]);
        expect(summary.importCount.deleted).toBe(6);
    });
});
