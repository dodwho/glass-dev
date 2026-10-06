import { Id } from "../entities/Ref";
import { UseCase } from "../UseCase";
import { FutureData } from "../entities/Future";
import { GlassUploadsRepository } from "../repositories/GlassUploadsRepository";
import { GlassUploads } from "../entities/GlassUploads";

export class GetUploadsByDataSubmissionUseCase implements UseCase {
    constructor(private glassUploadsRepository: GlassUploadsRepository) {}

    public execute(dataSubmissionId: Id): FutureData<GlassUploads[]> {
        return this.glassUploadsRepository.getUploadsByDataSubmission(dataSubmissionId);
    }
}
