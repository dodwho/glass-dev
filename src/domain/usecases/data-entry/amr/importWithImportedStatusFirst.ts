import { Future, FutureData } from "../../../entities/Future";
import { GlassUploadsStatus } from "../../../entities/GlassUploads";
import { Id } from "../../../entities/Ref";

/** dataMayRemain: the import had started, so the uploads stay IMPORTED and must be deleted before a new upload. */
export type FailedImport = { error: string; dataMayRemain: boolean };

/**
 * Runs the real import of AMR aggregate uploads so that an import that stops part-way never leaves values behind an
 * upload that still says UPLOADED (whose delete used to leave them). Each upload is marked IMPORTED first ("values may
 * be stored", so its delete removes them). If the import fails, the values written so far are deleted at once, but
 * the uploads stay IMPORTED: DHIS2 can go on writing an import after the app stopped waiting for it (a dropped
 * connection, or the other file of the pair failing), and only an IMPORTED upload's delete removes those values.
 * On success the caller saves the final status from the import summaries.
 */
export function importWithImportedStatusFirst<Result>(options: {
    uploadIds: Id[];
    setStatus: (id: Id, status: GlassUploadsStatus) => FutureData<void>;
    runImport: () => FutureData<Result>;
    removeImportedValues: () => FutureData<void>;
}): Future<FailedImport, Result> {
    const { uploadIds, setStatus, runImport, removeImportedValues } = options;

    return Future.sequential(uploadIds.map(id => setStatus(id, "IMPORTED")))
        .mapError((error): FailedImport => ({ error, dataMayRemain: false }))
        .flatMap(() =>
            runImport().flatMapError(error =>
                removeImportedValues()
                    .flatMapError(() => Future.success<void, FailedImport>(undefined))
                    .flatMap(() => Future.error<FailedImport, Result>({ error, dataMayRemain: true }))
            )
        );
}
