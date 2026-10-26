import { describe, expect, it } from "vitest";
import { CheckedUnit, findCoverageMismatches } from "../amrAggCoverageCheck";

function unit(overrides: Partial<CheckedUnit> = {}): CheckedUnit {
    return {
        orgUnitCode: "JOR",
        orgUnitId: "ou-jor",
        year: "2024",
        status: "SUCCEEDED",
        dataValuesRead: 10,
        ...overrides,
    };
}

describe("findCoverageMismatches", () => {
    it("reports data without an upload and an upload without data", () => {
        const units = [
            unit({ orgUnitCode: "KEN", orgUnitId: "ou-ken", dataValuesRead: 0 }),
            unit(),
            unit({ year: "2023" }),
        ];
        const keys = new Set(["ou-ken|2024|RIS", "ou-jor|2023|RIS"]);

        expect(findCoverageMismatches("RIS", units, keys)).toEqual([
            { fileType: "RIS", orgUnitCode: "JOR", year: "2024", issue: "DATA_WITHOUT_UPLOAD" },
            { fileType: "RIS", orgUnitCode: "KEN", year: "2024", issue: "UPLOAD_WITHOUT_DATA" },
        ]);
    });

    it("matches on the file type, so a SAMPLE upload does not cover RIS data", () => {
        expect(findCoverageMismatches("RIS", [unit()], new Set(["ou-jor|2024|SAMPLE"]))).toHaveLength(1);
    });

    it("leaves out failed units and empty units with no upload", () => {
        const units = [unit({ status: "FAILED", dataValuesRead: 0 }), unit({ orgUnitId: "x", dataValuesRead: 0 })];
        expect(findCoverageMismatches("RIS", units, new Set(["ou-jor|2024|RIS"]))).toEqual([]);
    });
});
