import { csvTextCell } from "../csv";

describe("csvTextCell", () => {
    it("quotes plain text and doubles embedded quotes", () => {
        expect(csvTextCell('Row 5: value is "X"')).toBe('"Row 5: value is ""X"""');
    });

    it("prefixes an apostrophe when the text could be read as a formula", () => {
        expect(csvTextCell('=HYPERLINK("http://example.org")')).toBe('"\'=HYPERLINK(""http://example.org"")"');
        expect(csvTextCell("+1")).toBe('"\'+1"');
        expect(csvTextCell("-2")).toBe('"\'-2"');
        expect(csvTextCell("@SUM(A1)")).toBe('"\'@SUM(A1)"');
        expect(csvTextCell("\tcmd")).toBe('"\'\tcmd"');
    });

    it("does not touch text with those characters elsewhere", () => {
        expect(csvTextCell("a=b")).toBe('"a=b"');
    });

    it("turns missing values into an empty cell", () => {
        expect(csvTextCell(undefined)).toBe('""');
        expect(csvTextCell(null)).toBe('""');
    });
});
