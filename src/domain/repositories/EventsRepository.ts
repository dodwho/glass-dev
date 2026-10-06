import { FutureData } from "../entities/Future";
import { ImportStrategy } from "../entities/data-entry/ImportSummary";
import { TrackerImportResult } from "../entities/data-entry/TrackerImportResult";
import { Id } from "../entities/Ref";
import { TrackerEvent, TrackerEventDataValue, TrackerEventsPostRequest } from "../entities/TrackedEntityInstance";

export interface EventsRepository {
    getEGASPEventsByOrgUnit(orgUnit: string): FutureData<TrackerEvent[]>;
    import(events: TrackerEventsPostRequest, action: ImportStrategy): FutureData<TrackerImportResult>;
    getEventById(id: Id): FutureData<TrackerEvent>;
    getAMCDataQuestionnaireEvtsByOUAndPeriod(
        orgUnitId: Id,
        year: string
    ): FutureData<{ event: Id; dataValues: TrackerEventDataValue[] }[]>;
}
