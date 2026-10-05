import { CustomDataColumns } from "../../../../entities/data-entry/amr-individual-fungal-external/RISIndividualFungalData";
import { checkValuesAgainstProgramMetadata, ProgramFieldMetadata } from "../checkValuesAgainstProgramMetadata";

const fields: ProgramFieldMetadata[] = [
    {
        code: "HCF_TYPE",
        valueType: "TEXT",
        optionSetValue: true,
        optionSet: { options: [{ code: "PRCARE" }, { code: "SECARE" }] },
    },
    { code: "RESULTZONEVALUE", valueType: "INTEGER_ZERO_OR_POSITIVE" },
    { code: "RESULTMICVALUE", valueType: "NUMBER" },
    { code: "AGE", valueType: "TEXT" },
];

function row(values: Record<string, string | number | undefined>): CustomDataColumns {
    return Object.entries(values).map(([key, value]) =>
        typeof value === "number" ? { key, type: "number", value } : { key, type: "string", value }
    );
}

describe("checkValuesAgainstProgramMetadata", () => {
    it("accepts valid and empty values", () => {
        const rows = [
            row({ HCF_TYPE: "SECARE", RESULTZONEVALUE: 0, RESULTMICVALUE: 0.25, AGE: "anything" }),
            row({ HCF_TYPE: "", RESULTZONEVALUE: undefined, RESULTMICVALUE: undefined, AGE: "" }),
        ];
        expect(checkValuesAgainstProgramMetadata(rows, fields, 2)).toEqual([]);
    });

    it("rejects option codes that do not match exactly", () => {
        const rows = [row({ HCF_TYPE: "SECCARE" }), row({ HCF_TYPE: "secare" }), row({ HCF_TYPE: "SECCARE" })];

        expect(checkValuesAgainstProgramMetadata(rows, fields, 2)).toEqual([
            {
                error: 'HCF_TYPE: "SECCARE" is not an allowed code (codes are case-sensitive). Allowed codes: PRCARE, SECARE',
                count: 2,
                lines: [2, 4],
            },
            {
                error: 'HCF_TYPE: "secare" is not an allowed code (codes are case-sensitive). Allowed codes: PRCARE, SECARE',
                count: 1,
                lines: [3],
            },
        ]);
    });

    it("tells the country that SDD is not accepted, whatever its letter case", () => {
        const sirFields: ProgramFieldMetadata[] = [
            {
                code: "RESULTMICSIR",
                valueType: "TEXT",
                optionSetValue: true,
                optionSet: { options: [{ code: "S" }, { code: "I" }, { code: "R" }] },
            },
        ];
        const errors = checkValuesAgainstProgramMetadata(
            [row({ RESULTMICSIR: "SDD" }), row({ RESULTMICSIR: "sdd" }), row({ RESULTMICSIR: "X" })],
            sirFields,
            2
        );

        expect(errors.map(({ error, lines }) => [error, lines])).toEqual([
            [
                'RESULTMICSIR: "SDD" is not an allowed code (codes are case-sensitive). Allowed codes: S, I, R. SDD (susceptible, dose-dependent) is not accepted by GLASS: report these results with one of the allowed codes, following the GLASS protocol, before uploading the file again',
                [2],
            ],
            [
                'RESULTMICSIR: "sdd" is not an allowed code (codes are case-sensitive). Allowed codes: S, I, R. SDD (susceptible, dose-dependent) is not accepted by GLASS: report these results with one of the allowed codes, following the GLASS protocol, before uploading the file again',
                [3],
            ],
            ['RESULTMICSIR: "X" is not an allowed code (codes are case-sensitive). Allowed codes: S, I, R', [4]],
        ]);
    });

    it("rejects decimal and negative values for zero-or-positive integers", () => {
        const errors = checkValuesAgainstProgramMetadata(
            [row({ RESULTZONEVALUE: 5.5 }), row({ RESULTZONEVALUE: -1 }), row({ RESULTZONEVALUE: 12 })],
            fields,
            2
        );
        expect(errors.map(({ error, lines }) => [error, lines])).toEqual([
            ['RESULTZONEVALUE: "5.5" must be a whole number of zero or more', [2]],
            ['RESULTZONEVALUE: "-1" must be a whole number of zero or more', [3]],
        ]);
    });

    it("rejects text in a number field", () => {
        const errors = checkValuesAgainstProgramMetadata([row({ RESULTMICVALUE: "<0.5" })], fields, 7);
        expect(errors).toEqual([{ error: 'RESULTMICVALUE: "<0.5" is not a valid number', count: 1, lines: [7] }]);
    });
});
