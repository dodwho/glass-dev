import { DataValue } from "../../../../entities/data-entry/DataValue";
import { CategoryCombo } from "../../../../entities/metadata/CategoryCombo";
import { checkCopiedBatch } from "../checkCopiedBatch";

const option = (code: string) => ({ id: `opt-${code}`, code });
const aoc = (antibiotic: string, batch: string) => ({
    id: `aoc-${antibiotic}-${batch}`,
    name: "",
    categoryOptions: [option("ESCCOL"), option(antibiotic), option(batch)],
});
const dataSet_CC: CategoryCombo = {
    id: "cc",
    name: "Pathogen, antibiotic, batch",
    categories: [],
    categoryOptionCombos: ["DS1", "DS2", "DS3"].flatMap(batch => [
        aoc("AMP", batch),
        aoc("CIP", batch),
        aoc("GEN", batch),
    ]),
};

/** One file row: resistant and susceptible counts, plus ABCLASS, which is not disaggregated by demography. */
const row = (antibiotic: string, batch: string, resistant: string, susceptible = "2"): DataValue[] =>
    [
        ["de-res", resistant, "coc-blood"],
        ["de-sus", susceptible, "coc-blood"],
        ["de-abc", "Penicillins", ""],
    ].map(([dataElement = "", value = "", categoryOptionCombo = ""]) => ({
        dataElement,
        categoryOptionCombo,
        attributeOptionCombo: `aoc-${antibiotic}-${batch}`,
        orgUnit: "ou",
        period: "2024",
        value,
    }));
const file = (batch: string) => [row("AMP", batch, "3"), row("CIP", batch, "5")];
const none = { blockingErrors: [], warnings: [] };

describe("checkCopiedBatch", () => {
    it("blocks a file whose every row is already stored under another dataset (India 2024: DS2 = DS1)", () => {
        const stored = [...file("DS1").flat(), ...row("GEN", "DS1", "1")];
        const { blockingErrors, warnings } = checkCopiedBatch(file("DS2"), stored, dataSet_CC, "DS2");
        expect(blockingErrors).toHaveLength(1);
        expect(blockingErrors[0]?.error).toContain("dataset DS1");
        expect(blockingErrors[0]?.lines).toEqual([1, 2]);
        expect(warnings).toEqual([]);
    });

    it("warns, with the lines, when any row is already stored under another dataset", () => {
        const stored = [...row("CIP", "DS1", "5"), ...row("AMP", "DS1", "9")];
        const { blockingErrors, warnings } = checkCopiedBatch(file("DS2"), stored, dataSet_CC, "DS2");
        expect(blockingErrors).toEqual([]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.error).toContain("1 of the 2 rows");
        expect(warnings[0]?.lines).toEqual([2]);
    });

    it("warns, never blocks, for rows already stored under the dataset being uploaded", () => {
        const { blockingErrors, warnings } = checkCopiedBatch(file("DS2"), file("DS2").flat(), dataSet_CC, "DS2");
        expect(blockingErrors).toEqual([]);
        expect(warnings[0]?.error).toContain("the dataset you chose (DS2)");
    });

    it("compares whole rows: one equal result is not a copy; zeros and the undisaggregated ABCLASS are left out", () => {
        const sameResistantOnly = [...row("AMP", "DS1", "3", "7"), ...row("CIP", "DS1", "5", "7")];
        expect(checkCopiedBatch(file("DS2"), sameResistantOnly, dataSet_CC, "DS2")).toEqual(none);

        const zeros = [row("AMP", "DS2", "0", "0")];
        expect(checkCopiedBatch(zeros, row("AMP", "DS1", "0", "0"), dataSet_CC, "DS2")).toEqual(none);

        const storedZeroNotKept = row("AMP", "DS1", "3", "0").filter(value => value.value !== "0");
        const { warnings } = checkCopiedBatch([row("AMP", "DS2", "3", "0")], storedZeroNotKept, dataSet_CC, "DS2");
        expect(warnings).toEqual([]);
        expect(
            checkCopiedBatch([row("AMP", "DS2", "3", "0")], storedZeroNotKept, dataSet_CC, "DS2").blockingErrors
        ).toHaveLength(1);
    });

    it("ignores values on combos outside the data set", () => {
        const outside = file("DS1")
            .flat()
            .map(value => ({ ...value, attributeOptionCombo: "default" }));
        expect(checkCopiedBatch(file("DS2"), outside, dataSet_CC, "DS2")).toEqual(none);
    });
});
