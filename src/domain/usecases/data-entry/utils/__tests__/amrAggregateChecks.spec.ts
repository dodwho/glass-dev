import { RISData } from "../../../../entities/data-entry/amr-external/RISData";
import { SampleData } from "../../../../entities/data-entry/amr-external/SampleData";
import { CategoryCombo } from "../../../../entities/metadata/CategoryCombo";
import { DataElement } from "../../../../entities/metadata/DataSet";
import { ImportSummary } from "../../../../entities/data-entry/ImportSummary";
import { DEFAULT_CATEGORY_COMBO_ID } from "../../../../entities/GlassMetadataReferences";
import { PATHOGEN_ANTIBIOTIC_MAP } from "../../../../entities/GlassModule";
import { checkASTResults } from "../checkASTResults";
import { checkBatchId } from "../checkBatchId";
import { checkCountry } from "../checkCountry";
import { checkDuplicateRowsRIS, checkDuplicateRowsSAMPLE } from "../checkDuplicateRows";
import { checkSpecimenPathogen } from "../checkSpecimenPathogen";
import { checkWholeNumbers } from "../checkWholeNumbers";
import { checkYear } from "../checkYear";
import { getCategoryOptionComboByDataElement, getCategoryOptionComboByOptionCodes } from "../getCategoryOptionCombo";
import { includeBlockingErrors } from "../includeBlockingErrors";

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
        INTERMEDIATE: 1,
        NONSUSCEPTIBLE: 4,
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
        GENDER: "F",
        ORIGIN: "A",
        AGEGROUP: "25-34",
        BATCHIDDS: "DS1",
        NUMINFECTED: 12,
        NUMSAMPLEDPATIENTS: 400,
        ...overrides,
    };
}

describe("AMR aggregate file checks", () => {
    describe("checkYear", () => {
        it("accepts a file whose rows all have the submission year", () => {
            expect(checkYear([risRow(), risRow()], "2025")).toEqual([]);
        });

        it("groups rows with the same wrong year into one error with their line numbers", () => {
            const rows = [risRow(), risRow({ YEAR: 2024 }), risRow(), risRow({ YEAR: 2024 }), risRow({ YEAR: 2023 })];

            expect(checkYear(rows, "2025")).toEqual([
                {
                    error: "Year is different: Selected Data Submission Year : 2025, Year in file: 2024",
                    count: 2,
                    lines: [2, 4],
                },
                {
                    error: "Year is different: Selected Data Submission Year : 2025, Year in file: 2023",
                    count: 1,
                    lines: [5],
                },
            ]);
        });

        it("reports a single wrong row too", () => {
            expect(checkYear([risRow({ YEAR: 2024 })], "2025")).toHaveLength(1);
        });
    });

    describe("checkCountry", () => {
        it("reports every row of another country, keeping lines 1-based", () => {
            expect(checkCountry([sampleRow({ COUNTRY: "JPN" }), sampleRow()], "KOR")).toEqual([
                {
                    error: "Country is different: Selected Data Submission Country : KOR, Country in file: JPN",
                    count: 1,
                    lines: [1],
                },
            ]);
        });
    });

    describe("checkBatchId", () => {
        it("reports rows whose batch differs from the batch chosen on the upload screen", () => {
            const errors = checkBatchId([risRow(), risRow({ BATCHIDDS: "DS2" })], "DS1");

            expect(errors).toEqual([
                {
                    error: "Batchid is different: Selectd batchId to upload: DS1, batchId in file: DS2",
                    count: 1,
                    lines: [2],
                },
            ]);
        });
    });

    describe("checkASTResults", () => {
        const allEmpty = {
            RESISTANT: null,
            INTERMEDIATE: null,
            NONSUSCEPTIBLE: null,
            SUSCEPTIBLE: null,
            UNKNOWN_NO_AST: null,
            UNKNOWN_NO_BREAKPOINTS: null,
        } as unknown as Partial<RISData>;

        it("blocks a row whose six AST results are all null", () => {
            expect(checkASTResults([risRow(), risRow(allEmpty)])).toEqual([
                { error: "The AST results provided are not valid (they are all empty)", count: 1, lines: [2] },
            ]);
        });

        // The reader gives null for a blank cell (review decision D1); zeros typed in the file are real results.
        it("does not block a row whose AST results are all 0", () => {
            const zeros = {
                RESISTANT: 0,
                INTERMEDIATE: 0,
                NONSUSCEPTIBLE: 0,
                SUSCEPTIBLE: 0,
                UNKNOWN_NO_AST: 0,
                UNKNOWN_NO_BREAKPOINTS: 0,
            };
            expect(checkASTResults([risRow(zeros)])).toEqual([]);
        });
    });

    describe("checkWholeNumbers", () => {
        const columns = ["RESISTANT", "SUSCEPTIBLE"] as const;

        it("accepts whole numbers 0 or higher", () => {
            const rows = [risRow({ RESISTANT: 0 }), risRow({ RESISTANT: 1567, SUSCEPTIBLE: 1e6 })];
            expect(checkWholeNumbers(rows, [...columns])).toEqual([]);
        });

        // DHIS2 ignores these values (INTEGER_ZERO_OR_POSITIVE) after the rest of the file has been saved.
        it("reports text, negative and decimal values by column, with their lines", () => {
            const rows = [risRow({ RESISTANT: NaN }), risRow(), risRow({ RESISTANT: -1, SUSCEPTIBLE: 2.5 })];
            expect(checkWholeNumbers(rows, [...columns])).toEqual([
                {
                    error: "RESISTANT must be a whole number 0 or higher, such as 0, 25 or 1,234",
                    count: 2,
                    lines: [1, 3],
                },
                {
                    error: "SUSCEPTIBLE must be a whole number 0 or higher, such as 0, 25 or 1,234",
                    count: 1,
                    lines: [3],
                },
            ]);
        });

        it("leaves a blank cell (null) to the other checks", () => {
            const rows = [risRow({ RESISTANT: null as unknown as number })];
            expect(checkWholeNumbers(rows, [...columns])).toEqual([]);
        });
    });

    describe("duplicate rows", () => {
        it("RIS: rows with the same specimen, pathogen, demography, antibiotic and batch are duplicates", () => {
            const rows = [risRow(), risRow({ ANTIBIOTIC: "CIP" }), risRow({ RESISTANT: 99 })];

            expect(checkDuplicateRowsRIS(rows)).toEqual([
                {
                    error: "Duplicate rows found for combination : BLOOD, ESCCOL, M, UNK, 15-24, AMP, DS1",
                    count: 2,
                    lines: [1, 3],
                },
            ]);
        });

        it("SAMPLE: the key has no pathogen or antibiotic", () => {
            const rows = [sampleRow(), sampleRow({ NUMINFECTED: 1 }), sampleRow({ GENDER: "M" })];

            expect(checkDuplicateRowsSAMPLE(rows)).toEqual([
                {
                    error: "Duplicate rows found for combination : BLOOD, F, A, 25-34, DS1",
                    count: 2,
                    lines: [1, 2],
                },
            ]);
        });
    });

    describe("checkSpecimenPathogen", () => {
        const allowed: Record<string, PATHOGEN_ANTIBIOTIC_MAP[]> = {
            BLOOD: [{ ESCCOL: ["AMP", "CIP"] }, { KLEPNE: ["MEM"] }],
        };
        const message = (specimen: string, pathogen: string, antibiotic: string) =>
            `The specimen, pathogen, antibiotic combination you have provided is not allowed. Specimen ${specimen}, Pathogen ${pathogen}, Antibiotic ${antibiotic}`;

        it("accepts combinations in the module's list", () => {
            const rows = [
                { SPECIMEN: "BLOOD", PATHOGEN: "ESCCOL", ANTIBIOTIC: "CIP" },
                { SPECIMEN: "BLOOD", PATHOGEN: "KLEPNE", ANTIBIOTIC: "MEM" },
            ];
            expect(checkSpecimenPathogen(rows, allowed)).toEqual([]);
        });

        it("blocks an unknown specimen, an unknown pathogen and an antibiotic not allowed for the pathogen", () => {
            const rows = [
                { SPECIMEN: "URINE", PATHOGEN: "ESCCOL", ANTIBIOTIC: "AMP" },
                { SPECIMEN: "BLOOD", PATHOGEN: "SALSPP", ANTIBIOTIC: "AMP" },
                { SPECIMEN: "BLOOD", PATHOGEN: "KLEPNE", ANTIBIOTIC: "AMP" },
            ];

            expect(checkSpecimenPathogen(rows, allowed)).toEqual([
                { error: message("URINE", "ESCCOL", "AMP"), count: 1, lines: [1] },
                { error: message("BLOOD", "SALSPP", "AMP"), count: 1, lines: [2] },
                { error: message("BLOOD", "KLEPNE", "AMP"), count: 1, lines: [3] },
            ]);
        });

        it("numbers lines from firstLine (used when a file is checked in chunks)", () => {
            const rows = [{ SPECIMEN: "URINE", PATHOGEN: "ESCCOL", ANTIBIOTIC: "AMP" }];
            expect(checkSpecimenPathogen(rows, allowed, 501)[0]?.lines).toEqual([501]);
        });
    });

    describe("category option combinations", () => {
        const option = (code: string) => ({ id: `opt-${code}`, code });
        const demographyCombo: CategoryCombo = {
            id: "cc-demo",
            name: "Specimen, gender, origin, age group",
            categories: [],
            categoryOptionCombos: [
                {
                    id: "coc-blood-m-unko-15",
                    name: "",
                    categoryOptions: [option("BLOOD"), option("M"), option("UNKO"), option("15-24")],
                },
                {
                    id: "coc-blood-unkg-a-unka",
                    name: "",
                    categoryOptions: [option("BLOOD"), option("UNKG"), option("A"), option("UNKA")],
                },
            ],
        };
        const dataElement = (categoryCombo: string): DataElement => ({
            id: "de-resistant",
            name: "Resistant",
            code: "RESISTANT",
            categoryCombo: { id: categoryCombo },
        });

        it("maps the file's UNK to each category's own unknown option", () => {
            const result = getCategoryOptionComboByDataElement(
                dataElement("cc-demo"),
                demographyCombo,
                risRow({ GENDER: "UNK", ORIGIN: "A", AGEGROUP: "UNK" })
            );
            expect(result).toEqual({ categoryOptionComboId: "coc-blood-unkg-a-unka", error: "" });
        });

        it("ignores spaces around the codes", () => {
            const result = getCategoryOptionComboByDataElement(
                dataElement("cc-demo"),
                demographyCombo,
                risRow({ SPECIMEN: " BLOOD ", GENDER: "M ", ORIGIN: " UNK", AGEGROUP: "15-24" })
            );
            expect(result.categoryOptionComboId).toBe("coc-blood-m-unko-15");
        });

        it("returns no combination for a data element on the default combination", () => {
            expect(
                getCategoryOptionComboByDataElement(dataElement(DEFAULT_CATEGORY_COMBO_ID), demographyCombo, risRow())
            ).toEqual({ categoryOptionComboId: "", error: "" });
        });

        it("explains which codes have no combination", () => {
            expect(getCategoryOptionComboByOptionCodes(demographyCombo, ["URINE", "M", "UNKO", "15-24"])).toEqual({
                categoryOptionComboId: "",
                error: 'Combination of Specimen, gender, origin, age group not found for codes: "URINE,M,UNKO,15-24"',
            });
        });

        it("scans the combinations once per codes, however many values repeat them", () => {
            let scans = 0;
            const combinations = [...demographyCombo.categoryOptionCombos];
            const find = combinations.find.bind(combinations);
            const combo: CategoryCombo = {
                ...demographyCombo,
                categoryOptionCombos: Object.assign(combinations, {
                    find: (...args: Parameters<typeof find>) => {
                        scans++;
                        return find(...args);
                    },
                }),
            };
            const found = ["BLOOD", "M", "UNKO", "15-24"];
            const missing = ["URINE", "M", "UNKO", "15-24"];
            for (let i = 0; i < 3; i++) {
                expect(getCategoryOptionComboByOptionCodes(combo, found).categoryOptionComboId).toBe(
                    "coc-blood-m-unko-15"
                );
                expect(getCategoryOptionComboByOptionCodes(combo, missing).error).toContain('"URINE,M,UNKO,15-24"');
            }
            expect(scans).toBe(2);
        });
    });

    describe("includeBlockingErrors", () => {
        const summary: ImportSummary = {
            status: "SUCCESS",
            importCount: { imported: 3, updated: 0, ignored: 0, deleted: 0, total: 3 },
            nonBlockingErrors: [],
            blockingErrors: [],
        };

        it("turns the summary into an error when there are blocking errors", () => {
            const result = includeBlockingErrors(summary, [{ error: "Year is different", count: 1 }]);
            expect(result.status).toBe("ERROR");
            expect(result.blockingErrors).toEqual([{ error: "Year is different", count: 1 }]);
        });

        it("keeps the status when there are none", () => {
            expect(includeBlockingErrors(summary, []).status).toBe("SUCCESS");
        });
    });
});
