import { UseCase } from "../../CompositionRoot";
import { Future, FutureData } from "../entities/Future";
import { GlassUploads, GlassUploadsStatus } from "../entities/GlassUploads";
import { Id } from "../entities/Ref";
import { GlassAsyncUploadsRepository } from "../repositories/GlassAsyncUploadsRepository";
import { GlassUploadsRepository } from "../repositories/GlassUploadsRepository";
import { Maybe } from "../../utils/ts-utils";

export type FileToUpload = { fileName: string; fileType: string; rows: number };

const STATUSES_WITH_DATA_IN_DHIS2: GlassUploadsStatus[] = ["IMPORTED", "VALIDATED", "COMPLETED"];

/**
 * An earlier upload of the same file (same name, type and row count) for the same module, org unit and period
 * whose data is in DHIS2 or is queued to be imported. Uploading it again would import the same records twice.
 * Deleted uploads and failed uploads that are not queued do not count, so a file can still be replaced or retried.
 */
export function findAlreadyImportedUpload(
    uploads: GlassUploads[],
    queuedUploadIds: Set<Id>,
    file: FileToUpload
): Maybe<GlassUploads> {
    return uploads.find(
        upload =>
            upload.fileName === file.fileName &&
            upload.fileType === file.fileType &&
            upload.rows === file.rows &&
            ((STATUSES_WITH_DATA_IN_DHIS2.includes(upload.status) && !upload.eventListDataDeleted) ||
                (upload.status === "UPLOADED" && queuedUploadIds.has(upload.id)))
    );
}

export class GetAlreadyImportedUploadUseCase implements UseCase {
    constructor(
        private repositories: {
            glassUploadsRepository: GlassUploadsRepository;
            glassAsyncUploadsRepository: GlassAsyncUploadsRepository;
        }
    ) {}

    public execute(params: {
        moduleId: Id;
        orgUnit: Id;
        period: string;
        file: FileToUpload;
    }): FutureData<Maybe<GlassUploads>> {
        const { moduleId, orgUnit, period, file } = params;

        return Future.joinObj({
            uploads: this.repositories.glassUploadsRepository.getUploadsByModuleOUPeriod({ moduleId, orgUnit, period }),
            queued: this.repositories.glassAsyncUploadsRepository.getAsyncUploads(),
        }).map(({ uploads, queued }) =>
            findAlreadyImportedUpload(uploads, new Set(queued.map(({ uploadId }) => uploadId)), file)
        );
    }
}
