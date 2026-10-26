import { CancelableResponse } from "@eyeseetea/d2-api/repositories/CancelableResponse";
import { waitForJob } from "../waitForJob";

// A job keeps running in DHIS2 whatever happens to the requests that check on it. The save used to fail on the first
// dropped check (seen on DEV, 26 Oct 2026), reporting an import as stopped while its data was being stored.

type Answer = unknown | Error;

/** Answers each request with the next answer for its URL: an Error rejects, anything else is the response body. */
function fakeApi(answers: Record<string, Answer[]>) {
    const requests: { url: string; timeout?: number }[] = [];
    const api = {
        request: ({ url, timeout }: { url: string; timeout?: number }) => {
            requests.push({ url, timeout });
            const answer = answers[url]?.shift();
            return CancelableResponse.build({
                response: () =>
                    answer instanceof Error
                        ? Promise.reject(answer)
                        : Promise.resolve({ status: 200, data: answer, headers: {} }),
            });
        },
    };
    return { api: api as any, requests };
}

const options = { intervalMs: 0, retryDelayMs: 0 };
const tasks = "/system/tasks/DATAVALUE_IMPORT/job-1";
const summaries = "/system/taskSummaries/DATAVALUE_IMPORT/job-1";
const summary = { status: "SUCCESS", importCount: { imported: 5, updated: 0, ignored: 0, deleted: 0 } };

describe("waitForJob", () => {
    it("polls until the job is completed, then returns its summary", async () => {
        const { api, requests } = fakeApi({
            [tasks]: [[{ completed: false }], [{ completed: false }, { completed: true }]],
            [summaries]: [summary],
        });
        await expect(waitForJob(api, "DATAVALUE_IMPORT", "job-1", options).toPromise()).resolves.toEqual(summary);
        expect(requests.map(r => r.url)).toEqual([tasks, tasks, summaries]);
    });

    it("retries a dropped status check instead of failing the save", async () => {
        const { api } = fakeApi({
            [tasks]: [new Error("socket hang up"), [{ completed: true }]],
            [summaries]: [new Error("socket hang up"), summary],
        });
        await expect(waitForJob(api, "DATAVALUE_IMPORT", "job-1", options).toPromise()).resolves.toEqual(summary);
    });

    it("gives each check a time limit, so a check that never returns is retried", async () => {
        const { api, requests } = fakeApi({ [tasks]: [[{ completed: true }]], [summaries]: [summary] });
        await waitForJob(api, "DATAVALUE_IMPORT", "job-1", { ...options, checkTimeoutMs: 1234 }).toPromise();
        expect(requests.every(r => r.timeout === 1234)).toBe(true);
    });

    it("fails after the set number of attempts of one check", async () => {
        const { api, requests } = fakeApi({ [tasks]: [new Error("a"), new Error("b"), new Error("c")] });
        await expect(
            waitForJob(api, "DATAVALUE_IMPORT", "job-1", { ...options, attemptsPerCheck: 3 }).toPromise()
        ).rejects.toBeDefined();
        expect(requests).toHaveLength(3);
    });

    it("sends nothing until the future runs", () => {
        const { api, requests } = fakeApi({});
        waitForJob(api, "DATAVALUE_IMPORT", "job-1", options);
        expect(requests).toHaveLength(0);
    });
});
