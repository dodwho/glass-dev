import { describe, expect, it, vi } from "vitest";
import { Future, FutureData } from "../../../../entities/Future";
import { GlassUploadsStatus } from "../../../../entities/GlassUploads";
import { FailedImport, importWithImportedStatusFirst } from "../importWithImportedStatusFirst";

// The real AMR aggregate import runs after the dry run. If it stops part-way while the upload still says UPLOADED,
// the stored values can no longer be deleted from the app (Norway 2024, PROD). The upload must say IMPORTED before
// the first value is written, and keep saying it if the import fails.

function setUp(options: { importResult: FutureData<string>; removeResult?: FutureData<void>; failStatus?: boolean }) {
    const steps: string[] = [];
    // Like a real request, the status is saved when the future runs, not when it is created
    const setStatus = (id: string, status: GlassUploadsStatus) =>
        Future.success<void, string>(undefined).flatMap(() => {
            steps.push(`${id}:${status}`);
            return options.failStatus
                ? Future.error<string, void>("status not saved")
                : Future.success<void, string>(undefined);
        });
    const runImport = vi.fn(() => {
        steps.push("import");
        return options.importResult;
    });
    const removeImportedValues = vi.fn(() => {
        steps.push("remove values");
        return options.removeResult ?? Future.success<void, string>(undefined);
    });

    const result = importWithImportedStatusFirst({
        uploadIds: ["ris", "sample"],
        setStatus,
        runImport,
        removeImportedValues,
    }).runAsync() as Promise<{ data?: string; error?: FailedImport }>;

    return { steps, result };
}

describe("importWithImportedStatusFirst", () => {
    it("marks every upload IMPORTED before the import starts and leaves the final status to the caller", async () => {
        const { steps, result } = setUp({ importResult: Future.success("summary") });

        expect(await result).toEqual({ data: "summary" });
        expect(steps).toEqual(["ris:IMPORTED", "sample:IMPORTED", "import"]);
    });

    it("removes the values at once when the import fails and keeps the uploads IMPORTED", async () => {
        const { steps, result } = setUp({ importResult: Future.error("socket hang up") });

        expect(await result).toEqual({ error: { error: "socket hang up", dataMayRemain: true } });
        expect(steps).toEqual(["ris:IMPORTED", "sample:IMPORTED", "import", "remove values"]);
    });

    it("reports the import error, not the removal error, when the values cannot be removed either", async () => {
        const { steps, result } = setUp({
            importResult: Future.error("socket hang up"),
            removeResult: Future.error("network down"),
        });

        expect(await result).toEqual({ error: { error: "socket hang up", dataMayRemain: true } });
        expect(steps).toEqual(["ris:IMPORTED", "sample:IMPORTED", "import", "remove values"]);
    });

    it("never starts the import when an upload cannot be marked IMPORTED", async () => {
        const { steps, result } = setUp({ importResult: Future.success("summary"), failStatus: true });

        expect(await result).toEqual({ error: { error: "status not saved", dataMayRemain: false } });
        expect(steps).toEqual(["ris:IMPORTED"]);
    });
});
