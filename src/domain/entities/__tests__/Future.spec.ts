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
