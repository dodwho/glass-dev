import { describe, expect, it } from "vitest";
import { RISData } from "../../../../entities/data-entry/amr-external/RISData";
import { SampleData } from "../../../../entities/data-entry/amr-external/SampleData";
import { CategoryCombo } from "../../../../entities/metadata/CategoryCombo";
import { AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID } from "../../utils/getCategoryOptionCombo";
import { AMRAggFileMetadata, mapRISDataToDataValues, mapSampleDataToDataValues } from "../mapAMRAggFileToDataValues";

const option = (code: string) => ({ id: `opt-${code}`, code });

const demography: CategoryCombo = {
    id: AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID,
    name: "",
    categories: [],
    categoryOptionCombos: [
        { id: "coc-1", name: "", categoryOptions: [option("BLOOD"), option("M"), option("UNKO"), option("15-24")] },
    ],
};

const demographicCells = { SPECIMEN: "BLOOD", GENDER: "M", ORIGIN: "UNK", AGEGROUP: "15-24" };

function metadata(attributeCategoryCodes: string[], aocOptions: string[], dataElementCode: string): AMRAggFileMetadata {
    return {
        dataSet: {
            id: "ds",
            name: "",
            categoryCombo: "cc",
            dataElements: [
                {
                    id: "de-1",
                    name: "",
                    code: dataElementCode,
                    categoryCombo: { id: AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID },
                },
            ],
        },
        dataSet_CC: {
            id: "cc",
            name: "",
            categories: attributeCategoryCodes.map(code => ({ id: `cat-${code}`, code })),
            categoryOptionCombos: [{ id: "aoc-1", name: "", categoryOptions: aocOptions.map(option) }],
        },
        dataElement_CC: demography,
        orgUnits: [{ id: "ou-kor", code: "KOR" }],
    };
}

describe("mapRISDataToDataValues", () => {
    const risMetadata = metadata(["PATHOGEN", "ANTIBIOTIC", "BATCHIDDS"], ["ESCCOL", "AMP", "DS1"], "RESISTANT");
    const row = {
        COUNTRY: "KOR",
        YEAR: 2025,
        BATCHIDDS: "DS1",
        PATHOGEN: "ESCCOL",
        ANTIBIOTIC: "AMP",
        ...demographicCells,
    } as unknown as RISData;

    it("maps a row to its combos and stores a blank result as 0", () => {
        expect(mapRISDataToDataValues([{ ...row, RESISTANT: null }], risMetadata)).toEqual({
            dataValues: [
                {
                    orgUnit: "ou-kor",
                    period: "2025",
                    attributeOptionCombo: "aoc-1",
                    dataElement: "de-1",
                    categoryOptionCombo: "coc-1",
                    value: "0",
                },
            ],
            categoryOptionErrors: [],
        });
    });

    it("reports the file line of a code with no matching combo", () => {
        const { categoryOptionErrors } = mapRISDataToDataValues(
            [{ ...row, RESISTANT: 1 }, { ...row, ANTIBIOTIC: "XXX", RESISTANT: 1 } as RISData],
            risMetadata
        );
        expect(categoryOptionErrors.map(error => error.line)).toEqual([2]);
    });
});

describe("mapSampleDataToDataValues", () => {
    const sampleMetadata = metadata(["BATCHIDDS"], ["DS1"], "NUMSAMPLEDPATIENTS");
    const row = { COUNTRY: "KOR", YEAR: 2025, BATCHIDDS: "DS1", ...demographicCells } as unknown as SampleData;

    it("keeps a blank count blank, so nothing is stored for it", () => {
        const { dataValues } = mapSampleDataToDataValues([row], sampleMetadata);
        expect(dataValues.map(dataValue => dataValue.value)).toEqual([""]);
    });

    it("writes a count as text", () => {
        const { dataValues } = mapSampleDataToDataValues([{ ...row, NUMSAMPLEDPATIENTS: 12 }], sampleMetadata);
        expect(dataValues.map(dataValue => dataValue.value)).toEqual(["12"]);
    });
});
