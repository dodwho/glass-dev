import _ from "lodash";
import { AsyncUploadProgress } from "../../../entities/AsyncUploadProgress";
import { Future, FutureData } from "../../../entities/Future";
import { Id } from "../../../entities/Ref";
import { AsyncUploadProgressRepository } from "../../../repositories/AsyncUploadProgressRepository";
import { TrackerRepository } from "../../../repositories/TrackerRepository";
import consoleLogger from "../../../../utils/consoleLogger";
import { deleteTrackedEntities } from "./deleteTrackerData";

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
    const { orgUnit, trackedEntityType } = progress;

    return trackerRepository.getExistingTrackedEntities(recordedIds, trackedEntityType).flatMap(existing => {
        const foreign = existing.filter(
            ({ trackedEntity, orgUnit: foundOrgUnit }) => !recorded.has(trackedEntity) || foundOrgUnit !== orgUnit
        );
        if (foreign.length > 0) {
            return Future.error<string, void>(
                `Undo of upload ${progress.uploadId} stopped without deleting: ${foreign.length} recorded tracked ` +
                    `entities are not in org unit ${orgUnit} (e.g. ${foreign[0]?.trackedEntity})`
            );
        }

        return deleteTrackedEntities(
            existing.map(({ trackedEntity }) => trackedEntity),
            { orgUnit, trackedEntityType },
            // Every recorded id, not only those found above: one whose import was still committing must not be missed.
            () =>
                trackerRepository
                    .getExistingTrackedEntities(recordedIds, trackedEntityType)
                    .map(found => _.map(found, "trackedEntity")),
            trackerRepository
        ).flatMap(({ remaining, failures }) =>
            remaining.length === 0
                ? Future.success<void, string>(undefined)
                : Future.error<string, void>(
                      `Undo of upload ${progress.uploadId}: ${remaining.length} tracked entities still exist after deleting` +
                          (failures.length > 0 ? ` (${failures.length} requests failed, e.g. ${failures[0]})` : "")
                  )
        );
    });
}
