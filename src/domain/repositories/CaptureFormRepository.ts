import { FutureData } from "../entities/Future";
import { Questionnaire } from "../entities/Questionnaire";
import { Id } from "../entities/Ref";
import { TrackerEventDataValue } from "../entities/TrackedEntityInstance";

/** The part of a stored event that is needed to populate a form. */
export interface CaptureFormEvent {
    dataValues: TrackerEventDataValue[];
}

export interface CaptureFormRepository {
    getForm(programId: Id): FutureData<Questionnaire>;
    getPopulatedForm(event: CaptureFormEvent, programId: string): FutureData<Questionnaire>;
    getSignalEvent(eventId: string): FutureData<CaptureFormEvent>;
}
