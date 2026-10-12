import { EventsRepository } from "../../repositories/EventsRepository";
import { ImportSummary, joinAllImportSummaries } from "../../entities/data-entry/ImportSummary";
import { Future, FutureData } from "../../entities/Future";
import { ExcelRepository } from "../../repositories/ExcelRepository";
import { GlassDocumentsRepository } from "../../repositories/GlassDocumentsRepository";
import { MetadataRepository } from "../../repositories/MetadataRepository";
import { InstanceRepository } from "../../repositories/InstanceRepository";
import { getStringFromFileBlob } from "./utils/fileToString";
import { GlassUploads } from "../../entities/GlassUploads";
import { GlassUploadsRepository } from "../../repositories/GlassUploadsRepository";
import { Id } from "../../entities/Ref";
import { TrackerRepository } from "../../repositories/TrackerRepository";
import { Maybe } from "../../../utils/ts-utils";
import consoleLogger from "../../../utils/consoleLogger";
import { deleteEvents, getDeleteImportSummary } from "./utils/deleteTrackerData";

// NOTICE: code adapted for node environment from ImportBLTemplateEventProgram.ts (only DELETE)
export class DeleteBLTemplateEventProgram {
    constructor(
        // Unused since the 1.6.45 faster event deletes (cleanup list)
        private excelRepository: ExcelRepository,
        // Unused since the 1.6.45 faster event deletes (cleanup list)
        private instanceRepository: InstanceRepository,
        private glassDocumentsRepository: GlassDocumentsRepository,
        // Unused since the 1.6.45 parallel deletes (cleanup list)
        private dhis2EventsDefaultRepository: EventsRepository,
        // Unused since the 1.6.45 parallel deletes (cleanup list)
        private metadataRepository: MetadataRepository,
        private glassUploadsRepository: GlassUploadsRepository,
        private trackerRepository: TrackerRepository
    ) {}

    public delete(params: {
        /** Unused since the 1.6.45 faster event deletes (cleanup list) */
        arrayBuffer: ArrayBuffer;
        programId: string;
        upload: GlassUploads;
        /** Unused since the 1.6.45 parallel deletes (cleanup list) */
        asyncDeleteChunkSize?: number;
        calculatedProgramId?: Id;
    }): FutureData<ImportSummary> {
        const { programId, upload, calculatedProgramId } = params;

        // The events to delete are the ids saved when the file was imported: the file itself is not read.
        return this.buildEventsPayload(upload, programId, calculatedProgramId).flatMap(
            ({ events, calculatedEvents }) => {
                consoleLogger.debug(
                    `Deleting ${events.length} events for upload ${upload.id}${
                        calculatedProgramId ? ` and ${calculatedEvents.length} calculated events` : ""
                    }.`
                );
                return this.deleteAllDataEvents(upload.id, events, programId).flatMap(importSummary => {
                    if (importSummary.status !== "SUCCESS") {
                        consoleLogger.error(`Some events for upload ${upload.id} could not be deleted.`);
                        return Future.success(importSummary);
                    }

                    consoleLogger.debug(`All events for upload ${upload.id} deleted successfully.`);
                    return this.deleteAllCalculatedEvents(upload.id, calculatedEvents, calculatedProgramId).map(
                        importSummaryCalculatedEvents =>
                            joinAllImportSummaries([importSummary, importSummaryCalculatedEvents])
                    );
                });
            }
        );
    }

    private deleteAllDataEvents(uploadId: Id, events: Id[], programId: Id): FutureData<ImportSummary> {
        if (!events.length) {
            const summary: ImportSummary = {
                status: "SUCCESS",
                importCount: {
                    ignored: 0,
                    imported: 0,
                    deleted: 0,
                    updated: 0,
                    total: 0,
                },
                nonBlockingErrors: [],
                blockingErrors: [],
            };
            return this.glassUploadsRepository.setEventListDataDeleted(uploadId).flatMap(() => {
                return Future.success(summary);
            });
        }

        return this.deleteAllEvents(events, programId).flatMap(importSummary => {
            if (importSummary.status === "SUCCESS") {
                consoleLogger.debug(`All events to DELETE for upload ${uploadId} processed successfully.`);
                return this.glassUploadsRepository.setEventListDataDeleted(uploadId).flatMap(() => {
                    return Future.success(importSummary);
                });
            } else {
                consoleLogger.error(`Some events for upload ${uploadId} could not be deleted.`);
                return Future.success(importSummary);
            }
        });
    }

    private deleteAllCalculatedEvents(
        uploadId: Id,
        calculatedEvents: Id[],
        calculatedProgramId: Maybe<Id>
    ): FutureData<ImportSummary> {
        if (!calculatedEvents.length || !calculatedProgramId) {
            const summary: ImportSummary = {
                status: "SUCCESS",
                importCount: {
                    ignored: 0,
                    imported: 0,
                    deleted: 0,
                    updated: 0,
                    total: 0,
                },
                nonBlockingErrors: [],
                blockingErrors: [],
            };
            return this.glassUploadsRepository.setCalculatedEventListDataDeleted(uploadId).flatMap(() => {
                return Future.success(summary);
            });
        }

        return this.deleteAllEvents(calculatedEvents, calculatedProgramId).flatMap(importSummary => {
            if (importSummary.status === "SUCCESS") {
                consoleLogger.debug(`All calculated events to DELETE for upload ${uploadId} processed successfully.`);
                return this.glassUploadsRepository.setCalculatedEventListDataDeleted(uploadId).flatMap(() => {
                    return Future.success(importSummary);
                });
            } else {
                consoleLogger.error(`Some calculated events for upload ${uploadId} could not be deleted.`);
                return Future.success(importSummary);
            }
        });
    }

    private deleteAllEvents(eventIds: Id[], programId: Id): FutureData<ImportSummary> {
        return deleteEvents(
            eventIds,
            ids => this.trackerRepository.getExistingEventsIdsByIds(ids, programId),
            this.trackerRepository
        ).map(getDeleteImportSummary);
    }

    private buildEventsPayload(
        upload: GlassUploads,
        programId: Id,
        calculatedProgramId?: Id
    ): FutureData<{
        events: Id[];
        calculatedEvents: Id[];
    }> {
        const { eventListFileId, eventListDataDeleted, calculatedEventListFileId, calculatedEventListDataDeleted } =
            upload;
        return Future.joinObj({
            events:
                eventListFileId && !eventListDataDeleted
                    ? this.getEventsFromListFileId(eventListFileId, programId)
                    : Future.success([]),
            calculatedEvents:
                calculatedEventListFileId && !calculatedEventListDataDeleted && calculatedProgramId
                    ? this.getEventsFromListFileId(calculatedEventListFileId, calculatedProgramId)
                    : Future.success([]),
        }).flatMap(({ events, calculatedEvents }) => {
            return Future.success({
                events: events,
                calculatedEvents: calculatedEvents,
            });
        });
    }

    private getEventsFromListFileId(listFileId: string, programId: Id): FutureData<Id[]> {
        return this.glassDocumentsRepository.download(listFileId).flatMap(eventListFileBlob => {
            return getStringFromFileBlob(eventListFileBlob).flatMap(_events => {
                const eventIdList: Id[] = JSON.parse(_events);
                return this.trackerRepository.getExistingEventsIdsByIds(eventIdList, programId);
            });
        });
    }
}
