import { mergeConsistencyErrors } from "../ImportSummary";

describe("mergeConsistencyErrors", () => {
    it("adds up counts and lines of the same error across lists", () => {
        expect(
            mergeConsistencyErrors(
                [{ error: "A", count: 2, lines: [2, 3] }],
                [
                    { error: "A", count: 1, lines: [5002] },
                    { error: "B", count: 1 },
                ]
            )
        ).toEqual([
            { error: "A", count: 3, lines: [2, 3, 5002] },
            { error: "B", count: 1, lines: undefined },
        ]);
    });

    it("does not modify its inputs", () => {
        const first = [{ error: "A", count: 1, lines: [2] }];
        mergeConsistencyErrors(first, [{ error: "A", count: 1, lines: [3] }]);
        expect(first).toEqual([{ error: "A", count: 1, lines: [2] }]);
    });
});
