import _ from "lodash";
import { ImportSummary } from "../../../entities/data-entry/ImportSummary";
import { Future, FutureData } from "../../../entities/Future";
import { Id } from "../../../entities/Ref";
import { TrackerPostRequest } from "../../../entities/TrackedEntityInstance";
import { TrackerRepository } from "../../../repositories/TrackerRepository";

// DHIS2 deletes tracker data slowly in one request or background job (measured on UAT: about 2 tracked entities
// or 9 events per second) but handles several delete requests at once. Sustained over 1,500 tracked entities:
// 5 requests of 50 at a time gave 8.3 per second, 10 requests of 20 gave 18, and 20 requests of 10 gave 19, so
// more than about 10 at once adds nothing. Events: 165 per second with 10 requests of 20.
const DELETE_CHUNK_SIZE = 20;
const DELETE_MAX_CONCURRENCY = 10;

export type DeleteResult = {
    /** Number of records asked to be deleted. */
    total: number;
    /** Ids that still exist after deleting. */
    remaining: Id[];
    /** Why requests failed or were not accepted. Harmless when nothing remains (e.g. a resend of a delete that went through). */
    failures: string[];
};

type ExistingIdsLookup = (ids: Id[]) => FutureData<Id[]>;

/** Deletes tracked entities, with their enrollments and events. See deleteAndConfirm. */
export function deleteTrackedEntities(
    ids: Id[],
    target: { orgUnit: Id; trackedEntityType: Id },
    getExistingIds: ExistingIdsLookup,
    trackerRepository: TrackerRepository
): FutureData<DeleteResult> {
    return deleteAndConfirm(
        ids,
        chunk => ({
            trackedEntities: chunk.map(id => ({ trackedEntity: id, ...target, attributes: [], enrollments: [] })),
        }),
        getExistingIds,
        trackerRepository
    );
}

/** Deletes events of an event program. See deleteAndConfirm. */
export function deleteEvents(
    ids: Id[],
    getExistingIds: ExistingIdsLookup,
    trackerRepository: TrackerRepository
): FutureData<DeleteResult> {
    return deleteAndConfirm(
        ids,
        chunk => ({
            events: chunk.map(id => ({
                event: id,
                program: "",
                programStage: "",
                status: "COMPLETED",
                orgUnit: "",
                occurredAt: "",
                attributeOptionCombo: "",
                dataValues: [],
            })),
        }),
        getExistingIds,
        trackerRepository
    );
}

/** An upload's delete summary: a success only when none of the records still exists. */
export function getDeleteImportSummary({ total, remaining, failures }: DeleteResult): ImportSummary {
    const notDeleted = remaining.length;
    const failureErrors = _(failures)
        .countBy()
        .map((count, error) => ({ error, count }))
        .value();

    return {
        status: notDeleted === 0 ? "SUCCESS" : "ERROR",
        importCount: { imported: 0, updated: 0, ignored: notDeleted, deleted: total - notDeleted, total },
        nonBlockingErrors: [],
        blockingErrors:
            notDeleted === 0
                ? []
                : [
                      {
                          error: `${notDeleted} of ${total} records could not be deleted. Delete the upload again to retry.`,
                          count: notDeleted,
                      },
                      ...failureErrors,
                  ],
    };
}

// Sends direct requests of DELETE_CHUNK_SIZE records, DELETE_MAX_CONCURRENCY at a time. A failed request does not
// stop the others: whether the deletion worked is decided afterwards by reading which ids still exist, so a
// resent request whose first attempt did go through ("does not exist") is not reported as a failure. The failures
// are returned rather than logged, for the caller to report with its context when records are left.
function deleteAndConfirm(
    requestedIds: Id[],
    toRequest: (chunk: Id[]) => TrackerPostRequest,
    getExistingIds: ExistingIdsLookup,
    trackerRepository: TrackerRepository
): FutureData<DeleteResult> {
    // A repeated id would be sent in two requests, and DHIS2 rejects the whole request that arrives second.
    const ids = _.uniq(requestedIds);

    return Future.parallel(
        _.chunk(ids, DELETE_CHUNK_SIZE).map(chunk =>
            trackerRepository
                .import(toRequest(chunk), { action: "DELETE", async: false, retryTransientErrors: true })
                .map(response =>
                    response.status === "ERROR"
                        ? response.validationReport?.errorReports?.[0]?.message ?? "Delete request not accepted"
                        : undefined
                )
                .flatMapError(error => Future.success<string | undefined, string>(`Delete request failed: ${error}`))
        ),
        { maxConcurrency: DELETE_MAX_CONCURRENCY }
    ).flatMap(results =>
        getExistingIds(ids).map(remaining => ({ total: ids.length, remaining, failures: _.compact(results) }))
    );
}
