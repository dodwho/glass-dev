import { ImportSummary, joinAllImportSummaries } from "../../../entities/data-entry/ImportSummary";
import { Future, FutureData } from "../../../entities/Future";
import { TrackerRepository } from "../../../repositories/TrackerRepository";
import { GlassDocumentsRepository } from "../../../repositories/GlassDocumentsRepository";
import { MetadataRepository } from "../../../repositories/MetadataRepository";
import { AMCSubstanceDataRepository } from "../../../repositories/data-entry/AMCSubstanceDataRepository";
import { downloadIdsAndDeleteTrackedEntitiesUsingFileBlob } from "../utils/downloadIdsAndDeleteTrackedEntities";
import { deleteEvents, getDeleteImportSummary } from "../utils/deleteTrackerData";
import { getStringFromFileBlob } from "../utils/fileToString";
import { AMC_PRODUCT_REGISTER_PROGRAM_ID, AMR_GLASS_AMC_TET_PRODUCT_REGISTER } from "./ImportAMCProductLevelData";
import { GlassUploadsRepository } from "../../../repositories/GlassUploadsRepository";
import { GlassUploads } from "../../../entities/GlassUploads";
import { Id } from "../../../entities/Ref";
import { AMC_SUBSTANCE_CALCULATED_CONSUMPTION_PROGRAM_ID } from "./ImportAMCSubstanceLevelData";
import { Maybe } from "../../../../utils/ts-utils";
import { MODULE_NAMES } from "../../../entities/GlassModule";

// NOTICE: code adapted for node environment from ImportAMCProductLevelData.ts (only DELETE)
export class DeleteAMCProductLevelData {
    constructor(
        private options: {
            trackerRepository: TrackerRepository;
            glassDocumentsRepository: GlassDocumentsRepository;
            metadataRepository: MetadataRepository;
            amcSubstanceDataRepository: AMCSubstanceDataRepository; // Unused since the 1.6.45 parallel deletes (cleanup list)
            glassUploadsRepository: GlassUploadsRepository;
        }
    ) {}

    // The records to delete are the ids saved when the file was imported: the file itself is not read.
    public delete(
        upload: GlassUploads,
        asyncDeleteChunkSize: Maybe<number> // Unused since the 1.6.45 parallel deletes (cleanup list)
    ): FutureData<ImportSummary> {
        const { id: uploadId, calculatedEventListFileId, calculatedEventListDataDeleted } = upload;
        return downloadIdsAndDeleteTrackedEntitiesUsingFileBlob(
            upload,
            MODULE_NAMES.AMC,
            AMC_PRODUCT_REGISTER_PROGRAM_ID,
            "DELETE",
            AMR_GLASS_AMC_TET_PRODUCT_REGISTER,
            asyncDeleteChunkSize,
            {
                glassDocumentsRepository: this.options.glassDocumentsRepository,
                trackerRepository: this.options.trackerRepository,
                metadataRepository: this.options.metadataRepository,
                glassUploadsRepository: this.options.glassUploadsRepository,
            }
        ).flatMap(deleteProductSummary => {
            if (
                (deleteProductSummary.status === "SUCCESS" || deleteProductSummary.status === "WARNING") &&
                calculatedEventListFileId &&
                !calculatedEventListDataDeleted
            ) {
                return this.deleteCalculatedSubstanceConsumptionData(
                    uploadId,
                    deleteProductSummary,
                    calculatedEventListFileId
                );
            } else {
                return Future.success(deleteProductSummary);
            }
        });
    }

    private deleteCalculatedSubstanceConsumptionData(
        uploadId: Id,
        deleteProductSummary: ImportSummary,
        calculatedSubstanceConsumptionListFileId: string
    ): FutureData<ImportSummary> {
        const { trackerRepository, glassUploadsRepository } = this.options;
        const getExistingIds = (ids: Id[]) =>
            trackerRepository.getExistingEventsIdsByIds(ids, AMC_SUBSTANCE_CALCULATED_CONSUMPTION_PROGRAM_ID);

        return this.options.glassDocumentsRepository
            .download(calculatedSubstanceConsumptionListFileId)
            .flatMap(eventListFileBlob => getStringFromFileBlob(eventListFileBlob))
            .flatMap(_events => getExistingIds(JSON.parse(_events)))
            .flatMap(existingEventsIds => {
                if (!existingEventsIds.length) {
                    return glassUploadsRepository
                        .setCalculatedEventListDataDeleted(uploadId)
                        .map(() => deleteProductSummary);
                }

                return deleteEvents(existingEventsIds, getExistingIds, trackerRepository).flatMap(result => {
                    const deleteCalculatedSummary = getDeleteImportSummary(result);
                    const mergedSummary = joinAllImportSummaries([deleteProductSummary, deleteCalculatedSummary]);

                    return deleteCalculatedSummary.status === "SUCCESS"
                        ? glassUploadsRepository.setCalculatedEventListDataDeleted(uploadId).map(() => mergedSummary)
                        : Future.success(mergedSummary);
                });
            });
    }
}
