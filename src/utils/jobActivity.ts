let lastDhis2ResponseTime = 0;

/** Called whenever DHIS2 answers a request, so a long server job can show it is still working. */
export function noteDhis2Response(): void {
    lastDhis2ResponseTime = Date.now();
}

/**
 * While a long job runs, calls report() every intervalMs, but only if DHIS2 has answered a request since the
 * last report: a job blocked on a request that never returns (there is no request timeout) stops reporting,
 * so it can be recovered. The returned function stops the reports and waits for one in flight to end.
 */
export function reportSignsOfLife(report: () => Promise<void>, intervalMs: number): () => Promise<void> {
    // The report's own request is answered before reportedAt is set, so it never counts as activity.
    let reportedAt = Date.now();
    let inFlight: Promise<void> | undefined;

    const timer = setInterval(() => {
        if (inFlight || lastDhis2ResponseTime <= reportedAt) return;
        inFlight = report()
            .then(() => {
                reportedAt = Date.now();
            })
            // A failed report is retried at the next interval; the caller logs it.
            .catch(() => undefined)
            .finally(() => {
                inFlight = undefined;
            });
    }, intervalMs);

    return async () => {
        clearInterval(timer);
        await inFlight;
    };
}
