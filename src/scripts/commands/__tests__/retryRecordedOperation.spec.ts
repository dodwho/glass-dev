import { createChangeRecorder, retryRecordedOperation } from "../recordingRepositories";

/**
 * The retry itself is `retryAsync`, already covered elsewhere. What is specific here — and easy to
 * get wrong — is that the change recorder must survive a retry without double counting: the
 * recording decorators count rows as they are sent, so an attempt that wrote a chunk and then threw
 * has already bumped the counts before the next attempt writes the same rows again.
 */
describe("retryRecordedOperation", () => {
    const options = { attempts: 3, baseDelayMs: 0 };

    it("counts a retried operation once, not once per attempt", async () => {
        const recorder = createChangeRecorder();
        let attempts = 0;

        const result = await retryRecordedOperation(
            recorder,
            async () => {
                attempts++;
                // Every attempt records its writes, exactly as the decorated repository would.
                recorder.substanceLevel.updates += 10;
                recorder.substanceLevel.deletes += 2;
                recorder.deletedEventIds.push("evt1", "evt2");
                if (attempts < 3) throw new Error("Internal Server Error");
                return "done";
            },
            options
        );

        expect(result).toBe("done");
        expect(attempts).toBe(3);
        expect(recorder.substanceLevel).toEqual({ updates: 10, creates: 0, deletes: 2 });
        expect(recorder.deletedEventIds).toEqual(["evt1", "evt2"]);
    });

    it("keeps counts recorded before the retried operation started", async () => {
        const recorder = createChangeRecorder();
        // The product pass already ran for this pair; its counts must not be disturbed by the
        // substance pass retrying.
        recorder.productLevel.updates = 7;
        let attempts = 0;

        await retryRecordedOperation(
            recorder,
            async () => {
                attempts++;
                recorder.substanceLevel.creates += 4;
                if (attempts < 2) throw new Error("Internal Server Error");
                return undefined;
            },
            options
        );

        expect(recorder.productLevel.updates).toBe(7);
        expect(recorder.substanceLevel.creates).toBe(4);
    });

    it("reports each retry that will actually follow, and not the final failure", async () => {
        const recorder = createChangeRecorder();
        const retries: number[] = [];

        await expect(
            retryRecordedOperation(
                recorder,
                async () => {
                    throw new Error("Internal Server Error");
                },
                { ...options, onRetry: attempt => retries.push(attempt) }
            )
        ).rejects.toThrow("Internal Server Error");

        // 3 attempts means 2 retries: the third failure is the end of the road, not a retry.
        expect(retries).toEqual([1, 2]);
    });

    it("gives up immediately on a deterministic 4xx", async () => {
        const recorder = createChangeRecorder();
        let attempts = 0;
        const conflict = Object.assign(new Error("Conflict"), { response: { status: 409 } });

        await expect(
            retryRecordedOperation(
                recorder,
                async () => {
                    attempts++;
                    throw conflict;
                },
                options
            )
        ).rejects.toThrow("Conflict");

        expect(attempts).toBe(1);
    });

    it("does not retry when attempts is 1", async () => {
        const recorder = createChangeRecorder();
        let attempts = 0;

        await expect(
            retryRecordedOperation(
                recorder,
                async () => {
                    attempts++;
                    throw new Error("Internal Server Error");
                },
                { attempts: 1, baseDelayMs: 0 }
            )
        ).rejects.toThrow("Internal Server Error");

        expect(attempts).toBe(1);
    });
});
