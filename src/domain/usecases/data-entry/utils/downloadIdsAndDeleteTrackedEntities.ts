import { Future, FutureData } from "../../../entities/Future";
import { ImportStrategy } from "../../../entities/data-entry/DataValuesSaveSummary";
import { ImportSummary } from "../../../entities/data-entry/ImportSummary";
import { GlassDocumentsRepository } from "../../../repositories/GlassDocumentsRepository";
import { MetadataRepository } from "../../../repositories/MetadataRepository";
import { TrackerRepository } from "../../../repositories/TrackerRepository";
import { getStringFromFile, getStringFromFileBlob } from "./fileToString";
import { mapToImportSummary } from "../ImportBLTemplateEventProgram";
import { Id } from "../../../entities/Ref";
import { GlassUploadsRepository } from "../../../repositories/GlassUploadsRepository";
import { GlassUploads } from "../../../entities/GlassUploads";
import { TrackerTrackedEntity } from "../../../entities/TrackedEntityInstance";
import { Maybe } from "../../../../utils/ts-utils";
import { deleteTrackedEntities, getDeleteImportSummary } from "./deleteTrackerData";
import consoleLogger from "../../../../utils/consoleLogger";

export const downloadIdsAndDeleteTrackedEntities = (
    eventListId: string | undefined,
    orgUnitId: string,
    action: ImportStrategy,
    trackedEntityType: string,
    glassDocumentsRepository: GlassDocumentsRepository,
    trackerRepository: TrackerRepository,
    metadataRepository: MetadataRepository
): FutureData<ImportSummary> => {
    if (eventListId) {
        return glassDocumentsRepository.download(eventListId).flatMap(file => {
            return Future.fromPromise(getStringFromFile(file)).flatMap(_enrollments => {
                const enrollmemtIdList: [] = JSON.parse(_enrollments);
                const trackedEntities = enrollmemtIdList.map(id => {
                    const trackedEntity: TrackerTrackedEntity = {
                        orgUnit: orgUnitId,
                        trackedEntity: id,
                        trackedEntityType: trackedEntityType,
                        attributes: [],
                        enrollments: [],
                    };
                    return trackedEntity;
                });
                return trackerRepository
                    .import({ trackedEntities: trackedEntities }, { action: action, async: true })
                    .flatMap(response => {
                        return mapToImportSummary(response, "trackedEntity", metadataRepository).flatMap(
                            ({ importSummary }) => {
                                return Future.success(importSummary);
                            }
                        );
                    });
            });
        });
    } else {
        //No enrollments were created during import, so no events to delete.
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
        return Future.success(summary);
    }
};

export const downloadIdsAndDeleteTrackedEntitiesUsingFileBlob = (
    upload: GlassUploads,
    _glassModuleName: string, // Unused since the 1.6.45 parallel deletes (cleanup list)
    programId: Id,
    _action: ImportStrategy, // Unused since the 1.6.45 parallel deletes (cleanup list)
    trackedEntityType: string,
    _asyncDeleteChunkSize: Maybe<number>, // Unused since the 1.6.45 parallel deletes (cleanup list)
    repositories: {
        glassDocumentsRepository: GlassDocumentsRepository;
        trackerRepository: TrackerRepository;
        metadataRepository: MetadataRepository; // Unused since the 1.6.45 parallel deletes (cleanup list)
        glassUploadsRepository: GlassUploadsRepository;
    }
): FutureData<ImportSummary> => {
    const { id: uploadId, orgUnit: orgUnitId, eventListFileId } = upload;
    if (eventListFileId && !upload.eventListDataDeleted) {
        consoleLogger.debug(`Download document with id ${eventListFileId} to delete tracked entities`);
        return repositories.glassDocumentsRepository.download(eventListFileId).flatMap(fileBlob => {
            return getStringFromFileBlob(fileBlob).flatMap(_trackedEntities => {
                const trackedEntitiesIdList: Id[] = JSON.parse(_trackedEntities);
                consoleLogger.debug(
                    `Retrieved ${trackedEntitiesIdList.length} tracked entities to delete for upload ${uploadId}`
                );
                return repositories.trackerRepository
                    .getExistingTrackedEntitiesIdsByIds(trackedEntitiesIdList, programId)
                    .flatMap(existingTrackedEntitiesIds => {
                        consoleLogger.debug(
                            `Found existing tracked entities: ${existingTrackedEntitiesIds.length} to delete for upload ${uploadId}`
                        );
                        if (existingTrackedEntitiesIds.length === 0) {
                            consoleLogger.debug(`No existing tracked entities found to delete for upload ${uploadId}`);
                            return repositories.glassUploadsRepository.setEventListDataDeleted(uploadId).flatMap(() => {
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
                                return Future.success(summary);
                            });
                        }

                        return deleteTrackedEntities(
                            existingTrackedEntitiesIds,
                            { orgUnit: orgUnitId, trackedEntityType },
                            ids => repositories.trackerRepository.getExistingTrackedEntitiesIdsByIds(ids, programId),
                            repositories.trackerRepository
                        ).flatMap(result => {
                            const importSummary = getDeleteImportSummary(result);
                            if (importSummary.status !== "SUCCESS") {
                                consoleLogger.error(
                                    `Errors occurred while deleting tracked entities for upload ${uploadId}`
                                );
                                return Future.success(importSummary);
                            }

                            consoleLogger.debug(`Successfully deleted all tracked entities for upload ${uploadId}`);
                            return repositories.glassUploadsRepository
                                .setEventListDataDeleted(uploadId)
                                .map(() => importSummary);
                        });
                    });
            });
        });
    } else {
        consoleLogger.debug(`No enrollments were created during import, so no events to delete.`);

        return repositories.glassUploadsRepository.setEventListDataDeleted(uploadId).flatMap(() => {
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
            return Future.success(summary);
        });
    }
};
