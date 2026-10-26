import { Future, FutureData } from "../../../entities/Future";
import { GlassUploadsStatus } from "../../../entities/GlassUploads";
import { ImportSummary } from "../../../entities/data-entry/ImportSummary";

export type AsyncSampleImportResult = "NOT_IMPORTED" | "VALIDATED" | "IMPORTED";

const hasBlockingErrors = (summaries: ImportSummary[]) => summaries.some(summary => summary.blockingErrors.length > 0);

/**
 * The status steps of a SAMPLE file imported by the async uploads server, as the app does for its own imports
 * (importWithImportedStatusFirst). After a dry run with errors nothing is written and the status is left as it is:
 * UPLOADED, or IMPORTED if an earlier attempt was stopped mid-import (its values may be stored, so it must stay
 * deletable). Otherwise the upload is marked IMPORTED before the first value is written, so a server stopped mid-import
 * never leaves stored values behind an UPLOADED upload, whose delete in the app skips its values; then it ends
 * VALIDATED, or IMPORTED if the import reported errors.
 */
export function runAsyncSampleImport(steps: {
    applyDryRun: boolean;
    importFile: (dryRun: boolean) => FutureData<ImportSummary[]>;
    setStatus: (status: GlassUploadsStatus) => FutureData<void>;
}): FutureData<AsyncSampleImportResult> {
    const { applyDryRun, importFile, setStatus } = steps;

    const importForReal = (): FutureData<AsyncSampleImportResult> =>
        setStatus("IMPORTED")
            .flatMap(() => importFile(false))
            .flatMap(summaries => {
                const result: AsyncSampleImportResult = hasBlockingErrors(summaries) ? "IMPORTED" : "VALIDATED";
                return setStatus(result).map(() => result);
            });

    if (!applyDryRun) return importForReal();
    return importFile(true).flatMap(summaries =>
        hasBlockingErrors(summaries) ? Future.success<AsyncSampleImportResult, string>("NOT_IMPORTED") : importForReal()
    );
}
