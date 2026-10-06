import { UseCase } from "../UseCase";
import { FutureData, Future } from "../entities/Future";
import { GlassUploads } from "../entities/GlassUploads";
import { GlassDataSubmissionsRepository } from "../repositories/GlassDataSubmissionRepository";
import { GlassUploadsRepository } from "../repositories/GlassUploadsRepository";
import { AMR_INDIVIDUAL_MODULE_ID, AMR_MODULE_ID } from "../entities/GlassMetadataReferences";

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
                ? this.glassUploadsRepository.getByDataSubmissionIds(dataSubmissionIds)
                : Future.success([]);
        });
    }
}
