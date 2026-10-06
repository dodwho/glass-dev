import { TrackerImportResult } from "../entities/data-entry/TrackerImportResult";
import { FutureData } from "../entities/Future";
import { ImportStrategy } from "../entities/data-entry/DataValuesSaveSummary";
import { Id } from "../entities/Ref";
import { TrackerPostRequest } from "../entities/TrackedEntityInstance";

export interface TrackerRepository {
    import(
        req: TrackerPostRequest,
        options: {
            action: ImportStrategy;
            async?: boolean;
            skipSideEffects?: boolean;
            /** Only for payloads whose objects all carry client-generated ids, so that a resend cannot duplicate. */
            retryTransientErrors?: boolean;
        }
    ): FutureData<TrackerImportResult>;
    getProgramMetadata(programID: string, programStageId: string): FutureData<any>;
    getExistingTrackedEntitiesIdsByIds(trackEntitiesIds: Id[], programId: Id): FutureData<Id[]>;
    getExistingTrackedEntities(
        trackedEntityIds: Id[],
        trackedEntityType: Id
    ): FutureData<{ trackedEntity: Id; orgUnit: Id }[]>;
    getExistingEventsIdsByIds(eventIds: Id[], programId: Id): FutureData<Id[]>;
}
