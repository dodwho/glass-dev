import _ from "lodash";

import { ImportSummary, joinAllImportSummaries } from "../../../entities/data-entry/ImportSummary";
import { Future, FutureData } from "../../../entities/Future";
import { ExcelRepository } from "../../../repositories/ExcelRepository";
import * as templates from "../../../entities/data-entry/program-templates";
import { TrackerRepository } from "../../../repositories/TrackerRepository";
import { GlassDocumentsRepository } from "../../../repositories/GlassDocumentsRepository";
import { readTemplate } from "../ImportBLTemplateEventProgram";
import { MetadataRepository } from "../../../repositories/MetadataRepository";
import { AMCSubstanceDataRepository } from "../../../repositories/data-entry/AMCSubstanceDataRepository";
import { downloadIdsAndDeleteTrackedEntitiesUsingFileBlob } from "../utils/downloadIdsAndDeleteTrackedEntities";
import { deleteEvents, getDeleteImportSummary } from "../utils/deleteTrackerData";
import { getStringFromFileBlob } from "../utils/fileToString";
import { InstanceRepository } from "../../../repositories/InstanceRepository";
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
            excelRepository: ExcelRepository;
            instanceRepository: InstanceRepository;
            trackerRepository: TrackerRepository;
            glassDocumentsRepository: GlassDocumentsRepository;
            metadataRepository: MetadataRepository;
            amcSubstanceDataRepository: AMCSubstanceDataRepository; // Unused since the 1.6.45 parallel deletes (cleanup list)
            glassUploadsRepository: GlassUploadsRepository;
        }
    ) {}

    public delete(
        arrayBuffer: ArrayBuffer,
        upload: GlassUploads,
        asyncDeleteChunkSize: Maybe<number> // Unused since the 1.6.45 parallel deletes (cleanup list)
    ): FutureData<ImportSummary> {
        const { id: uploadId, calculatedEventListFileId, calculatedEventListDataDeleted } = upload;
        return this.options.excelRepository
            .loadTemplateFromArrayBuffer(arrayBuffer, AMC_PRODUCT_REGISTER_PROGRAM_ID)
            .flatMap(_templateId => {
                const amcTemplate = _.values(templates)
                    .map(TemplateClass => new TemplateClass())
                    .filter(t => t.id === "TRACKER_PROGRAM_GENERATED_v3")[0];

                return this.options.instanceRepository
                    .getProgram(AMC_PRODUCT_REGISTER_PROGRAM_ID)
                    .flatMap(amcProgram => {
                        if (!amcTemplate) return Future.error("Cannot find template");

                        return readTemplate(
                            amcTemplate,
                            amcProgram,
                            this.options.excelRepository,
                            this.options.instanceRepository,
                            AMC_PRODUCT_REGISTER_PROGRAM_ID
                        ).flatMap(dataPackage => {
                            if (!dataPackage) return Future.error("Cannot find data package");

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
                                    (deleteProductSummary.status === "SUCCESS" ||
                                        deleteProductSummary.status === "WARNING") &&
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
                        });
                    });
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
