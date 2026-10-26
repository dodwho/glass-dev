import { Future } from "../../../../entities/Future";
import { SampleData } from "../../../../entities/data-entry/amr-external/SampleData";
import { DataValue } from "../../../../entities/data-entry/DataValue";
import { DataValuesSaveSummary } from "../../../../entities/data-entry/DataValuesSaveSummary";
import { CategoryCombo } from "../../../../entities/metadata/CategoryCombo";
import { DataSet } from "../../../../entities/metadata/DataSet";
import { MetadataRepository } from "../../../../repositories/MetadataRepository";
import { DataValuesRepository } from "../../../../repositories/data-entry/DataValuesRepository";
import { SampleDataRepository } from "../../../../repositories/data-entry/SampleDataRepository";
import { GlassUploadsRepository } from "../../../../repositories/GlassUploadsRepository";
import { AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID } from "../../utils/getCategoryOptionCombo";
import { AMR_BATCHID_CC_ID } from "../amrAggMetadataIds";
import { AsyncImportSampleFile } from "../AsyncImportSampleFile";
import { mapSampleDataToDataValues } from "../mapAMRAggFileToDataValues";

// The async server imports AMR - Individual "SAMPLE File" uploads into the AMR aggregate SAMPLE data set. It must
// write exactly what the app's import writes and what the app's delete and the orphans check expect.

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
        { id: "coc-1", name: "", categoryOptions: [option("BLOOD"), option("F"), option("A"), option("25-34")] },
        { id: "coc-2", name: "", categoryOptions: [option("BLOOD"), option("M"), option("A"), option("25-34")] },
    ],
};
const dataSet: DataSet = {
    id: "sample-ds",
    name: "SAMPLE",
    categoryCombo: AMR_BATCHID_CC_ID,
    dataElements: ["NUMSAMPLEDPATIENTS", "NUMINFECTED"].map(code => ({
        id: `de-${code}`,
        name: code,
        code,
        categoryCombo: { id: AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID },
    })),
};
const row = (overrides: Partial<SampleData> = {}): SampleData => ({
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

function importRows(rows: SampleData[]) {
    const sent: DataValue[] = [];
    const saveSummary: DataValuesSaveSummary = {
        status: "SUCCESS",
        description: "",
        importCount: { imported: 2, updated: 0, ignored: 0, deleted: 0 },
        importTime: new Date("2026-10-26T10:00:00Z"),
    };
    const importer = new AsyncImportSampleFile({
        sampleDataRepository: { getFromBlob: () => Future.success(rows) } as unknown as SampleDataRepository,
        metadataRepository: {
            getDataSet: () => Future.success(dataSet),
            getCategoryCombination: (id: string) => Future.success(id === AMR_BATCHID_CC_ID ? batch : demography),
            getOrgUnitsByCode: () => Future.success([{ id: "ou-kor", code: "KOR" }]),
            getValidationsDataSet: () => Future.success([]),
            getValidationRuleInstructions: () => Future.success([]),
        } as unknown as MetadataRepository,
        dataValuesRepository: {
            save: (values: DataValue[]) => {
                sent.push(...values);
                return Future.success(saveSummary);
            },
        } as unknown as DataValuesRepository,
        glassUploadsRepository: {
            saveImportSummaries: () => Future.success(undefined),
        } as unknown as GlassUploadsRepository,
    });
    const summaries = importer
        .import({
            uploadId: "up-1",
            inputBlob: new Blob(),
            batchId: "DS1",
            uploadChunkSize: 1,
            period: "2025",
            orgUnitId: "ou-kor",
            countryCode: "KOR",
            dryRun: false,
        })
        .toPromise();
    return { sent, summaries };
}

describe("AsyncImportSampleFile", () => {
    it("writes exactly the values of the shared mapping, a blank count included", async () => {
        const rows = [row(), row({ GENDER: "M", NUMINFECTED: null as unknown as number })];
        const { sent, summaries } = importRows(rows);
        await summaries;
        const expected = mapSampleDataToDataValues(rows, {
            dataSet,
            dataSet_CC: batch,
            dataElement_CC: demography,
            orgUnits: [{ id: "ou-kor", code: "KOR" }],
        }).dataValues;
        expect(sent).toEqual(expected);
    });

    it("blocks a row whose options match no combination, with its line number", async () => {
        const { sent, summaries } = importRows([row(), row({ GENDER: "X" })]);
        const [summary] = await summaries;
        expect(sent).toEqual([]);
        expect(summary?.blockingErrors.some(error => error.lines?.includes(2))).toBe(true);
    });
});
