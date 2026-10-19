import { vi } from "vitest";
import { noteDhis2Response, reportSignsOfLife } from "../jobActivity";

const INTERVAL_MS = 10 * 60 * 1000;

async function advance(ms: number) {
    vi.advanceTimersByTime(ms);
    // Let the report's promise chain settle.
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("reportSignsOfLife", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("does not report while DHIS2 has not answered anything", async () => {
        const report = vi.fn(() => Promise.resolve());
        const stop = reportSignsOfLife(report, INTERVAL_MS);

        await advance(3 * INTERVAL_MS);

        expect(report).not.toHaveBeenCalled();
        await stop();
    });

    it("reports once per interval in which DHIS2 answered", async () => {
        const report = vi.fn(() => Promise.resolve());
        const stop = reportSignsOfLife(report, INTERVAL_MS);

        vi.advanceTimersByTime(1000);
        noteDhis2Response();
        await advance(INTERVAL_MS);
        expect(report).toHaveBeenCalledTimes(1);

        // The job is now blocked on a request that never returns: no more reports.
        await advance(3 * INTERVAL_MS);
        expect(report).toHaveBeenCalledTimes(1);

        noteDhis2Response();
        await advance(INTERVAL_MS);
        expect(report).toHaveBeenCalledTimes(2);
        await stop();
    });

    it("does not count the report's own request as activity", async () => {
        const report = vi.fn(() => {
            noteDhis2Response();
            return Promise.resolve();
        });
        const stop = reportSignsOfLife(report, INTERVAL_MS);

        vi.advanceTimersByTime(1000);
        noteDhis2Response();
        await advance(INTERVAL_MS);
        await advance(3 * INTERVAL_MS);

        expect(report).toHaveBeenCalledTimes(1);
        await stop();
    });

    it("retries a failed report at the next interval", async () => {
        const report = vi
            .fn<() => Promise<void>>()
            .mockReturnValueOnce(Promise.reject("network error"))
            .mockReturnValue(Promise.resolve());
        const stop = reportSignsOfLife(report, INTERVAL_MS);

        vi.advanceTimersByTime(1000);
        noteDhis2Response();
        await advance(INTERVAL_MS);
        await advance(INTERVAL_MS);

        expect(report).toHaveBeenCalledTimes(2);
        await stop();
    });

    it("stops reporting, and waits for a report still in flight", async () => {
        let finishReport: () => void = () => {};
        const report = vi.fn(() => new Promise<void>(resolve => (finishReport = resolve)));
        const stop = reportSignsOfLife(report, INTERVAL_MS);

        vi.advanceTimersByTime(1000);
        noteDhis2Response();
        await advance(INTERVAL_MS);
        expect(report).toHaveBeenCalledTimes(1);

        let stopped = false;
        const stopping = stop().then(() => (stopped = true));
        await advance(0);
        expect(stopped).toBe(false);

        finishReport();
        await stopping;
        expect(stopped).toBe(true);

        noteDhis2Response();
        await advance(3 * INTERVAL_MS);
        expect(report).toHaveBeenCalledTimes(1);
    });
});
