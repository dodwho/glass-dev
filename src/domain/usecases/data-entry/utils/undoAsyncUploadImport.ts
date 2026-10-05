import _ from "lodash";
import { AsyncUploadProgress } from "../../../entities/AsyncUploadProgress";
import { Future, FutureData } from "../../../entities/Future";
import { Id } from "../../../entities/Ref";
import { TrackerTrackedEntity } from "../../../entities/TrackedEntityInstance";
import { AsyncUploadProgressRepository } from "../../../repositories/AsyncUploadProgressRepository";
import { TrackerRepository } from "../../../repositories/TrackerRepository";
import consoleLogger from "../../../../utils/consoleLogger";

// DHIS2 deletes tracked entities slowly (measured on UAT: about 1.7 per second in one request) but handles
// several delete requests at once. Sustained over 1,500 records: 5 requests of 50 at a time gave 8.3 per second,
// 10 requests of 20 gave 18 per second, and 20 requests of 10 gave 19, so more than about 10 at once adds nothing.
const DELETE_CHUNK_SIZE = 20;
const DELETE_MAX_CONCURRENCY = 10;

/**
 * Removes every tracked entity a failed or interrupted async upload may have created, then its progress
 * record. Only ids the upload recorded before sending them are considered, and only those that exist in the
 * upload's org unit are deleted. If a recorded id exists anywhere else nothing is deleted and the record is
 * kept, since that can only mean something unexpected happened and must be looked at by a person.
 * Safe to run again after a partial failure: each id list is re-read from DHIS2 before deleting.
 */
export function undoAsyncUploadImport(
    progress: AsyncUploadProgress,
    repositories: { asyncUploadProgressRepository: AsyncUploadProgressRepository; trackerRepository: TrackerRepository }
): FutureData<void> {
    const { asyncUploadProgressRepository } = repositories;
    consoleLogger.debug(`Undoing import of upload ${progress.uploadId} (${progress.savedIdChunks} id lists)`);

    return Future.sequential(
        _.range(progress.savedIdChunks).map(chunkIndex =>
            asyncUploadProgressRepository
                .getTrackedEntityIds(progress.uploadId, chunkIndex)
                .flatMap(ids => deleteRecordedTrackedEntities(progress, ids, repositories.trackerRepository))
                .flatMap(() =>
                    asyncUploadProgressRepository.save({ ...progress, heartbeatAt: new Date().toISOString() })
                )
        )
    )
        .flatMap(() => asyncUploadProgressRepository.remove(progress))
        .map(() => consoleLogger.debug(`Undo of upload ${progress.uploadId} complete: no records left`));
}

function deleteRecordedTrackedEntities(
    progress: AsyncUploadProgress,
    recordedIds: Id[],
    trackerRepository: TrackerRepository
): FutureData<void> {
    const recorded = new Set(recordedIds);

    return trackerRepository
        .getExistingTrackedEntities(recordedIds, progress.trackedEntityType)
        .flatMap(existing => {
            const foreign = existing.filter(
                ({ trackedEntity, orgUnit }) => !recorded.has(trackedEntity) || orgUnit !== progress.orgUnit
            );
            if (foreign.length > 0) {
                return Future.error<string, void>(
                    `Undo of upload ${progress.uploadId} stopped without deleting: ${foreign.length} recorded tracked ` +
                        `entities are not in org unit ${progress.orgUnit} (e.g. ${foreign[0]?.trackedEntity})`
                );
            }

            return Future.parallel(
                _.chunk(existing, DELETE_CHUNK_SIZE).map(chunk =>
                    deleteTrackedEntities(
                        chunk.map(({ trackedEntity }) => trackedEntity),
                        progress,
                        trackerRepository
                    )
                ),
                { maxConcurrency: DELETE_MAX_CONCURRENCY }
            ).map(() => undefined);
        })
        .flatMap(() => trackerRepository.getExistingTrackedEntities(recordedIds, progress.trackedEntityType))
        .flatMap(remaining =>
            remaining.length === 0
                ? Future.success<void, string>(undefined)
                : Future.error<string, void>(
                      `Undo of upload ${progress.uploadId}: ${remaining.length} tracked entities still exist after deleting`
                  )
        );
}

// A failed delete request does not end the undo: whether it worked is decided afterwards by checking that
// none of the recorded ids still exists. Resending a delete is safe for the same reason.
function deleteTrackedEntities(
    ids: Id[],
    progress: AsyncUploadProgress,
    trackerRepository: TrackerRepository
): FutureData<void> {
    const trackedEntities: TrackerTrackedEntity[] = ids.map(id => ({
        trackedEntity: id,
        orgUnit: progress.orgUnit,
        trackedEntityType: progress.trackedEntityType,
        attributes: [],
        enrollments: [],
    }));

    return trackerRepository
        .import({ trackedEntities }, { action: "DELETE", async: false, retryTransientErrors: true })
        .map(response => {
            if (response.status !== "OK") {
                const reason = response.validationReport?.errorReports?.[0]?.message ?? response.status;
                consoleLogger.error(`Undo of upload ${progress.uploadId}: delete request not accepted (${reason})`);
            }
        })
        .flatMapError(error => {
            consoleLogger.error(`Undo of upload ${progress.uploadId}: delete request failed (${error})`);
            return Future.success<void, string>(undefined);
        });
}
