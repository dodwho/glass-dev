import { Future } from "../../../../entities/Future";
import { RISData } from "../../../../entities/data-entry/amr-external/RISData";
import { SampleData } from "../../../../entities/data-entry/amr-external/SampleData";
import { DataValue } from "../../../../entities/data-entry/DataValue";
import { DataValuesSaveSummary, ImportStrategy } from "../../../../entities/data-entry/DataValuesSaveSummary";
import { DEFAULT_CATEGORY_COMBO_ID } from "../../../../entities/GlassMetadataReferences";
import { GlassModule } from "../../../../entities/GlassModule";
import { GlassUploads, GlassUploadsStatus } from "../../../../entities/GlassUploads";
import { CategoryCombo } from "../../../../entities/metadata/CategoryCombo";
import { DataSet } from "../../../../entities/metadata/DataSet";
import { GlassDocumentsRepository } from "../../../../repositories/GlassDocumentsRepository";
import { GlassModuleRepository } from "../../../../repositories/GlassModuleRepository";
import { GlassUploadsRepository } from "../../../../repositories/GlassUploadsRepository";
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

// The app and the background deletion server (cliAsyncDeletions) delete an AMR aggregate upload's data by reading
// its file again. Values its import wrote but the delete misses are left behind as orphans, so a delete must send
// exactly the values the import of the same file sent; except cells another live upload's file also holds, which
// are that upload's data too (CAN 2019, TCD 2023 and mislabelled batches lost data that way on PROD).

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
        { id: "aoc-escc-amp-ds2", name: "", categoryOptions: [option("ESCCOL"), option("AMP"), option("DS2")] },
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
    const save = jest.fn((values: DataValue[], action: ImportStrategy, _dryRun: boolean) =>
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

const cellKey = (value: DataValue) =>
    [value.orgUnit, value.period, value.dataElement, value.categoryOptionCombo, value.attributeOptionCombo].join("|");

function upload(overrides: Partial<GlassUploads> = {}): GlassUploads {
    return {
        id: "upload-deleted",
        fileId: "file-0",
        fileName: "RIS_KOR_2025_DS1.csv",
        fileType: "RIS",
        module: "module-amr",
        orgUnit: "ou-kor",
        period: "2025",
        status: "COMPLETED",
        ...overrides,
    } as GlassUploads;
}

type OtherUpload = { status: GlassUploadsStatus; fileType?: string; fileId: string; module?: string };

/**
 * The deleted upload plus `others` for the same country and year. A stored file "file-N" downloads as an N-byte
 * buffer, so the data repositories can tell the files apart; "file-unreadable" fails to download.
 */
function uploadsAndFiles(others: OtherUpload[], fileType = "RIS") {
    const glassUploadsRepository = {
        getUploadsByModuleOUPeriod: () =>
            Future.success([
                upload({ fileType }),
                ...others.map((other, index) =>
                    upload({
                        id: `upload-${index}`,
                        fileName: `other-${index}.csv`,
                        fileType,
                        ...other,
                    })
                ),
            ]),
    } as unknown as GlassUploadsRepository;
    const glassDocumentsRepository = {
        download: (fileId: string) =>
            fileId === "file-unreadable"
                ? Future.error("404 Not Found")
                : Future.success({
                      arrayBuffer: () => Promise.resolve(new ArrayBuffer(Number(fileId.replace("file-", "")))),
                  } as unknown as Blob),
    } as unknown as GlassDocumentsRepository;
    const glassModuleRepository = {
        getAll: () =>
            Future.success([
                { id: "module-amr", name: "AMR" },
                { id: "module-individual", name: "AMR - Individual" },
            ]),
    } as unknown as GlassModuleRepository;
    return { glassUploadsRepository, glassDocumentsRepository, glassModuleRepository };
}

describe("DeleteRISDataset", () => {
    const metadata = metadataRepository(risDataSet, pathogenAntibioticBatch);
    // file-0: the deleted upload's file; file-1: repeats its first row; file-2: the same row, but under batch DS2
    const filesBySize: Record<number, RISData[]> = { 0: risRows, 1: [risRow()], 2: [risRow({ BATCHIDDS: "DS2" })] };
    const risRepository = {
        get: () => Future.success(risRows),
        getFromArrayBuffer: (arrayBuffer: ArrayBuffer) => Future.success(filesBySize[arrayBuffer.byteLength]),
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

    const deleter = (
        repository: DataValuesRepository,
        others: OtherUpload[] = [],
        repositories = uploadsAndFiles(others)
    ) =>
        new DeleteRISDataset({
            risDataRepository: risRepository,
            metadataRepository: metadata,
            dataValuesRepository: repository,
            ...repositories,
        });

    it("deletes exactly the values the import of the same file wrote", async () => {
        const { save, repository } = recordingRepository();
        const summary = await deleter(repository).delete(upload(), new ArrayBuffer(0), undefined).toPromise();
        expect(sentValues(save)).toEqual(await imported());
        expect(save.mock.calls.map(call => [call[1], call[2]])).toEqual([["DELETE", false]]);
        expect(summary.importCount.deleted).toBe(risRows.length * risDataSet.dataElements.length);
    });

    it("deletes in chunks of the module's delete chunk size, sending every value once", async () => {
        const { save, repository } = recordingRepository();
        const summary = await deleter(repository).delete(upload(), new ArrayBuffer(0), 5).toPromise();
        expect(save.mock.calls.map(call => call[0].length)).toEqual([5, 5, 2]);
        expect(sentValues(save)).toEqual(await imported());
        expect(summary.importCount.deleted).toBe(12);
    });

    it("keeps the cells another live upload's file also holds and deletes the rest", async () => {
        const { save, repository } = recordingRepository();
        await deleter(repository, [{ status: "COMPLETED", fileId: "file-1" }])
            .delete(upload(), new ArrayBuffer(0), undefined)
            .toPromise();

        const all = await imported();
        // The first row's 4 cells, including the AB class cell it shares with the third row (same pathogen/antibiotic)
        const held = new Set(all.slice(0, risDataSet.dataElements.length).map(cellKey));
        const expected = all.filter(value => !held.has(cellKey(value)));
        expect(expected).toHaveLength(7);
        expect(sentValues(save)).toEqual(expected);
    });

    it("counts IMPORTED and VALIDATED uploads as live too, and compares the rows' batch, not the upload's", async () => {
        const { save, repository } = recordingRepository();
        await deleter(repository, [
            { status: "IMPORTED", fileId: "file-1" },
            { status: "VALIDATED", fileId: "file-2" },
        ])
            .delete(upload(), new ArrayBuffer(0), undefined)
            .toPromise();

        expect(sentValues(save)).toHaveLength(7);
    });

    it("ignores uploads that hold no data, other file types and the deleted upload itself", async () => {
        const { save, repository } = recordingRepository();
        await deleter(repository, [
            { status: "UPLOADED", fileId: "file-1" },
            { status: "COMPLETED", fileType: "SAMPLE", fileId: "file-1" },
            { status: "COMPLETED", fileType: "RIS Individual", fileId: "file-1", module: "module-individual" },
        ])
            .delete(upload({ status: "UPLOADED" }), new ArrayBuffer(0), undefined)
            .toPromise();

        expect(sentValues(save)).toEqual(await imported());
    });

    it("deletes nothing when another live upload's file cannot be read", async () => {
        const { save, repository } = recordingRepository();
        const result = await deleter(repository, [{ status: "COMPLETED", fileId: "file-unreadable" }])
            .delete(upload(), new ArrayBuffer(0), undefined)
            .runAsync();

        expect(result.error).toContain("Nothing was deleted");
        expect(result.error).toContain("other-0.csv");
        expect(save).not.toHaveBeenCalled();
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

    const deleter = (repository: DataValuesRepository, others: OtherUpload[] = []) =>
        new DeleteSampleDataset({
            sampleDataRepository: sampleRepository,
            metadataRepository: metadata,
            dataValuesRepository: repository,
            ...uploadsAndFiles(others, "SAMPLE"),
        });

    const sampleUpload = upload({ fileType: "SAMPLE" });

    it("deletes exactly the values the import of the same file wrote", async () => {
        const { save, repository } = recordingRepository();
        await deleter(repository).delete(sampleUpload, new ArrayBuffer(0), undefined).toPromise();
        expect(sentValues(save)).toEqual(await imported());
    });

    it("deletes in chunks, sending every value once", async () => {
        const { save, repository } = recordingRepository();
        const summary = await deleter(repository).delete(sampleUpload, new ArrayBuffer(0), 4).toPromise();
        expect(save.mock.calls.map(call => call[0].length)).toEqual([4, 2]);
        expect(summary.importCount.deleted).toBe(6);
    });

    // GNB 2025 on PROD: an AMR - Individual "SAMPLE File" upload stores into the same SAMPLE data set
    it("keeps the cells an AMR - Individual SAMPLE upload holds", async () => {
        const { save, repository } = recordingRepository();
        await deleter(repository, [
            { status: "COMPLETED", fileType: "SAMPLE File", fileId: "file-3", module: "module-individual" },
        ])
            .delete(sampleUpload, new ArrayBuffer(0), undefined)
            .toPromise();
        expect(sentValues(save)).toEqual([]);
    });

    it("keeps every cell when another live upload holds the same file (the same batch uploaded twice)", async () => {
        const { save, repository } = recordingRepository();
        await deleter(repository, [{ status: "COMPLETED", fileId: "file-3" }])
            .delete(sampleUpload, new ArrayBuffer(0), undefined)
            .toPromise();
        expect(sentValues(save)).toEqual([]);
    });
});
