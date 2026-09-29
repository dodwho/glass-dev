import { Future, FutureData } from "../../../entities/Future";
import { ImportStrategy } from "../../../entities/data-entry/DataValuesSaveSummary";
import { getDefaultErrorImportSummary, ImportSummary } from "../../../entities/data-entry/ImportSummary";
import { GlassDocumentsRepository } from "../../../repositories/GlassDocumentsRepository";
import { GlassUploadsRepository } from "../../../repositories/GlassUploadsRepository";
import { TrackerRepository } from "../../../repositories/TrackerRepository";
import { RISIndividualFungalDataRepository } from "../../../repositories/data-entry/RISIndividualFungalDataRepository";
import { mapToImportSummary, uploadIdListFileAndSave } from "../ImportBLTemplateEventProgram";
import { MetadataRepository } from "../../../repositories/MetadataRepository";
import { GlassModuleRepository } from "../../../repositories/GlassModuleRepository";
import { CustomDataColumns } from "../../../entities/data-entry/amr-individual-fungal-external/RISIndividualFungalData";
import { downloadIdsAndDeleteTrackedEntities } from "../utils/downloadIdsAndDeleteTrackedEntities";
import { Country } from "../../../entities/Country";
import { getLineNumbersByTrackerId, mapIndividualFungalDataItemsToEntities } from "./common";
import { validateRISIndividualFungalRows } from "./validateRISIndividualFungalRows";

export const AMRIProgramID = "mMAj6Gofe49";
export const AMR_GLASS_AMR_TET_PATIENT = "CcgnfemKr5U";
export const AMRDataProgramStageId = "KCmWZD8qoAk";
export const AMRCandidaProgramStageId = "ysGSonDq9Bc";

// Line 1 of the file is the header row.
const FIRST_DATA_LINE = 2;

export class ImportRISIndividualFungalFile {
    constructor(
        private risIndividualFungalRepository: RISIndividualFungalDataRepository,
        private trackerRepository: TrackerRepository,
        private glassDocumentsRepository: GlassDocumentsRepository,
        private glassUploadsRepository: GlassUploadsRepository,
        private metadataRepository: MetadataRepository,
        private moduleRepository: GlassModuleRepository
    ) {}

    public importRISIndividualFungalFile(
        inputFile: File,
        action: ImportStrategy,
        orgUnit: string,
        countryCode: string,
        period: string,
        eventListId: string | undefined,
        program:
            | {
                  id: string;
                  programStageId: string;
              }
            | undefined,
        moduleName: string,
        dataColumns: CustomDataColumns,
        allCountries: Country[]
    ): FutureData<ImportSummary> {
        if (action === "CREATE_AND_UPDATE") {
            const programId = program ? program.id : AMRIProgramID;
            const programStageId = program
                ? program.programStageId
                : moduleName === "AMR - Individual"
                ? AMRDataProgramStageId
                : AMRCandidaProgramStageId;

            return Future.joinObj({
                rows: this.risIndividualFungalRepository.get(dataColumns, inputFile),
                module: this.moduleRepository.getByName(moduleName),
                programMetadata: this.trackerRepository.getProgramMetadata(programId, programStageId),
            }).flatMap(({ rows, module, programMetadata }) =>
                validateRISIndividualFungalRows(
                    rows,
                    {
                        countryCode,
                        period,
                        programStageId,
                        programMetadata,
                        specimenPathogen: module.consistencyChecks?.specimenPathogen,
                    },
                    FIRST_DATA_LINE
                ).flatMap(blockingErrors => {
                    if (blockingErrors.length > 0) {
                        return Future.success(getDefaultErrorImportSummary({ blockingErrors }));
                    }

                    return mapIndividualFungalDataItemsToEntities(
                        rows,
                        orgUnit,
                        programId,
                        programStageId,
                        countryCode,
                        period,
                        allCountries,
                        programMetadata
                    ).flatMap(trackedEntities =>
                        this.trackerRepository
                            .import({ trackedEntities }, { action: action, async: true })
                            .flatMap(response =>
                                mapToImportSummary(response, "trackedEntity", this.metadataRepository, {
                                    eventIdLineNoMap: getLineNumbersByTrackerId(trackedEntities, FIRST_DATA_LINE),
                                })
                            )
                            .flatMap(summary =>
                                uploadIdListFileAndSave(
                                    "primaryUploadId",
                                    summary,
                                    moduleName,
                                    this.glassDocumentsRepository,
                                    this.glassUploadsRepository
                                )
                            )
                    );
                })
            );
        } else {
            // NOTICE: check also DeleteRISIndividualFungalFileUseCase.ts that contains same code adapted for node environment (only DELETE)
            return downloadIdsAndDeleteTrackedEntities(
                eventListId,
                orgUnit,
                action,
                AMR_GLASS_AMR_TET_PATIENT,
                this.glassDocumentsRepository,
                this.trackerRepository,
                this.metadataRepository
            );
        }
    }
}
