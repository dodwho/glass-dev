import { Future } from "../../../../entities/Future";
import { SampleData } from "../../../../entities/data-entry/amr-external/SampleData";
import { DataValue } from "../../../../entities/data-entry/DataValue";
import { DataValuesSaveSummary, ImportStrategy } from "../../../../entities/data-entry/DataValuesSaveSummary";
import { CategoryCombo } from "../../../../entities/metadata/CategoryCombo";
import { DataSet } from "../../../../entities/metadata/DataSet";
import { MetadataRepository } from "../../../../repositories/MetadataRepository";
import { DataValuesRepository } from "../../../../repositories/data-entry/DataValuesRepository";
import { SampleDataRepository } from "../../../../repositories/data-entry/SampleDataRepository";
import { AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID } from "../../utils/getCategoryOptionCombo";
import { AMR_BATCHID_CC_ID } from "../amrAggMetadataIds";
import { ImportSampleFile } from "../ImportSampleFile";

const option = (code: string) => ({ id: `opt-${code}`, code });

const batch: CategoryCombo = {
    id: AMR_BATCHID_CC_ID,
    name: "Batch",
    categories: [{ id: "cat-b", code: "BATCHIDDS" }],
    categoryOptionCombos: [{ id: "aoc-ds1", name: "", categoryOptions: [option("DS1")] }],
};

const demography: CategoryCombo = {
    id: AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID,
    name: "Specimen, gender, origin, age group",
    categories: [],
    categoryOptionCombos: [
        {
            id: "coc-blood-f-a-25",
            name: "",
            categoryOptions: [option("BLOOD"), option("F"), option("A"), option("25-34")],
        },
    ],
};

const dataSet: DataSet = {
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

function sampleRow(overrides: Partial<SampleData> = {}): SampleData {
    return {
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
    };
}

function setup(rows: SampleData[]) {
    const saveSummary: DataValuesSaveSummary = {
        status: "SUCCESS",
        description: "",
        importCount: { imported: rows.length * 2, updated: 0, ignored: 0, deleted: 0 },
        importTime: new Date("2026-10-16T10:00:00Z"),
    };
    const save = jest.fn((_values: DataValue[], _action: ImportStrategy, _dryRun: boolean) =>
        Future.success(saveSummary)
    );
    const getValidationsDataSet = jest.fn(() => Future.success([]));
    const metadataRepository = {
        getDataSet: () => Future.success(dataSet),
        getCategoryCombination: (id: string) => Future.success(id === AMR_BATCHID_CC_ID ? batch : demography),
        getOrgUnitsByCode: () => Future.success([{ id: "ou-kor", code: "KOR" }]),
        getValidationsDataSet,
        getValidationRuleInstructions: () => Future.success([]),
    } as unknown as MetadataRepository;
    const importer = new ImportSampleFile(
        { get: () => Future.success(rows) } as unknown as SampleDataRepository,
        metadataRepository,
        { save } as unknown as DataValuesRepository
    );
    const run = (action: ImportStrategy = "CREATE_AND_UPDATE") =>
        importer.import({} as File, "DS1", "2025", action, "ou-kor", "KOR", false).toPromise();
    return { run, save };
}

describe("ImportSampleFile", () => {
    it("writes the sampled and infected counts for each row", async () => {
        const { run, save } = setup([sampleRow()]);

        const summary = await run();

        expect(summary.status).toBe("SUCCESS");
        expect(save.mock.calls[0]?.[0]).toEqual([
            {
                orgUnit: "ou-kor",
                period: "2025",
                attributeOptionCombo: "aoc-ds1",
                dataElement: "de-sampled",
                categoryOptionCombo: "coc-blood-f-a-25",
                value: "400",
            },
            {
                orgUnit: "ou-kor",
                period: "2025",
                attributeOptionCombo: "aoc-ds1",
                dataElement: "de-infected",
                categoryOptionCombo: "coc-blood-f-a-25",
                value: "12",
            },
        ]);
    });

    it("blocks a count that is not a whole number 0 or higher, before saving anything", async () => {
        const { run, save } = setup([sampleRow({ NUMSAMPLEDPATIENTS: NaN })]);

        const summary = await run();

        expect(save).not.toHaveBeenCalled();
        expect(summary.blockingErrors).toEqual([
            {
                error: "NUMSAMPLEDPATIENTS must be a whole number 0 or higher, such as 0, 25 or 1,234",
                count: 1,
                lines: [1],
            },
        ]);
    });

    it("blocks wrong country, year, batch and duplicate rows and writes nothing", async () => {
        const { run, save } = setup([
            sampleRow({ COUNTRY: "JPN" }),
            sampleRow({ YEAR: 2024 }),
            sampleRow({ BATCHIDDS: "DS2" }),
        ]);

        const summary = await run();

        expect(save).not.toHaveBeenCalled();
        expect(summary.status).toBe("ERROR");
        expect(summary.blockingErrors.map(e => e.error)).toEqual(
            expect.arrayContaining([
                expect.stringContaining("Country in file: JPN"),
                expect.stringContaining("Year in file: 2024"),
                expect.stringContaining("batchId in file: DS2"),
            ])
        );
    });

    it("reports an unknown combination once, with every line it occurs on", async () => {
        const { run } = setup([sampleRow({ AGEGROUP: "99+" }), sampleRow({ AGEGROUP: "99+", GENDER: "F " })]);

        const summary = await run();

        const comboErrors = summary.blockingErrors.filter(e => e.error.startsWith("Combination of"));
        expect(comboErrors).toEqual([
            {
                error: 'Combination of Specimen, gender, origin, age group not found for codes: "BLOOD,F,A,99+"',
                count: 2,
                lines: [1, 2],
            },
        ]);
    });

    it("deletes without running the consistency checks", async () => {
        const { run, save } = setup([sampleRow({ YEAR: 2024 })]);

        const summary = await run("DELETE");

        expect(save).toHaveBeenCalledWith(expect.any(Array), "DELETE", false);
        expect(summary.blockingErrors).toEqual([]);
    });
});
