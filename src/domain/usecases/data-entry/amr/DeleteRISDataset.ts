import { Future, FutureData } from "../../../entities/Future";
import { ImportSummary } from "../../../entities/data-entry/ImportSummary";
import { MetadataRepository } from "../../../repositories/MetadataRepository";
import { DataValuesRepository } from "../../../repositories/data-entry/DataValuesRepository";
import { RISDataRepository } from "../../../repositories/data-entry/RISDataRepository";
import { AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID } from "../utils/getCategoryOptionCombo";
import { mapDataValuesToImportSummary } from "../utils/mapDhis2Summary";
import { AMR_AMR_DS_INPUT_FILES_RIS_DS_ID, AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID } from "./amrAggMetadataIds";
import { Maybe } from "../../../../utils/ts-utils";
import { deleteDataValues } from "../utils/deleteDataValues";
import { mapRISDataToDataValues } from "./mapAMRAggFileToDataValues";

// Node counterpart of ImportRISFile for DELETE: removes the values the file maps to (mapRISDataToDataValues)
export class DeleteRISDataset {
    constructor(
        private options: {
            risDataRepository: RISDataRepository;
            metadataRepository: MetadataRepository;
            dataValuesRepository: DataValuesRepository;
        }
    ) {}

    public delete(arrayBuffer: ArrayBuffer, asyncDeleteChunkSize: Maybe<number>): FutureData<ImportSummary> {
        return this.options.risDataRepository
            .getFromArrayBuffer(arrayBuffer)
            .flatMap(risDataItems => {
                return Future.joinObj({
                    risDataItems: Future.success(risDataItems),
                    dataSet: this.options.metadataRepository.getDataSet(AMR_AMR_DS_INPUT_FILES_RIS_DS_ID),
                    dataSet_CC: this.options.metadataRepository.getCategoryCombination(
                        AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID
                    ),
                    dataElement_CC: this.options.metadataRepository.getCategoryCombination(
                        AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID
                    ),
                    orgUnits: this.options.metadataRepository.getOrgUnitsByCode([
                        ...new Set(risDataItems.map(item => item.COUNTRY)),
                    ]),
                });
            })
            .flatMap(({ risDataItems, dataSet, dataSet_CC, dataElement_CC, orgUnits }) => {
                const { dataValues } = mapRISDataToDataValues(risDataItems, {
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
