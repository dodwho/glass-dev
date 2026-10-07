import { ImportSummaryErrors } from "../../domain/entities/data-entry/ImportSummary";
import { DeletionRequest, GlassUploadsStatus } from "../../domain/entities/GlassUploads";

export interface UploadsDataItem {
    id: string;
    batchId: string;
    countryCode: string;
    fileType: string;
    fileId: string;
    fileName: string;
    inputLineNb: number;
    outputLineNb: number;
    period: string;
    specimens: string[];
    status: GlassUploadsStatus;
    uploadDate: string;
    uploadedBy?: string;
    dataSubmission: string;
    module: string;
    orgUnit: string;
    rows?: number;
    correspondingRisUploadId: string;
    eventListFileId?: string;
    calculatedEventListFileId?: string;
    importSummary?: ImportSummaryErrors;
    eventListDataDeleted?: boolean;
    calculatedEventListDataDeleted?: boolean;
    errorAsyncDeleting?: boolean;
    errorAsyncUploading?: boolean;
    deletionRequest?: DeletionRequest;
}
