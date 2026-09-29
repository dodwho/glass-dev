import { TrackerPostResponse } from "@eyeseetea/d2-api/api/tracker";
import { FutureData } from "../entities/Future";
import { ImportStrategy } from "../entities/data-entry/DataValuesSaveSummary";
import { Id } from "../entities/Ref";
import { TrackerPostRequest } from "../entities/TrackedEntityInstance";

// TODO: fix coupling with data layer because of TrackerPostResponse
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
    ): FutureData<TrackerPostResponse>;
    getProgramMetadata(programID: string, programStageId: string): FutureData<any>;
    getExistingTrackedEntitiesIdsByIds(trackEntitiesIds: Id[], programId: Id): FutureData<Id[]>;
    getExistingTrackedEntities(
        trackedEntityIds: Id[],
        trackedEntityType: Id
    ): FutureData<{ trackedEntity: Id; orgUnit: Id }[]>;
    getExistingEventsIdsByIds(eventIds: Id[], programId: Id): FutureData<Id[]>;
}
