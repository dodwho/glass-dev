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

describe("Future.sequential", () => {
    // The cron servers (cliAsyncUploads, cliAsyncDeletions) run their queue with Future.sequential. This records what
    // that means for them: the first failing item stops the run, so the items after it wait for the next cron run.
    it("runs the steps in order and stops at the first failure, leaving the later steps unrun", async () => {
        const ran: string[] = [];
        // Lazy: the step starts only when the Future runs, not when it is created.
        const step = (name: string, fails = false) =>
            Future.success<void, string>(undefined).flatMap(() => {
                ran.push(name);
                return fails ? Future.error<string, string>(`${name} failed`) : Future.success<string, string>(name);
            });

        const { error } = await Future.sequential([step("a"), step("b", true), step("c")]).runAsync();

        expect(error).toBe("b failed");
        expect(ran).toEqual(["a", "b"]);
    });

    it("returns the results in order when every step succeeds", async () => {
        const { data } = await Future.sequential([Future.success(1), Future.success(2), Future.success(3)]).runAsync();

        expect(data).toEqual([1, 2, 3]);
    });
});

describe("Future.sequentialWithAccumulation", () => {
    it("carries on after a failure by default and keeps only the successful results", async () => {
        const { data } = await Future.sequentialWithAccumulation([
            Future.success("a"),
            Future.error("b failed"),
            Future.success("c"),
        ]).runAsync();

        expect(data).toEqual({ type: "success", data: ["a", "c"] });
    });

    it("stops at the first failure when asked to, returning what was done before it", async () => {
        const { data } = await Future.sequentialWithAccumulation(
            [Future.success("a"), Future.error("b failed"), Future.success("c")],
            { stopOnError: true }
        ).runAsync();

        expect(data).toEqual({ type: "error", error: "b failed", data: ["a"] });
    });
});
