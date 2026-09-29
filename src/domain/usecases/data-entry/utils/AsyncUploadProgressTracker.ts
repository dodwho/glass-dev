import { AsyncUploadProgress, isInterrupted } from "../../../entities/AsyncUploadProgress";
import { Future, FutureData } from "../../../entities/Future";
import { generateId, Id } from "../../../entities/Ref";
import { AsyncUploadProgressRepository } from "../../../repositories/AsyncUploadProgressRepository";
import { TrackerRepository } from "../../../repositories/TrackerRepository";
import consoleLogger from "../../../../utils/consoleLogger";
import { undoAsyncUploadImport } from "./undoAsyncUploadImport";

type Repositories = {
    asyncUploadProgressRepository: AsyncUploadProgressRepository;
    trackerRepository: TrackerRepository;
};

/**
 * Keeps the progress record of one async upload import: tracked entity ids are recorded before they are
 * sent, a heartbeat shows the import is alive, and undo() removes whatever a failed import created.
 */
export class AsyncUploadProgressTracker {
    private constructor(private repositories: Repositories, private progress: AsyncUploadProgress) {}

    /** Cleans up an earlier interrupted attempt of the same upload first; refuses if one is still running. */
    static start(
        repositories: Repositories,
        params: { uploadId: Id; orgUnit: Id; trackedEntityType: Id }
    ): FutureData<AsyncUploadProgressTracker> {
        const { asyncUploadProgressRepository } = repositories;

        return asyncUploadProgressRepository.get(params.uploadId).flatMap(previous => {
            if (previous && !isInterrupted(previous)) {
                return Future.error<string, AsyncUploadProgressTracker>(
                    `Upload ${params.uploadId} is already being imported by another process`
                );
            }

            const progress: AsyncUploadProgress = {
                ...params,
                runId: generateId(),
                state: "IN_PROGRESS",
                heartbeatAt: new Date().toISOString(),
                savedIdChunks: 0,
            };

            return (previous ? undoWithFallback(previous, repositories) : Future.success<void, string>(undefined))
                .flatMap(() => asyncUploadProgressRepository.save(progress))
                .map(() => new AsyncUploadProgressTracker(repositories, progress));
        });
    }

    heartbeat(): FutureData<void> {
        return this.update({});
    }

    /** Must complete before the tracked entities are sent, so they can always be found again. */
    recordTrackedEntityIds(trackedEntityIds: Id[]): FutureData<void> {
        const { uploadId, savedIdChunks } = this.progress;
        return this.repositories.asyncUploadProgressRepository
            .saveTrackedEntityIds(uploadId, savedIdChunks, trackedEntityIds)
            .flatMap(() => this.update({ savedIdChunks: savedIdChunks + 1 }));
    }

    /** For an import that sent nothing: the record is no longer needed. */
    finish(): FutureData<void> {
        return this.repositories.asyncUploadProgressRepository.remove(this.progress);
    }

    /** For a successful import: kept until the upload's final status is saved, see removeCompletedProgress. */
    complete(): FutureData<void> {
        return this.update({ state: "COMPLETED" });
    }

    undo(): FutureData<void> {
        return undoWithFallback(this.progress, this.repositories);
    }

    // Aborts if the record is gone or belongs to another run: a recovery process has taken this import over.
    private update(changes: Partial<AsyncUploadProgress>): FutureData<void> {
        const { asyncUploadProgressRepository } = this.repositories;

        return asyncUploadProgressRepository.get(this.progress.uploadId).flatMap(current => {
            if (current?.runId !== this.progress.runId) {
                return Future.error(`Import of upload ${this.progress.uploadId} was taken over by a recovery process`);
            }
            const progress = { ...this.progress, ...changes, heartbeatAt: new Date().toISOString() };
            return asyncUploadProgressRepository.save(progress).map(() => {
                this.progress = progress;
            });
        });
    }
}

/**
 * Undoes an import; if that fails the record is flagged so the next run of the async upload process retries
 * the undo before anything else, and the error is passed on.
 */
function undoWithFallback(progress: AsyncUploadProgress, repositories: Repositories): FutureData<void> {
    return undoAsyncUploadImport(progress, repositories).flatMapError(error => {
        consoleLogger.error(`Undo of upload ${progress.uploadId} failed and will be retried: ${error}`);
        return repositories.asyncUploadProgressRepository
            .save({ ...progress, state: "UNDO_REQUIRED" })
            .flatMapError(() => Future.success<void, string>(undefined))
            .flatMap(() => Future.error<string, void>(`Import could not be undone yet: ${error}`));
    });
}

/** Called once the final status of a successfully imported upload has been saved. */
export function removeCompletedProgress(
    asyncUploadProgressRepository: AsyncUploadProgressRepository,
    uploadId: Id
): FutureData<void> {
    return asyncUploadProgressRepository
        .get(uploadId)
        .flatMap(progress =>
            progress?.state === "COMPLETED"
                ? asyncUploadProgressRepository.remove(progress)
                : Future.success<void, string>(undefined)
        );
}

/**
 * Undoes every import left behind by an interrupted or failed run. Returns the uploads that are now clean.
 * Each upload is handled on its own, so one failing undo does not stop the others.
 */
export function recoverInterruptedAsyncUploads(repositories: Repositories): FutureData<Id[]> {
    return repositories.asyncUploadProgressRepository.getAll().flatMap(progresses =>
        Future.sequential(
            progresses
                .filter(progress => isInterrupted(progress))
                .map(progress =>
                    undoWithFallback(progress, repositories)
                        .map(() => [progress.uploadId])
                        .flatMapError(() => Future.success<Id[], string>([]))
                )
        ).map(recovered => recovered.flat())
    );
}
