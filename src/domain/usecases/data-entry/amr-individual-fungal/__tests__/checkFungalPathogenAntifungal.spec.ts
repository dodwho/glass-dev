import { CustomDataColumns } from "../../../../entities/data-entry/amr-individual-fungal-external/RISIndividualFungalData";
import { checkFungalPathogenAntifungal, FUNGAL_COMBINATION_ERROR } from "../checkFungalPathogenAntifungal";

function row(values: Record<string, string>): CustomDataColumns {
    return Object.entries(values).map(([key, value]) => ({ key, type: "string", value }));
}

function isRejected(values: Record<string, string>): boolean {
    return checkFungalPathogenAntifungal([row(values)], 2).length > 0;
}

describe("checkFungalPathogenAntifungal", () => {
    it("allows anything when no antifungal result is given", () => {
        expect(isRejected({ PATHOGEN: "ACISPP", ANTIBIOTIC: "XXX" })).toBe(false);
        expect(isRejected({ PATHOGEN: "cal", ANTIBIOTIC: "XXX", RESULTMICSIR: "" })).toBe(false);
    });

    it("rejects any result for a pathogen that must not have antifungal results", () => {
        expect(isRejected({ PATHOGEN: "ACISPP", ANTIBIOTIC: "FLU", RESULTETESTSIR: "S" })).toBe(true);
        expect(isRejected({ PATHOGEN: "kma", ANTIBIOTIC: "", RESULTZONESIR: "R" })).toBe(true);
    });

    it("rejects an antifungal outside the pathogen's allowed list", () => {
        expect(isRejected({ PATHOGEN: "cgu", ANTIBIOTIC: "FLU", RESULTMICSIR: "S" })).toBe(true);
        expect(isRejected({ PATHOGEN: "cdu", ANTIBIOTIC: "ANI", RESULTMICSIR: "S" })).toBe(true);
    });

    it("allows an antifungal in the pathogen's allowed list, or an empty antifungal", () => {
        expect(isRejected({ PATHOGEN: "cgu", ANTIBIOTIC: "MIF", RESULTMICSIR: "S" })).toBe(false);
        expect(isRejected({ PATHOGEN: "cal", ANTIBIOTIC: "", RESULTMICSIR: "S" })).toBe(false);
    });

    it("allows pathogens on neither list, and compares codes case-sensitively", () => {
        expect(isRejected({ PATHOGEN: "cxx", ANTIBIOTIC: "ZZZ", RESULTMICSIR: "S" })).toBe(false);
        expect(isRejected({ PATHOGEN: "acispp", ANTIBIOTIC: "FLU", RESULTMICSIR: "S" })).toBe(false);
        expect(isRejected({ PATHOGEN: "cgu", ANTIBIOTIC: "mif", RESULTMICSIR: "S" })).toBe(true);
    });

    it("reports each offending row once, with its file line", () => {
        const rows = [
            row({ PATHOGEN: "cgu", ANTIBIOTIC: "FLU", RESULTMICSIR: "S", RESULTZONESIR: "R" }),
            row({ PATHOGEN: "cgu", ANTIBIOTIC: "MIF", RESULTMICSIR: "S" }),
            row({ PATHOGEN: "ESCCOL", ANTIBIOTIC: "", RESULTETESTSIR: "I" }),
        ];

        expect(checkFungalPathogenAntifungal(rows, 10)).toEqual([
            { error: FUNGAL_COMBINATION_ERROR, count: 2, lines: [10, 12] },
        ]);
    });
});
