import { isRetryableError } from "../promises";

/**
 * The status is not always reachable as a number. `Future.fromPromise` rejects with `err.message`
 * only, so a d2-api failure can arrive here as the bare string "400" with the axios error long gone —
 * and treating that as "no status, so retry" sends deterministic failures round the backoff loop.
 */
describe("isRetryableError", () => {
    it("retries transient failures", () => {
        expect(isRetryableError(new Error("socket hang up"))).toBe(true);
        expect(isRetryableError(Object.assign(new Error("boom"), { response: { status: 500 } }))).toBe(true);
        expect(isRetryableError(Object.assign(new Error("slow down"), { response: { status: 429 } }))).toBe(true);
        expect(isRetryableError(new Error("Internal Server Error"))).toBe(true);
    });

    it("does not retry deterministic client failures", () => {
        expect(isRetryableError(Object.assign(new Error("bad"), { response: { status: 400 } }))).toBe(false);
        expect(isRetryableError({ statusCode: 404 })).toBe(false);
        expect(isRetryableError({ status: 409 })).toBe(false);
    });

    it("reads the status out of a string-only rejection", () => {
        expect(isRetryableError("400")).toBe(false);
        expect(isRetryableError("404 Not Found")).toBe(false);
        expect(isRetryableError("Request failed with status code 403")).toBe(false);
        expect(isRetryableError("500")).toBe(true);
        expect(isRetryableError("Request failed with status code 502")).toBe(true);
    });

    it("reads the status out of an Error whose message is all that survived", () => {
        expect(isRetryableError(new Error("400"))).toBe(false);
        expect(isRetryableError(new Error("Request failed with status code 409"))).toBe(false);
        expect(isRetryableError(new Error("503"))).toBe(true);
    });

    it("does not mistake other numbers in a message for a status", () => {
        // Anchored patterns only: an id, a count or a year must not decide retryability.
        expect(isRetryableError(new Error("Product 404 could not be matched"))).toBe(true);
        expect(isRetryableError(new Error("period 2019 and organisation zEYrsiNUGIo failed"))).toBe(true);
        expect(isRetryableError("2019 is not a valid period")).toBe(true);
    });
});
