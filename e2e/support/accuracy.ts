/* Checks that DHIS2 holds exactly what an uploaded file says, independently of any earlier build: every row and
   column of the file is compared with the stored values, matched through the DHIS2 metadata codes (the same codes
   the import maps by). The golden files show that nothing changed between builds; this shows that it is right. */
import _ from "lodash";
import { expect } from "@playwright/test";
import { modules, testYear } from "./config";
import { readCsv, Row } from "./csv";
import { get } from "./dhis2";

/** Same value written two ways: dates with or without a time, numbers with or without trailing zeros. */
function normalise(value: string | undefined): string {
    const text = (value ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text.slice(0, 10);
    if (/^-?\d+(\.\d+)?$/.test(text)) return String(Number(text));
    return text;
}

const serialise = (row: Row) =>
    Object.keys(row)
        .sort()
        .filter(key => normalise(row[key]) !== "")
        .map(key => `${key}=${normalise(row[key])}`)
        .join(" ");

function expectSameRows(name: string, expected: string[], actual: string[]) {
    const missing = _.difference(expected, actual).slice(0, 5);
    const extra = _.difference(actual, expected).slice(0, 5);
    expect(
        { missing, extra },
        `${name}: rows in the file but not in DHIS2 (missing), or the other way (extra)`
    ).toEqual({
        missing: [],
        extra: [],
    });
    expect(actual.length, `${name}: number of records`).toBe(expected.length);
}

type Metadata = { id: string; code?: string };

// COUNTRY and YEAR are checked against the submission when the file is uploaded, not stored on each record.
// ISOLATEID has no data element in the AMR - Individual stage ("AMR - Data"), so it is dropped on import
// (seen on DEV 2026-10-15; the AMR - Fungal stage has one). If one is added, remove it from this list.
const notStoredPerRecord = {
    AMR_INDIVIDUAL: ["COUNTRY", "YEAR", "ISOLATEID"],
    AMR_FUNGAL: ["COUNTRY", "YEAR"],
};

/** AMR Individual / Fungal: one tracked entity per file row, attributes and event values by code. */
export async function expectRecordsMatchFile(module: "AMR_INDIVIDUAL" | "AMR_FUNGAL", file: string) {
    const program = await get<{
        programTrackedEntityAttributes: { trackedEntityAttribute: Metadata }[];
        programStages: { id: string; programStageDataElements: { dataElement: Metadata }[] }[];
    }>(
        "programs/mMAj6Gofe49?fields=programTrackedEntityAttributes[trackedEntityAttribute[id,code]]," +
            "programStages[id,programStageDataElements[dataElement[id,code]]]"
    );
    const attributes = program.programTrackedEntityAttributes.map(a => a.trackedEntityAttribute);
    const stage = program.programStages.find(s => s.id === modules[module].stage);
    const codeById = new Map(
        [...attributes, ...(stage?.programStageDataElements.map(d => d.dataElement) ?? [])].map(m => [m.id, m.code])
    );
    const fileRows = readCsv(file);
    const columns = Object.keys(fileRows[0] ?? {}).filter(column => !notStoredPerRecord[module].includes(column));
    const unmapped = columns.filter(column => ![...codeById.values()].includes(column));
    expect(unmapped, "file columns with no attribute or data element of that code").toEqual([]);
    const expected = fileRows.map(row => serialise(_.pick(row, columns)));

    const response = await get<{
        trackedEntities: {
            attributes: { attribute: string; value: string }[];
            enrollments: { events: { programStage: string; dataValues: { dataElement: string; value: string }[] }[] }[];
        }[];
    }>(
        `tracker/trackedEntities?program=mMAj6Gofe49&orgUnits=${modules[module].country.id}&enrollmentEnrolledAfter=${testYear}-01-01` +
            `&enrollmentEnrolledBefore=${testYear}-12-31&fields=attributes[attribute,value],enrollments[events[programStage,dataValues[dataElement,value]]]&paging=false`
    );
    const actual = response.trackedEntities
        .filter(te => te.enrollments.some(en => en.events.some(e => e.programStage === stage?.id)))
        .map(te => {
            const values = [
                ...te.attributes.map(a => [a.attribute, a.value]),
                ...te.enrollments.flatMap(en =>
                    en.events.flatMap(e => e.dataValues.map(dv => [dv.dataElement, dv.value]))
                ),
            ];
            const row = Object.fromEntries(values.map(([id, value]) => [codeById.get(id ?? "") ?? id, value]));
            return serialise(_.pick(row, columns) as Row);
        });

    expectSameRows(modules[module].name, expected, actual);
}

type CategoryCombo = { id: string; categoryOptionCombos: { id: string; categoryOptions: { code: string }[] }[] };
type DataSet = {
    id: string;
    categoryCombo: { id: string };
    dataSetElements: { dataElement: Metadata & { categoryCombo: { id: string } } }[];
};

// The rules of mapAMRAggFileToDataValues / getCategoryOptionCombo.tsx, restated so the check stays independent:
// option codes are compared trimmed ("M " in DHIS2 is "M" in a file), UNK means a different option per category,
// the first matching combination is used, ABCLASS is not in the files yet and is stored as "ABCLASS Missing", and a
// data element whose combo is the hard-coded default id gets the default combination.
const unknownOption: Record<string, string> = { GENDER: "UNKG", ORIGIN: "UNKO", AGEGROUP: "UNKA" };
const hardCodedDefaultCombo = "bjDvmb4bfuf";
const fileValue = (row: Row, code: string) => row[code] ?? (code === "ABCLASS" ? "ABCLASS Missing" : "");

/** AMR aggregate: every value in the RIS and SAMPLE files is one data value, found through the category codes. */
export async function expectDataValuesMatchFiles(files: { ris: string; sample: string }) {
    const comboKey = (codes: string[]) =>
        codes
            .map(code => code.trim())
            .sort()
            .join("|");
    const { categoryCombos } = await get<{ categoryCombos: CategoryCombo[] }>(
        "categoryCombos?filter=id:in:[S427AvQESbw,OwKsZQnHCJu,rEMx3WFeLcU]&fields=id,categoryOptionCombos[id,categoryOptions[code]]&paging=false"
    );
    const comboId = new Map<string, string>();
    for (const cc of categoryCombos)
        for (const coc of cc.categoryOptionCombos) {
            const key = `${cc.id}:${comboKey(coc.categoryOptions.map(o => o.code))}`;
            if (!comboId.has(key)) comboId.set(key, coc.id);
        }
    const findCombo = (combo: string, codes: string[]) => comboId.get(`${combo}:${comboKey(codes)}`) ?? `?${codes}`;
    const defaultCombo = (
        await get<{ categoryOptionCombos: { id: string }[] }>("categoryOptionCombos?filter=name:eq:default&fields=id")
    ).categoryOptionCombos[0]?.id;

    const { dataSets } = await get<{ dataSets: DataSet[] }>(
        "dataSets?filter=id:in:[CeQPmXgrhHF,OcAB7oaC072]&fields=id,categoryCombo[id],dataSetElements[dataElement[id,code,categoryCombo[id]]]&paging=false"
    );

    const expectedFor = (dataSetId: string, file: string, attributeCodes: string[]) => {
        const dataSet = dataSets.find(ds => ds.id === dataSetId);
        return readCsv(file).flatMap(row => {
            const demographics = ["SPECIMEN", "GENDER", "ORIGIN", "AGEGROUP"].map(code =>
                row[code] === "UNK" && unknownOption[code] ? unknownOption[code] ?? "" : row[code] ?? ""
            );
            const aoc = findCombo(
                dataSet?.categoryCombo.id ?? "",
                attributeCodes.map(code => row[code] ?? "")
            );
            return (dataSet?.dataSetElements ?? [])
                .map(({ dataElement }) => ({ dataElement, value: normalise(fileValue(row, dataElement.code ?? "")) }))
                .filter(({ value }) => value !== "" && value !== "0")
                .map(({ dataElement, value }) => {
                    const coc =
                        dataElement.categoryCombo.id === hardCodedDefaultCombo
                            ? defaultCombo
                            : findCombo("OwKsZQnHCJu", demographics);
                    return [dataElement.id, coc, aoc, value].join(" ");
                });
        });
    };

    const actualFor = async (dataSet: string) => {
        const response = await get<{ dataValues?: Record<string, string>[] }>(
            `dataValueSets?dataSet=${dataSet}&orgUnit=${modules.AMR.country.id}&period=${testYear}`
        );
        return (response.dataValues ?? [])
            .filter(dv => normalise(dv.value) !== "0")
            .map(dv =>
                [dv.dataElement, dv.categoryOptionCombo, dv.attributeOptionCombo, normalise(dv.value)].join(" ")
            );
    };

    expectSameRows(
        "RIS data values",
        expectedFor("CeQPmXgrhHF", files.ris, ["PATHOGEN", "ANTIBIOTIC", "BATCHID"]),
        await actualFor("CeQPmXgrhHF")
    );
    expectSameRows(
        "SAMPLE data values",
        expectedFor("OcAB7oaC072", files.sample, ["BATCHID"]),
        await actualFor("OcAB7oaC072")
    );
}
