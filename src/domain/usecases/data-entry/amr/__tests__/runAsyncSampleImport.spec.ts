import { Future } from "../../../../entities/Future";
import { GlassUploadsStatus } from "../../../../entities/GlassUploads";
import { ImportSummary } from "../../../../entities/data-entry/ImportSummary";
import { runAsyncSampleImport } from "../runAsyncSampleImport";

// The async uploads server used to write SAMPLE values while the upload said UPLOADED, so a server stopped
// mid-import left values whose upload the app's delete skips (the Norway pattern).

const summary = (blocking = 0): ImportSummary => ({
    status: blocking ? "ERROR" : "SUCCESS",
    importCount: { imported: 5, updated: 0, ignored: 0, deleted: 0, total: 5 },
    nonBlockingErrors: [],
    blockingErrors: Array.from({ length: blocking }, () => ({ error: "bad", count: 1 })),
});

function run(options: { applyDryRun?: boolean; dryRun?: ImportSummary; real?: ImportSummary | "fails" }) {
    const steps: string[] = [];
    const importFile = (dryRun: boolean) =>
        Future.success<void, string>(undefined).flatMap(() => {
            steps.push(dryRun ? "dry run" : "import");
            if (!dryRun && options.real === "fails") return Future.error<string, ImportSummary[]>("socket hang up");
            const result = dryRun ? options.dryRun ?? summary() : (options.real as ImportSummary) ?? summary();
            return Future.success<ImportSummary[], string>([result]);
        });
    const setStatus = (status: GlassUploadsStatus) =>
        Future.success<void, string>(undefined).map(() => void steps.push(status));
    const result = runAsyncSampleImport({ applyDryRun: options.applyDryRun ?? true, importFile, setStatus }).runAsync();
    return { steps, result };
}

describe("runAsyncSampleImport", () => {
    it("marks the upload IMPORTED before the first value is written, then VALIDATED", async () => {
        const { steps, result } = run({});
        expect((await result).data).toBe("VALIDATED");
        expect(steps).toEqual(["dry run", "IMPORTED", "import", "VALIDATED"]);
    });

    it("leaves the status alone after a dry run with errors: nothing was written", async () => {
        const { steps, result } = run({ dryRun: summary(2) });
        expect((await result).data).toBe("NOT_IMPORTED");
        expect(steps).toEqual(["dry run"]);
    });

    it("keeps IMPORTED when the import reports errors", async () => {
        const { steps, result } = run({ real: summary(1) });
        expect((await result).data).toBe("IMPORTED");
        expect(steps).toEqual(["dry run", "IMPORTED", "import", "IMPORTED"]);
    });

    it("leaves the upload IMPORTED when the import fails part-way, so its delete removes the values", async () => {
        const { steps, result } = run({ real: "fails" });
        expect((await result).error).toBe("socket hang up");
        expect(steps).toEqual(["dry run", "IMPORTED", "import"]);
    });

    it("marks IMPORTED first also without a dry run", async () => {
        const { steps, result } = run({ applyDryRun: false });
        await result;
        expect(steps).toEqual(["IMPORTED", "import", "VALIDATED"]);
    });
});
