import { UseCase } from "../UseCase";
import { FutureData } from "../entities/Future";
import { DataSubmissionStatusTypes, StatusChangedBy } from "../entities/GlassDataSubmission";
import { GlassDataSubmissionsRepository } from "../repositories/GlassDataSubmissionRepository";

export class SetDataSubmissionStatusUseCase implements UseCase {
    constructor(private glassDataSubmissionRepository: GlassDataSubmissionsRepository) {}

    public execute(id: string, status: DataSubmissionStatusTypes, changedBy: StatusChangedBy): FutureData<void> {
        return this.glassDataSubmissionRepository.setStatus(id, status, changedBy);
    }
}
