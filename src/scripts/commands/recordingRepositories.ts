import { TrackerPostResponse } from "@eyeseetea/d2-api/api/tracker";
import { Future, FutureData } from "../../domain/entities/Future";
import { Id } from "../../domain/entities/Ref";
import { AMCProductDataRepository } from "../../domain/repositories/data-entry/AMCProductDataRepository";
import { AMCSubstanceDataRepository } from "../../domain/repositories/data-entry/AMCSubstanceDataRepository";
import { isRetryableError, retryAsync } from "../../utils/promises";

/**
 * Repository decorators that record what the pipeline writes.
 *
 * Every read is delegated untouched, so the whole pipeline — fetching, the DDD/ATC arithmetic, the
 * matcher, the create/update/delete classification — behaves exactly as it would undecorated. Only
 * the three mutating calls are wrapped:
 *
 *   - mode "apply": delegate to the real repository, then record what was sent;
 *   - mode "plan":  record only, and return a synthetic success so the pipeline continues.
 *
 * One decorator for both modes means the audit trail and the rehearsal measure the same thing.
 */

export type ChangeCounts = { updates: number; creates: number; deletes: number };

export type ChangeRecorder = {
    productLevel: ChangeCounts;
    substanceLevel: ChangeCounts;
    deletedEventIds: Id[];
};

export function createChangeRecorder(): ChangeRecorder {
    return {
        productLevel: { updates: 0, creates: 0, deletes: 0 },
        substanceLevel: { updates: 0, creates: 0, deletes: 0 },
        deletedEventIds: [],
    };
}

export function resetChangeRecorder(recorder: ChangeRecorder): void {
    recorder.productLevel = { updates: 0, creates: 0, deletes: 0 };
    recorder.substanceLevel = { updates: 0, creates: 0, deletes: 0 };
    recorder.deletedEventIds = [];
}

/**
 * Point-in-time copy of the recorder. A retried attempt restores it first, so writes recorded by the
 * attempt that failed are not counted a second time by the attempt that succeeds.
 */
export function snapshotChangeRecorder(recorder: ChangeRecorder): ChangeRecorder {
    return {
        productLevel: { ...recorder.productLevel },
        substanceLevel: { ...recorder.substanceLevel },
        deletedEventIds: [...recorder.deletedEventIds],
    };
}

export function restoreChangeRecorder(recorder: ChangeRecorder, snapshot: ChangeRecorder): void {
    recorder.productLevel = { ...snapshot.productLevel };
    recorder.substanceLevel = { ...snapshot.substanceLevel };
    recorder.deletedEventIds = [...snapshot.deletedEventIds];
}

export type RetryRecordedOptions = {
    attempts: number;
    baseDelayMs: number;
    /** Called only when a further attempt will actually follow, for logging. */
    onRetry?: (attempt: number, error: unknown) => void;
};

/**
 * Runs `operation` under `retryAsync` while keeping `recorder` truthful.
 *
 * Retrying a partially applied write is the whole difficulty here: the decorators above count rows as
 * they are sent, so an attempt that imported one chunk and then threw has already bumped the counts.
 * Every attempt therefore restarts from the counts as they stood before the first one, and only the
 * attempt that finally succeeds contributes to the audit row.
 */
export async function retryRecordedOperation<T>(
    recorder: ChangeRecorder,
    operation: () => Promise<T>,
    options: RetryRecordedOptions
): Promise<T> {
    const { attempts, baseDelayMs, onRetry } = options;
    const snapshot = snapshotChangeRecorder(recorder);
    let attempt = 0;

    return retryAsync(
        async () => {
            attempt++;
            if (attempt > 1) restoreChangeRecorder(recorder, snapshot);

            try {
                return await operation();
            } catch (error) {
                if (attempt < attempts && isRetryableError(error)) onRetry?.(attempt, error);
                throw error;
            }
        },
        { attempts, baseDelayMs }
    );
}

export type RecordingMode = "apply" | "plan";

function syntheticOkResponse(stats: { created: number; updated: number; deleted: number }): TrackerPostResponse {
    return {
        status: "OK",
        validationReport: { errorReports: [], warningReports: [] },
        stats: { ...stats, ignored: 0, total: stats.created + stats.updated + stats.deleted },
        bundleReport: { typeReportMap: {}, status: "OK", stats: { ...stats, ignored: 0, total: 0 } },
    } as unknown as TrackerPostResponse;
}

function splitByEventId<T extends { eventId?: Id }>(rows: T[]): { updates: number; creates: number } {
    const updates = rows.filter(({ eventId }) => eventId !== undefined).length;
    return { updates, creates: rows.length - updates };
}

export function recordingProductDataRepository(
    inner: AMCProductDataRepository,
    recorder: ChangeRecorder,
    mode: RecordingMode
): AMCProductDataRepository {
    return {
        validate: inner.validate.bind(inner),
        checkTeiIdIntegrity: inner.checkTeiIdIntegrity.bind(inner),
        checkTeiIdIntegrityFromArrayBuffer: inner.checkTeiIdIntegrityFromArrayBuffer.bind(inner),
        getProductRegisterProgramMetadata: inner.getProductRegisterProgramMetadata.bind(inner),
        getProductRegisterAndRawProductConsumptionByProductIds:
            inner.getProductRegisterAndRawProductConsumptionByProductIds.bind(inner),
        getAllProductRegisterAndRawProductConsumptionByPeriod:
            inner.getAllProductRegisterAndRawProductConsumptionByPeriod.bind(inner),
        getTrackedEntityProductIdsByOUAndPeriod: inner.getTrackedEntityProductIdsByOUAndPeriod.bind(inner),

        importCalculations: params => {
            const { updates, creates } = splitByEventId(params.rawSubstanceConsumptionCalculatedData);
            recorder.productLevel.updates += updates;
            recorder.productLevel.creates += creates;

            return mode === "plan"
                ? Future.success(syntheticOkResponse({ created: creates, updated: updates, deleted: 0 }))
                : inner.importCalculations(params);
        },

        deleteRawSubstanceConsumptionCalculatedById: (ids, chunkSize) => {
            recorder.productLevel.deletes += ids.length;
            recorder.deletedEventIds.push(...ids);

            return mode === "plan"
                ? Future.success(syntheticOkResponse({ created: 0, updated: 0, deleted: ids.length }))
                : inner.deleteRawSubstanceConsumptionCalculatedById(ids, chunkSize);
        },
    };
}

export function recordingSubstanceDataRepository(
    inner: AMCSubstanceDataRepository,
    recorder: ChangeRecorder,
    mode: RecordingMode
): AMCSubstanceDataRepository {
    return {
        validate: inner.validate.bind(inner),
        getRawSubstanceConsumptionDataByEventsIds: inner.getRawSubstanceConsumptionDataByEventsIds.bind(inner),
        getAllRawSubstanceConsumptionDataByByPeriod: inner.getAllRawSubstanceConsumptionDataByByPeriod.bind(inner),
        getAllCalculatedSubstanceConsumptionDataByByPeriod:
            inner.getAllCalculatedSubstanceConsumptionDataByByPeriod.bind(inner),

        importCalculations: params => {
            const { updates, creates } = splitByEventId(params.calculatedConsumptionSubstanceLevelData);
            recorder.substanceLevel.updates += updates;
            recorder.substanceLevel.creates += creates;

            return mode === "plan"
                ? Future.success({
                      response: syntheticOkResponse({ created: creates, updated: updates, deleted: 0 }),
                      eventIdLineNoMap: [],
                  })
                : inner.importCalculations(params);
        },

        deleteCalculatedSubstanceConsumptionDataById: (ids, chunkSize) => {
            recorder.substanceLevel.deletes += ids.length;
            recorder.deletedEventIds.push(...ids);

            return mode === "plan"
                ? Future.success(syntheticOkResponse({ created: 0, updated: 0, deleted: ids.length }))
                : inner.deleteCalculatedSubstanceConsumptionDataById(ids, chunkSize);
        },
    };
}

export type FutureTrackerResponse = FutureData<TrackerPostResponse>;
