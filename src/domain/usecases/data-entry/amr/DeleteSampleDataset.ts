import { Future, FutureData } from "../../../entities/Future";
import { DataValue } from "../../../entities/data-entry/DataValue";
import { ImportSummary } from "../../../entities/data-entry/ImportSummary";
import { GlassUploads } from "../../../entities/GlassUploads";
import { MetadataRepository } from "../../../repositories/MetadataRepository";
import { GlassDocumentsRepository } from "../../../repositories/GlassDocumentsRepository";
import { GlassUploadsRepository } from "../../../repositories/GlassUploadsRepository";
import { GlassModuleRepository } from "../../../repositories/GlassModuleRepository";
import { DataValuesRepository } from "../../../repositories/data-entry/DataValuesRepository";
import { AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID } from "../utils/getCategoryOptionCombo";
import { mapDataValuesToImportSummary } from "../utils/mapDhis2Summary";
import { SampleDataRepository } from "../../../repositories/data-entry/SampleDataRepository";
import { AMR_AMR_DS_Input_files_Sample_DS_ID, AMR_BATCHID_CC_ID } from "./amrAggMetadataIds";
import { Maybe } from "../../../../utils/ts-utils";
import { deleteDataValues } from "../utils/deleteDataValues";
import { mapSampleDataToDataValues } from "./mapAMRAggFileToDataValues";
import { excludeValuesOfOtherUploads } from "./excludeValuesOfOtherUploads";

// Removes the values the upload's file maps to (mapSampleDataToDataValues), except those another live upload holds
export class DeleteSampleDataset {
    constructor(
        private options: {
            sampleDataRepository: SampleDataRepository;
            metadataRepository: MetadataRepository;
            dataValuesRepository: DataValuesRepository;
            glassUploadsRepository: GlassUploadsRepository;
            glassDocumentsRepository: GlassDocumentsRepository;
            glassModuleRepository: GlassModuleRepository;
        }
    ) {}

    public delete(
        upload: GlassUploads,
        arrayBuffer: ArrayBuffer,
        asyncDeleteChunkSize: Maybe<number>
    ): FutureData<ImportSummary> {
        const mapFile = (file: ArrayBuffer) => this.mapFileToDataValues(file);

        return mapFile(arrayBuffer)
            .flatMap(dataValues => excludeValuesOfOtherUploads(upload, dataValues, mapFile, this.options))
            .flatMap(dataValues =>
                deleteDataValues(dataValues, asyncDeleteChunkSize, this.options.dataValuesRepository).map(
                    saveSummary => {
                        const importSummary = mapDataValuesToImportSummary(saveSummary, "DELETE");

                        return {
                            ...importSummary,
                            importTime: saveSummary.importTime,
                        };
                    }
                )
            );
    }

    private mapFileToDataValues(arrayBuffer: ArrayBuffer): FutureData<DataValue[]> {
        return this.options.sampleDataRepository
            .getFromArrayBuffer(arrayBuffer)
            .flatMap(sampleDataItems => {
                return Future.joinObj({
                    sampleDataItems: Future.success(sampleDataItems),
                    dataSet: this.options.metadataRepository.getDataSet(AMR_AMR_DS_Input_files_Sample_DS_ID),
                    dataSet_CC: this.options.metadataRepository.getCategoryCombination(AMR_BATCHID_CC_ID),
                    dataElement_CC: this.options.metadataRepository.getCategoryCombination(
                        AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID
                    ),
                    orgUnits: this.options.metadataRepository.getOrgUnitsByCode([
                        ...new Set(sampleDataItems.map(item => item.COUNTRY)),
                    ]),
                });
            })
            .map(
                ({ sampleDataItems, dataSet, dataSet_CC, dataElement_CC, orgUnits }) =>
                    mapSampleDataToDataValues(sampleDataItems, { dataSet, dataSet_CC, dataElement_CC, orgUnits })
                        .dataValues
            );
    }
}
