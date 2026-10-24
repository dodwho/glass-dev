import { Future, FutureData } from "../../../entities/Future";
import { ImportSummary } from "../../../entities/data-entry/ImportSummary";
import { MetadataRepository } from "../../../repositories/MetadataRepository";
import { DataValuesRepository } from "../../../repositories/data-entry/DataValuesRepository";
import { AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID } from "../utils/getCategoryOptionCombo";
import { mapDataValuesToImportSummary } from "../utils/mapDhis2Summary";
import { SampleDataRepository } from "../../../repositories/data-entry/SampleDataRepository";
import { AMR_AMR_DS_Input_files_Sample_DS_ID, AMR_BATCHID_CC_ID } from "./amrAggMetadataIds";
import { Maybe } from "../../../../utils/ts-utils";
import { deleteDataValues } from "../utils/deleteDataValues";
import { mapSampleDataToDataValues } from "./mapAMRAggFileToDataValues";

// Node counterpart of ImportSampleFile for DELETE: removes the values the file maps to (mapSampleDataToDataValues)
export class DeleteSampleDataset {
    constructor(
        private options: {
            sampleDataRepository: SampleDataRepository;
            metadataRepository: MetadataRepository;
            dataValuesRepository: DataValuesRepository;
        }
    ) {}

    public delete(arrayBuffer: ArrayBuffer, asyncDeleteChunkSize: Maybe<number>): FutureData<ImportSummary> {
        return this.options.sampleDataRepository
            .getFromArrayBuffer(arrayBuffer)
            .flatMap(risDataItems => {
                return Future.joinObj({
                    risDataItems: Future.success(risDataItems),
                    dataSet: this.options.metadataRepository.getDataSet(AMR_AMR_DS_Input_files_Sample_DS_ID),
                    dataSet_CC: this.options.metadataRepository.getCategoryCombination(AMR_BATCHID_CC_ID),
                    dataElement_CC: this.options.metadataRepository.getCategoryCombination(
                        AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID
                    ),
                    orgUnits: this.options.metadataRepository.getOrgUnitsByCode([
                        ...new Set(risDataItems.map(item => item.COUNTRY)),
                    ]),
                });
            })
            .flatMap(({ risDataItems, dataSet, dataSet_CC, dataElement_CC, orgUnits }) => {
                const { dataValues } = mapSampleDataToDataValues(risDataItems, {
                    dataSet,
                    dataSet_CC,
                    dataElement_CC,
                    orgUnits,
                });

                return deleteDataValues(dataValues, asyncDeleteChunkSize, this.options.dataValuesRepository).map(
                    saveSummary => {
                        const importSummary = mapDataValuesToImportSummary(saveSummary, "DELETE");

                        return {
                            ...importSummary,
                            importTime: saveSummary.importTime,
                        };
                    }
                );
            });
    }
}
