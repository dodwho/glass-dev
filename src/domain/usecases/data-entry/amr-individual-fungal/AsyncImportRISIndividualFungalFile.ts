import { Maybe } from "../../../../utils/ts-utils";
import { Country } from "../../../entities/Country";
import { Future, FutureData } from "../../../entities/Future";
import { GlassModule } from "../../../entities/GlassModule";
import { Id } from "../../../entities/Ref";
import {
    ConsistencyError,
    getDefaultErrorImportSummary,
    ImportSummary,
    mergeConsistencyErrors,
} from "../../../entities/data-entry/ImportSummary";
import { CustomDataColumns } from "../../../entities/data-entry/amr-individual-fungal-external/RISIndividualFungalData";
import { AsyncUploadProgressRepository } from "../../../repositories/AsyncUploadProgressRepository";
import { GlassDocumentsRepository } from "../../../repositories/GlassDocumentsRepository";
import { GlassUploadsRepository } from "../../../repositories/GlassUploadsRepository";
import { MetadataRepository } from "../../../repositories/MetadataRepository";
import { TrackerRepository } from "../../../repositories/TrackerRepository";
import { RISIndividualFungalDataRepository } from "../../../repositories/data-entry/RISIndividualFungalDataRepository";
import { getLineNumbersByTrackerId, mapIndividualFungalDataItemsToEntities } from "./common";
import {
    RISIndividualFungalValidationContext,
    validateRISIndividualFungalRows,
} from "./validateRISIndividualFungalRows";
import { importTrackedEntitiesInChunksForAsyncUpload } from "../utils/importOrDeleteTrackedEntitiesInChunks";
import { AsyncUploadProgressTracker } from "../utils/AsyncUploadProgressTracker";
import consoleLogger from "../../../../utils/consoleLogger";
import {
    AMR_DATA_PROGRAM_STAGE_ID,
    AMR_FUNGAL_PROGRAM_STAGE_ID,
    AMR_GLASS_AMR_TET_PATIENT,
    AMR_INDIVIDUAL_PROGRAM_ID,
} from "../../../entities/GlassMetadataReferences";

const FILE_CHUNK_SIZE = 5000;
// Line 1 of the file is the header row.
const FIRST_DATA_LINE = 2;

type Params = {
    uploadId: Id;
    inputBlob: Blob;
    glassModule: GlassModule;
    uploadChunkSize: number;
    maxConcurrency: number;
    orgUnitId: Id;
    countryCode: string;
    period: string;
    program: Maybe<{ id: Id; programStageId: string }>;
    dataColumns: CustomDataColumns;
    allCountries: Country[];
};

type ImportContext = Params & {
    programId: Id;
    programStageId: Id;
    programMetadata: RISIndividualFungalValidationContext["programMetadata"];
    tracker: AsyncUploadProgressTracker;
};

type Outcome =
    | { type: "invalid"; summaries: ImportSummary[] }
    | { type: "imported"; summaries: ImportSummary[] }
    | { type: "rejected"; summaries: ImportSummary[] };

/**
 * Imports a RIS individual/fungal file all-or-nothing: the whole file is checked first, and only if no row
 * is blocked is it sent to DHIS2 in chunks. If DHIS2 rejects any chunk, or anything fails once sending has
 * started, every record the upload created is removed again, so a partially imported file is never left.
 */
export class AsyncImportRISIndividualFungalFile {
    constructor(
        private repositories: {
            risIndividualFungalRepository: RISIndividualFungalDataRepository;
            trackerRepository: TrackerRepository;
            glassDocumentsRepository: GlassDocumentsRepository;
            glassUploadsRepository: GlassUploadsRepository;
            metadataRepository: MetadataRepository;
            asyncUploadProgressRepository: AsyncUploadProgressRepository;
        }
    ) {}

    public asyncImportRISIndividualFungalFile(params: Params): FutureData<ImportSummary[]> {
        const { uploadId, glassModule, orgUnitId, program } = params;
        const programId = program?.id ?? AMR_INDIVIDUAL_PROGRAM_ID;
        const programStageId =
            program?.programStageId ??
            (glassModule.name === "AMR - Individual" ? AMR_DATA_PROGRAM_STAGE_ID : AMR_FUNGAL_PROGRAM_STAGE_ID);

        return this.repositories.asyncUploadProgressRepository.get(uploadId).flatMap(previous => {
            if (previous?.state === "COMPLETED") {
                consoleLogger.debug(`Upload ${uploadId} was already imported by an earlier run`);
                return this.repositories.glassUploadsRepository
                    .getById(uploadId)
                    .map(upload => upload.asyncImportSummaries ?? []);
            }

            return AsyncUploadProgressTracker.start(this.repositories, {
                uploadId,
                orgUnit: orgUnitId,
                trackedEntityType: AMR_GLASS_AMR_TET_PATIENT,
            }).flatMap(tracker =>
                this.repositories.trackerRepository
                    .getProgramMetadata(programId, programStageId)
                    .flatMap(programMetadata =>
                        this.validateAndImport({ ...params, programId, programStageId, programMetadata, tracker })
                    )
                    // Anything failing here may have left records behind: remove them before reporting the error.
                    .flatMapError(error => tracker.undo().flatMap(() => Future.error<string, Outcome>(error)))
                    .flatMap(outcome => {
                        switch (outcome.type) {
                            case "imported":
                                return Future.success<ImportSummary[], string>(outcome.summaries);
                            case "invalid":
                                return this.saveAllImportSummaries(uploadId, outcome.summaries);
                            case "rejected":
                                return tracker
                                    .undo()
                                    .flatMap(() =>
                                        this.saveAllImportSummaries(uploadId, [nothingImported(outcome.summaries)])
                                    );
                        }
                    })
            );
        });
    }

    private validateAndImport(context: ImportContext): FutureData<Outcome> {
        return this.validateFile(context).flatMap(blockingErrors => {
            if (blockingErrors.length > 0) {
                consoleLogger.debug(`Upload ${context.uploadId} has blocking errors: nothing will be imported`);
                const summaries = [getDefaultErrorImportSummary({ blockingErrors })];
                return context.tracker.finish().map((): Outcome => ({ type: "invalid", summaries }));
            }

            return this.importFile(context).flatMap(({ summaries, trackedEntityIds, rejected }) =>
                rejected
                    ? Future.success<Outcome, string>({ type: "rejected", summaries })
                    : this.saveImportedIds(context, trackedEntityIds)
                          .flatMap(() => this.saveAllImportSummaries(context.uploadId, summaries))
                          .flatMap(() => context.tracker.complete())
                          .map((): Outcome => ({ type: "imported", summaries }))
            );
        });
    }

    private validateFile(context: ImportContext): FutureData<ConsistencyError[]> {
        const { inputBlob, dataColumns, countryCode, period, programStageId, programMetadata, glassModule } = context;
        const validationContext: RISIndividualFungalValidationContext = {
            countryCode,
            period,
            programStageId,
            programMetadata,
            specimenPathogen: glassModule.consistencyChecks?.specimenPathogen,
        };
        let blockingErrors: ConsistencyError[] = [];
        let firstLine = FIRST_DATA_LINE;

        return this.repositories.risIndividualFungalRepository
            .getFromBlobInChunks(dataColumns, inputBlob, FILE_CHUNK_SIZE, rows => {
                const chunkFirstLine = firstLine;
                firstLine += rows.length;
                return validateRISIndividualFungalRows(rows, validationContext, chunkFirstLine).flatMap(errors => {
                    blockingErrors = mergeConsistencyErrors(blockingErrors, errors);
                    return context.tracker.heartbeat().map(() => true);
                });
            })
            .map(() => blockingErrors);
    }

    private importFile(
        context: ImportContext
    ): FutureData<{ summaries: ImportSummary[]; trackedEntityIds: Id[]; rejected: boolean }> {
        const { uploadId, inputBlob, dataColumns, orgUnitId, programId, programStageId, countryCode, period } = context;
        const summaries: ImportSummary[] = [];
        const trackedEntityIds: Id[] = [];
        let rejected = false;
        let firstLine = FIRST_DATA_LINE;

        return this.repositories.risIndividualFungalRepository
            .getFromBlobInChunks(dataColumns, inputBlob, FILE_CHUNK_SIZE, rows => {
                const chunkFirstLine = firstLine;
                firstLine += rows.length;

                return mapIndividualFungalDataItemsToEntities(
                    rows,
                    orgUnitId,
                    programId,
                    programStageId,
                    countryCode,
                    period,
                    context.allCountries,
                    context.programMetadata
                ).flatMap(trackedEntities =>
                    context.tracker
                        .recordTrackedEntityIds(trackedEntities.map(({ trackedEntity }) => trackedEntity))
                        .flatMap(() =>
                            importTrackedEntitiesInChunksForAsyncUpload({
                                trackedEntities,
                                chunkSize: context.uploadChunkSize,
                                glassModuleName: context.glassModule.name,
                                trackerRepository: this.repositories.trackerRepository,
                                metadataRepository: this.repositories.metadataRepository,
                                skipSideEffects: true,
                                maxConcurrency: context.maxConcurrency,
                                lineNumbers: getLineNumbersByTrackerId(trackedEntities, chunkFirstLine),
                            })
                        )
                        .map(result => {
                            summaries.push(...result.allImportSummaries);
                            // Our own ids, recorded before sending: exact even if DHIS2 reports no object details.
                            trackedEntityIds.push(...trackedEntities.map(({ trackedEntity }) => trackedEntity));
                            if (result.hasBlockingErrors) {
                                consoleLogger.error(
                                    `DHIS2 rejected rows of upload ${uploadId} from line ${chunkFirstLine}: stopping`
                                );
                                rejected = true;
                            }
                            return !rejected;
                        })
                );
            })
            .map(() => ({ summaries, trackedEntityIds, rejected }));
    }

    // The saved list is what a later deletion of this upload removes.
    private saveImportedIds(context: ImportContext, trackedEntityIds: Id[]): FutureData<void> {
        if (trackedEntityIds.length === 0) return Future.success(undefined);

        const buffer = Buffer.from(JSON.stringify(trackedEntityIds), "utf-8");
        return this.repositories.glassDocumentsRepository
            .saveBuffer(buffer, `${context.uploadId}_eventIdsFile`, context.glassModule.name)
            .flatMap(fileId => this.repositories.glassUploadsRepository.setEventListFileId(context.uploadId, fileId));
    }

    private saveAllImportSummaries(uploadId: Id, importSummaries: ImportSummary[]): FutureData<ImportSummary[]> {
        return this.repositories.glassUploadsRepository
            .saveImportSummaries({ uploadId, importSummaries })
            .map(() => importSummaries);
    }
}

/** The DHIS2 errors of a rejected import, reported with nothing imported since its records were removed. */
function nothingImported(summaries: ImportSummary[]): ImportSummary {
    return getDefaultErrorImportSummary({
        blockingErrors: mergeConsistencyErrors(...summaries.map(summary => summary.blockingErrors)),
        nonBlockingErrors: mergeConsistencyErrors(...summaries.map(summary => summary.nonBlockingErrors)),
    });
}
