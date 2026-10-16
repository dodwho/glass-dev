import { ImportStrategy } from "../../../entities/data-entry/DataValuesSaveSummary";
import { ConsistencyError, ImportSummary } from "../../../entities/data-entry/ImportSummary";
import { MetadataRepository } from "../../../repositories/MetadataRepository";
import { DataValuesRepository } from "../../../repositories/data-entry/DataValuesRepository";
import { SampleDataRepository } from "../../../repositories/data-entry/SampleDataRepository";
import { SampleData } from "../../../entities/data-entry/amr-external/SampleData";
import { CategoryCombo } from "../../../entities/metadata/CategoryCombo";
import { GlassModuleRepository } from "../../../repositories/GlassModuleRepository";
import _ from "lodash";
import { AMRAggDataValuesImportHelper } from "./AMRAggDataValuesImportHelper";
import { DataSet } from "../../../entities/metadata/DataSet";
import { DataValuesImportRepository } from "../../../repositories/data-entry/DataValuesImportRepository";
import { AMR_AMR_DS_Input_files_Sample_DS_ID, AMR_BATCHID_CC_ID } from "./amrAggMetadataIds";
import { checkCountry } from "../utils/checkCountry";
import { checkDuplicateRowsSAMPLE } from "../utils/checkDuplicateRows";
import { checkYear } from "../utils/checkYear";

export class SampleDatasetImportHelper extends AMRAggDataValuesImportHelper {
    private static sampleMetadataCache: {
        dataSet: DataSet;
        dataSet_attr_combo: CategoryCombo;
    } = {
        ...AMRAggDataValuesImportHelper.metadataCache,
        dataSet: {} as DataSet,
        dataSet_attr_combo: {} as CategoryCombo,
    };

    constructor(
        private sampleDataRepository: SampleDataRepository,
        metadataRepository: MetadataRepository,
        dataValuesRepository: DataValuesImportRepository,
        moduleRepository: GlassModuleRepository
    ) {
        super(metadataRepository, dataValuesRepository, moduleRepository);
        this.sampleDataRepository = sampleDataRepository;
    }

    static async initialize(
        sampleDataRepository: SampleDataRepository,
        metadataRepository: MetadataRepository,
        dataValuesRepository: DataValuesImportRepository,
        moduleRepository: GlassModuleRepository
    ): Promise<SampleDatasetImportHelper> {
        const instance = new SampleDatasetImportHelper(
            sampleDataRepository,
            metadataRepository,
            dataValuesRepository,
            moduleRepository
        );
        await instance.initializeCache();
        return instance;
    }

    protected async initializeCache(): Promise<void> {
        await super.initializeCache();
        try {
            const [dataSet, dataSet_attr_combo] = await Promise.all([
                this.metadataRepository.getDataSet(AMR_AMR_DS_Input_files_Sample_DS_ID).toPromise(),
                this.metadataRepository.getCategoryCombination(AMR_BATCHID_CC_ID).toPromise(),
            ]);

            SampleDatasetImportHelper.sampleMetadataCache = {
                dataSet,
                dataSet_attr_combo,
            };
        } catch (error) {
            console.error("Error loading sample metadata:", error);
            throw error;
        }
    }

    public async importSampleDataValues(
        inputFile: File,
        year: string,
        action: ImportStrategy,
        orgUnitId: string,
        dryRun: boolean,
        countryCode: string
    ): Promise<ImportSummary> {
        try {
            const sampleDataItems = await this.sampleDataRepository.get(inputFile).toPromise();
            //console.log("sampleDataItems: ", sampleDataItems);
            //console.log("SampleDatasetImportHelper.metadataCache.dataSet: ", SampleDatasetImportHelper.metadataCache.dataSet);
            //console.log("SampleDatasetImportHelper.metadataCache.dataSet_attr_combo: ", SampleDatasetImportHelper.metadataCache.dataSet_attr_combo);
            //console.log("SampleDatasetImportHelper.metadataCache.dataElement_CC: ", SampleDatasetImportHelper.metadataCache.dataElement_CC);
            // Run data value generation and consistency checks in parallel
            const [dataValuesResult, consistencyErrors] = await Promise.all([
                this.generateDataValues(
                    sampleDataItems,
                    SampleDatasetImportHelper.sampleMetadataCache.dataSet,
                    SampleDatasetImportHelper.sampleMetadataCache.dataSet_attr_combo,
                    orgUnitId,
                    10
                ),
                this.runPreImportConsistencyChecks(sampleDataItems, year, countryCode),
            ]);

            const { values, blockingErrors } = dataValuesResult;
            const allBlockingErrors = [...consistencyErrors, ...blockingErrors];

            if (allBlockingErrors.length > 0) {
                console.error("Pre upload Consistency check error for data values for sample file: ", inputFile.name);
                return this.createErrorImportSummary(allBlockingErrors);
            }
            // Save data values in DHIS2
            const saveSummary = await this.dataValuesRepository.save(values, action, dryRun);
            // Run post-save validations
            const finalSummary = await this.runPostSaveValidations(
                saveSummary,
                year,
                orgUnitId,
                allBlockingErrors,
                values,
                action,
                AMR_AMR_DS_Input_files_Sample_DS_ID
            );
            return finalSummary;
        } catch (error) {
            const errorMessage = `Error during SAMPLE data values import for file ${inputFile.name} : ${error}`;
            console.error(errorMessage);
            throw new Error(errorMessage);
        }
    }

    // The batch check of ImportSampleFile is not run for historical loads.
    private async runPreImportConsistencyChecks(
        sampleDataItems: SampleData[],
        year: string,
        countryCode: string
    ): Promise<ConsistencyError[]> {
        return [
            ...checkYear(sampleDataItems, year),
            ...checkCountry(sampleDataItems, countryCode),
            ...checkDuplicateRowsSAMPLE(sampleDataItems),
        ];
    }
}
