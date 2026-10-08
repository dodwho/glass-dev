import { UseCase } from "../UseCase";
import { FutureData, Future } from "../entities/Future";
import { GlassUploads } from "../entities/GlassUploads";
import { GlassDataSubmissionsRepository } from "../repositories/GlassDataSubmissionRepository";
import { GlassUploadsRepository } from "../repositories/GlassUploadsRepository";
import { AMR_INDIVIDUAL_MODULE_ID, AMR_MODULE_ID } from "../entities/GlassMetadataReferences";
import { MODULE_NAMES } from "../entities/GlassModule";
import { moduleProperties } from "../utils/ModuleProperties";

/**
 * Batch ids keep files apart inside the aggregate RIS and SAMPLE datasets. A RIS Individual file goes to the
 * Individual tracker program instead, so it never takes up a batch id there (the upload screen still saves one,
 * hidden). Only the Individual SAMPLE file shares the aggregate datasets.
 */
export function withoutRisIndividualUploads(uploads: GlassUploads[]): GlassUploads[] {
    const risIndividualFileType = moduleProperties.get(MODULE_NAMES.AMR_INDIVIDUAL)?.primaryFileType;
    return uploads.filter(upload => upload.fileType !== risIndividualFileType);
}

export class GetGlassUploadsByDataSubmissionUseCase implements UseCase {
    constructor(
        private glassUploadsRepository: GlassUploadsRepository,
        private glassDataSubmissionRepository: GlassDataSubmissionsRepository
    ) {}

    public execute(orgUnit: string, period: string): FutureData<GlassUploads[]> {
        return Future.joinObj({
            amrAgg: this.glassDataSubmissionRepository.getSpecificDataSubmission(AMR_MODULE_ID, orgUnit, period),
            amrInd: this.glassDataSubmissionRepository.getSpecificDataSubmission(
                AMR_INDIVIDUAL_MODULE_ID,
                orgUnit,
                period
            ),
        }).flatMap(({ amrAgg, amrInd }) => {
            const dataSubmissionIds = [amrAgg[0]?.id, amrInd[0]?.id].filter((id): id is string => id !== undefined);
            return dataSubmissionIds.length > 0
                ? this.glassUploadsRepository.getByDataSubmissionIds(dataSubmissionIds).map(withoutRisIndividualUploads)
                : Future.success([]);
        });
    }
}
