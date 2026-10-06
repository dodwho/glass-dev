import { UseCase } from "../../UseCase";
import { Future, FutureData } from "../../entities/Future";
import { MetadataRepository } from "../../repositories/MetadataRepository";
import { DataValuesRepository } from "../../repositories/data-entry/DataValuesRepository";
import { SampleDataRepository } from "../../repositories/data-entry/SampleDataRepository";
import { ImportSummary } from "../../entities/data-entry/ImportSummary";
import { ExcelRepository } from "../../repositories/ExcelRepository";
import { GlassUploadsRepository } from "../../repositories/GlassUploadsRepository";
import { EventsRepository } from "../../repositories/EventsRepository";
import { GlassDocumentsRepository } from "../../repositories/GlassDocumentsRepository";
import { InstanceRepository } from "../../repositories/InstanceRepository";
import { GlassModule } from "../../entities/GlassModule";
import { GlassUploads } from "../../entities/GlassUploads";
import { DeleteAMCSubstanceLevelData } from "./amc/DeleteAMCSubstanceLevelData";
import { DeleteSampleDataset } from "./amr/DeleteSampleDataset";
import { TrackerRepository } from "../../repositories/TrackerRepository";

export class DeleteSecondaryFileDataUseCase implements UseCase {
    constructor(
        private options: {
            sampleDataRepository: SampleDataRepository;
            dataValuesRepository: DataValuesRepository;
            dhis2EventsDefaultRepository: EventsRepository;
            excelRepository: ExcelRepository;
            glassDocumentsRepository: GlassDocumentsRepository;
            metadataRepository: MetadataRepository;
            instanceRepository: InstanceRepository;
            glassUploadsRepository: GlassUploadsRepository;
            trackerRepository: TrackerRepository;
        }
    ) {}

    public execute(
        currentModule: GlassModule,
        upload: GlassUploads,
        arrayBuffer: ArrayBuffer,
        isAsyncDeletion: boolean
    ): FutureData<ImportSummary> {
        const asyncDeleteChunkSize = isAsyncDeletion ? currentModule.asyncDeleteChunkSizes?.primaryUpload : undefined;

        const { name: currentModuleName } = currentModule;
        switch (currentModuleName) {
            case "AMR":
            case "AMR - Individual": {
                return new DeleteSampleDataset(this.options).delete(arrayBuffer, asyncDeleteChunkSize);
            }

            case "AMC": {
                return new DeleteAMCSubstanceLevelData(this.options).delete(arrayBuffer, upload, asyncDeleteChunkSize);
            }
            default: {
                return Future.error(`Secondary upload async deletion for module ${currentModuleName} not found`);
            }
        }
    }
}
