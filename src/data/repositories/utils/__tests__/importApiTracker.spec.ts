import { CancelableResponse } from "@eyeseetea/d2-api/repositories/CancelableResponse";
import { TrackerPostResponse } from "@eyeseetea/d2-api/api/tracker";
import { D2Api } from "@eyeseetea/d2-api/2.34";
import { importApiTracker } from "../importApiTracker";

const errorReport = {
    status: "ERROR",
    validationReport: {
        errorReports: [
            {
                message: "Value `SECCARE` is not a valid option code in option set `XRVhrEyGN62`",
                errorCode: "E1125",
                trackerType: "ENROLLMENT",
                uid: "g1hXEB13zLw",
            },
        ],
        warningReports: [],
    },
    stats: { created: 0, updated: 0, deleted: 0, ignored: 3, total: 3 },
} as unknown as TrackerPostResponse;

function apiRespondingWith(response: () => Promise<unknown>): D2Api {
    const post = () => CancelableResponse.build({ response: response as () => Promise<any> });
    return { tracker: { post } } as unknown as D2Api;
}

/** Answers each request with the next outcome: an Error rejects, anything else is the response body. */
function apiAnsweringInTurn(outcomes: unknown[]): { api: D2Api; requests: () => number } {
    let requests = 0;
    const api = apiRespondingWith(() => {
        const outcome = outcomes[requests++];
        return outcome instanceof Error
            ? Promise.reject(outcome)
            : Promise.resolve({ status: 200, data: outcome, headers: {} });
    });
    return { api, requests: () => requests };
}

function networkError() {
    return new Error("request to https://dhis2/api/tracker failed, reason: socket hang up");
}

function httpError(status: number, data: unknown) {
    return Object.assign(new Error(String(status)), { response: { status, data, headers: {} } });
}

function runImport(api: D2Api, retryTransientErrors = false) {
    return importApiTracker(
        api,
        { trackedEntities: [] },
        { action: "CREATE_AND_UPDATE", retryTransientErrors }
    ).runAsync();
}

describe("importApiTracker (synchronous)", () => {
    beforeEach(() => {
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "log").mockImplementation(() => {});
        jest.spyOn(Math, "random").mockReturnValue(0); // no backoff wait between retries
    });
    afterEach(() => jest.restoreAllMocks());

    it("returns the import report when DHIS2 answers 409 with it", async () => {
        const api = apiRespondingWith(() => Promise.reject(httpError(409, errorReport)));

        const { data, error } = await runImport(api);

        expect(error).toBeUndefined();
        expect(data).toEqual(errorReport);
    });

    it("returns the report of a successful import unchanged", async () => {
        const okReport = { ...errorReport, status: "OK" };
        const api = apiRespondingWith(() => Promise.resolve({ status: 200, data: okReport, headers: {} }));

        const { data } = await runImport(api);

        expect(data).toEqual(okReport);
    });

    it("fails when a 409 does not carry an import report", async () => {
        const api = apiRespondingWith(() => Promise.reject(httpError(409, { message: "Conflict" })));

        const { data, error } = await runImport(api);

        expect(data).toBeUndefined();
        expect(error).toBeDefined();
    });

    it("retries network failures and server errors when asked to", async () => {
        const okReport = { ...errorReport, status: "OK" };
        const { api, requests } = apiAnsweringInTurn([networkError(), httpError(503, {}), okReport]);

        const { data } = await runImport(api, true);

        expect(requests()).toBe(3);
        expect(data).toEqual(okReport);
    });

    it("gives up after four attempts", async () => {
        const { api, requests } = apiAnsweringInTurn([networkError(), networkError(), networkError(), networkError()]);

        const { error } = await runImport(api, true);

        expect(requests()).toBe(4);
        expect(error).toContain("socket hang up");
    });

    it("does not retry deterministic failures or DHIS2 validation reports", async () => {
        const rejected = apiAnsweringInTurn([httpError(403, { message: "Forbidden" })]);
        expect((await runImport(rejected.api, true)).error).toBe("Forbidden");
        expect(rejected.requests()).toBe(1);

        const invalid = apiAnsweringInTurn([httpError(409, errorReport)]);
        expect((await runImport(invalid.api, true)).data).toEqual(errorReport);
        expect(invalid.requests()).toBe(1);
    });

    it("never retries unless asked to", async () => {
        const { api, requests } = apiAnsweringInTurn([networkError()]);

        const { error } = await runImport(api);

        expect(requests()).toBe(1);
        expect(error).toContain("socket hang up");
    });

    it("fails on other HTTP errors even if the body looks like a report", async () => {
        const api = apiRespondingWith(() => Promise.reject(httpError(500, errorReport)));

        const { data, error } = await runImport(api);

        expect(data).toBeUndefined();
        expect(error).toBeDefined();
    });
});
