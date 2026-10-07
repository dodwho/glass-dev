import { UseCase } from "../UseCase";
import { FutureData } from "../entities/Future";
import { GlassUploads } from "../entities/GlassUploads";
import { GlassUploadsRepository } from "../repositories/GlassUploadsRepository";

export class GetDeletedGlassUploadsByModuleOUUseCase implements UseCase {
    constructor(private glassUploadsRepository: GlassUploadsRepository) {}

    public execute(module: string, orgUnit: string): FutureData<GlassUploads[]> {
        return this.glassUploadsRepository.getDeletedUploadsByModuleOU(module, orgUnit);
    }
}
