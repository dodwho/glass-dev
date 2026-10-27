import _ from "lodash";
import { Future, FutureData } from "../../../entities/Future";
import { ImportStrategy } from "../../../entities/data-entry/DataValuesSaveSummary";
import { ConsistencyError, ImportSummary } from "../../../entities/data-entry/ImportSummary";
import { GlassModuleRepository } from "../../../repositories/GlassModuleRepository";
import { MetadataRepository } from "../../../repositories/MetadataRepository";
import { DataValuesRepository } from "../../../repositories/data-entry/DataValuesRepository";
import { RISDataRepository } from "../../../repositories/data-entry/RISDataRepository";
import { checkASTResults } from "../utils/checkASTResults";
import { checkBatchId } from "../utils/checkBatchId";
import { checkCopiedBatch } from "../utils/checkCopiedBatch";
import { checkCountry } from "../utils/checkCountry";
import { checkDhis2Validations } from "../utils/checkDhis2Validations";
import { checkSpecimenPathogen } from "../utils/checkSpecimenPathogen";
import { checkYear } from "../utils/checkYear";
import { AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID } from "../utils/getCategoryOptionCombo";
import { includeBlockingErrors } from "../utils/includeBlockingErrors";
import { groupLineErrors } from "../utils/groupLineErrors";
import { mapDataValuesToImportSummary } from "../utils/mapDhis2Summary";
import { RIS_RESULT_COLUMNS } from "../../../entities/data-entry/amr-external/RISData";
import { checkDuplicateRowsRIS } from "../utils/checkDuplicateRows";
import { checkWholeNumbers } from "../utils/checkWholeNumbers";

import { AMR_AMR_DS_INPUT_FILES_RIS_DS_ID, AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID } from "./amrAggMetadataIds";
import { mapRISDataToDataValues } from "./mapAMRAggFileToDataValues";

export class ImportRISFile {
    constructor(
        private risDataRepository: RISDataRepository,
        private metadataRepository: MetadataRepository,
        private dataValuesRepository: DataValuesRepository,
        private moduleRepository: GlassModuleRepository
    ) {}

    public importRISFile(
        inputFile: File,
        batchId: string,
        year: string,
        action: ImportStrategy,
        orgUnit: string,
        countryCode: string,
        dryRun: boolean
    ): FutureData<ImportSummary> {
        return this.risDataRepository
            .get(inputFile)
            .flatMap(risDataItems => {
                return Future.joinObj({
                    risDataItems: Future.success(risDataItems),
                    dataSet: this.metadataRepository.getDataSet(AMR_AMR_DS_INPUT_FILES_RIS_DS_ID),
                    dataSet_CC: this.metadataRepository.getCategoryCombination(
                        AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID
                    ),
                    dataElement_CC: this.metadataRepository.getCategoryCombination(
                        AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID
                    ),
                    orgUnits: this.metadataRepository.getOrgUnitsByCode([
                        ...new Set(risDataItems.map(item => item.COUNTRY)),
                    ]),
                    module: this.moduleRepository.getByName("AMR"),
                    storedValues:
                        action === "DELETE"
                            ? Future.success([])
                            : this.dataValuesRepository.getStored(AMR_AMR_DS_INPUT_FILES_RIS_DS_ID, orgUnit, year),
                });
            })
            .flatMap(({ risDataItems, dataSet, dataSet_CC, dataElement_CC, orgUnits, module, storedValues }) => {
                const specimenPathogenAntibioticErrors = module.consistencyChecks
                    ? checkSpecimenPathogen(risDataItems, module.consistencyChecks.specimenPathogen)
                    : [];
                const astResultsErrors = checkASTResults(risDataItems);
                const batchIdErrors = checkBatchId(risDataItems, batchId);
                const yearErrors = checkYear(risDataItems, year);
                const countryErrors = checkCountry(risDataItems, countryCode);
                const duplicateRowErrors = checkDuplicateRowsRIS(risDataItems);
                const wholeNumberErrors = checkWholeNumbers(risDataItems, [...RIS_RESULT_COLUMNS]);

                const { dataValues, categoryOptionErrors: blockingCategoryOptionErrors } = mapRISDataToDataValues(
                    risDataItems,
                    { dataSet, dataSet_CC, dataElement_CC, orgUnits }
                );
                // The shared mapping gives one value per data set data element for each row, in row order.
                const rowValues = _.chunk(dataValues, dataSet.dataElements.length);

                const blockingCategoryOptionConsistencyErrors: ConsistencyError[] =
                    groupLineErrors(blockingCategoryOptionErrors);
                const copyCheck = checkCopiedBatch(rowValues, storedValues, dataSet_CC, batchId);
                const withCopyWarnings = (summary: ImportSummary): ImportSummary => ({
                    ...summary,
                    nonBlockingErrors: [...summary.nonBlockingErrors, ...copyCheck.warnings],
                });

                const allBlockingErrors =
                    action === "DELETE" //If delete, ignore consistency checks
                        ? []
                        : [
                              ...blockingCategoryOptionConsistencyErrors,
                              ...specimenPathogenAntibioticErrors,
                              ...astResultsErrors,
                              ...batchIdErrors,
                              ...yearErrors,
                              ...countryErrors,
                              ...duplicateRowErrors,
                              ...wholeNumberErrors,
                              ...copyCheck.blockingErrors,
                          ];

                if (allBlockingErrors.length > 0) {
                    const errorImportSummary: ImportSummary = {
                        status: "ERROR",
                        importCount: {
                            imported: 0,
                            updated: 0,
                            ignored: 0,
                            deleted: 0,
                            total: 0,
                        },
                        nonBlockingErrors: [],
                        blockingErrors: allBlockingErrors,
                    };

                    return Future.success(errorImportSummary);
                }

                const uniqueAOCs = _.uniq(dataValues.map(el => el.attributeOptionCombo || ""));

                return this.dataValuesRepository.save(dataValues, action, dryRun).flatMap(saveSummary => {
                    //Run validations only on actual import
                    if (!dryRun) {
                        return this.metadataRepository
                            .getValidationsDataSet(
                                AMR_AMR_DS_INPUT_FILES_RIS_DS_ID,
                                year.toString(),
                                orgUnit,
                                uniqueAOCs
                            )
                            .flatMap(validationResponse => {
                                const validations = validationResponse;

                                const validationRulesIds: string[] = validations.flatMap(
                                    ({ validationRuleViolations }) =>
                                        validationRuleViolations.map(ruleViolation => ruleViolation?.validationRule?.id)
                                );

                                return this.metadataRepository
                                    .getValidationRuleInstructions(validationRulesIds)
                                    .map(rulesInstructions => {
                                        const dhis2ValidationErrors = checkDhis2Validations(
                                            validations,
                                            rulesInstructions
                                        );

                                        const importSummary = mapDataValuesToImportSummary(saveSummary, action);

                                        const blockingErrorsWithDHISValidation =
                                            action === "DELETE" ? [] : [...allBlockingErrors, ...dhis2ValidationErrors];

                                        const summaryWithConsistencyBlokingErrors = includeBlockingErrors(
                                            importSummary,
                                            blockingErrorsWithDHISValidation
                                        );

                                        summaryWithConsistencyBlokingErrors.importTime = saveSummary.importTime;

                                        return withCopyWarnings(summaryWithConsistencyBlokingErrors);
                                    });
                            });
                    }
                    //If dry-run, do not run validations
                    else {
                        const importSummary = mapDataValuesToImportSummary(saveSummary, action);

                        const summaryWithConsistencyBlokingErrors = includeBlockingErrors(importSummary, [
                            ...allBlockingErrors,
                        ]);

                        summaryWithConsistencyBlokingErrors.importTime = saveSummary.importTime;
                        return Future.success(withCopyWarnings(summaryWithConsistencyBlokingErrors));
                    }
                });
            });
    }
}
