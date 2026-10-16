import { Future } from "../Future";

describe("Future.fromPromise", () => {
    it("keeps the message of a rejected Error", async () => {
        const { error } = await Future.fromPromise(Promise.reject(new Error("boom"))).runAsync();
        expect(error).toBe("boom");
    });

    it("keeps a rejected plain-text error", async () => {
        const { error } = await Future.fromPromise(Promise.reject("DHIS2 could not be reached")).runAsync();
        expect(error).toBe("DHIS2 could not be reached");
    });
});

describe("Future.sequentialUntilConsecutiveFailures", () => {
    const run = (names: string[], failing: string[], maxFailuresInARow: number) => {
        const ran: string[] = [];
        const step = (name: string) =>
            Future.success<void, string>(undefined).flatMap(() => {
                ran.push(name);
                return failing.includes(name) ? Future.error<string, string>(`${name} failed`) : Future.success(name);
            });
        return Future.sequentialUntilConsecutiveFailures(names.map(step), maxFailuresInARow)
            .runAsync()
            .then(({ data }) => ({ ran, result: data }));
    };

    it("carries on after one failure and reports it", async () => {
        const { ran, result } = await run(["a", "b", "c"], ["b"], 2);

        expect(ran).toEqual(["a", "b", "c"]);
        expect(result).toEqual({ successes: ["a", "c"], errors: ["b failed"], notRun: 0 });
    });

    it("stops after the given number of failures in a row, leaving the rest unrun", async () => {
        const { ran, result } = await run(["a", "b", "c", "d", "e"], ["b", "c"], 2);

        expect(ran).toEqual(["a", "b", "c"]);
        expect(result).toEqual({ successes: ["a"], errors: ["b failed", "c failed"], notRun: 2 });
    });

    it("counts only failures in a row: a success in between starts the count again", async () => {
        const { ran, result } = await run(["a", "b", "c", "d", "e"], ["a", "c", "e"], 2);

        expect(ran).toEqual(["a", "b", "c", "d", "e"]);
        expect(result).toEqual({ successes: ["b", "d"], errors: ["a failed", "c failed", "e failed"], notRun: 0 });
    });

    it("stops after the first failure when the limit is 1", async () => {
        const { ran, result } = await run(["a", "b", "c"], ["a"], 1);

        expect(ran).toEqual(["a"]);
        expect(result).toEqual({ successes: [], errors: ["a failed"], notRun: 2 });
    });

    it("does nothing for an empty list", async () => {
        expect((await run([], [], 2)).result).toEqual({ successes: [], errors: [], notRun: 0 });
    });
});
