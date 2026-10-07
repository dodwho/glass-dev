import { UseCase } from "../UseCase";
import { Future, FutureData } from "../entities/Future";
import { Id } from "../entities/Ref";
import { GlassUploadsRepository } from "../repositories/GlassUploadsRepository";

export type RequestUploadDeletionOptions = {
    uploadIds: Id[];
    requestedBy: string;
    reason: string;
};

/**
 * Records who asks to delete an upload, when and why, on the upload event itself.
 * It must run before the deletion, which soft-deletes the event and keeps these values as the audit trail.
 */
export class RequestUploadDeletionUseCase implements UseCase {
    constructor(private glassUploadsRepository: GlassUploadsRepository) {}

    public execute({ uploadIds, requestedBy, reason }: RequestUploadDeletionOptions): FutureData<void> {
        const trimmedReason = reason.trim();
        if (!trimmedReason) return Future.error("A reason is required to delete an upload");

        const request = { requestedBy, requestedAt: new Date().toISOString(), reason: trimmedReason };

        return Future.sequential(uploadIds.map(id => this.glassUploadsRepository.requestDeletion(id, request))).map(
            () => undefined
        );
    }
}
