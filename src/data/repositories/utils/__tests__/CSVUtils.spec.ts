import { getDateValue, toNumberOrUndefined } from "../CSVUtils";
import { Row } from "../../../../domain/repositories/SpreadsheetXlsxRepository";

function row(value: unknown): Row<string> {
    return { SAMPLE_DATE: value } as unknown as Row<string>;
}

describe("getDateValue", () => {
    it("converts an Excel date serial (from a .xlsx date cell) to ISO YYYY-MM-DD", () => {
        // 45574 is 2024-10-09 in Excel's 1900 date system.
        expect(getDateValue(row(45574), "SAMPLE_DATE")).toBe("2024-10-09");
    });

    it("drops the time part of a fractional serial", () => {
        expect(getDateValue(row(45574.5), "SAMPLE_DATE")).toBe("2024-10-09");
    });

    it("passes literal CSV date strings through unchanged (so format validation can judge them)", () => {
        expect(getDateValue(row("2024-10-09"), "SAMPLE_DATE")).toBe("2024-10-09");
        expect(getDateValue(row("8/5/2024"), "SAMPLE_DATE")).toBe("8/5/2024");
    });

    it("returns an empty string when the value is missing", () => {
        expect(getDateValue({} as Row<string>, "SAMPLE_DATE")).toBe("");
    });
});

describe("toNumberOrUndefined", () => {
    it("parses numeric cells, including zero and negative values", () => {
        expect(toNumberOrUndefined("12")).toBe(12);
        expect(toNumberOrUndefined(" 12.5 ")).toBe(12.5);
        expect(toNumberOrUndefined(0)).toBe(0);
        expect(toNumberOrUndefined("-3")).toBe(-3);
    });

    // A blank mandatory cell must stay blank so validation can block the file, rather than becoming
    // a fabricated 0 that would silently import as real data.
    it("returns undefined for blank, missing and non-numeric cells", () => {
        expect(toNumberOrUndefined("")).toBeUndefined();
        expect(toNumberOrUndefined("   ")).toBeUndefined();
        expect(toNumberOrUndefined(undefined)).toBeUndefined();
        expect(toNumberOrUndefined(null)).toBeUndefined();
        expect(toNumberOrUndefined("N/A")).toBeUndefined();
        expect(toNumberOrUndefined("1,234")).toBeUndefined();
    });
});
