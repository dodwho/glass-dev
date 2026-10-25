import { ImportSummary, ImportSummaryErrors } from "./data-entry/ImportSummary";
import { Id } from "./Ref";

export type GlassUploadsStatus = "UPLOADED" | "IMPORTED" | "VALIDATED" | "COMPLETED" | "DELETED";

/** IMPORTED means DHIS2 reported errors after the data was saved: such an upload must be deleted, not completed. */
export function canCompleteUpload(status: GlassUploadsStatus): boolean {
    return status === "VALIDATED";
}

/**
 * Whether deleting a SAMPLE-type (secondary) upload must also delete its file's values (a primary upload's always
 * are). An UPLOADED one holds none, except in AMR aggregate (isDryRunReq): its real import runs after the dry run and
 * can stop after writing values but before the status is saved.
 */
export function secondaryUploadMayHoldValues(status: string, isDryRunReq: boolean): boolean {
    return status.toUpperCase() !== "UPLOADED" || isDryRunReq;
}

export interface DeletionRequest {
    requestedBy: string;
    requestedAt: string;
    reason: string;
}

export interface GlassUploads {
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
    orgUnit: Id;
    records?: number;
    rows?: number;
    correspondingRisUploadId: string;
    eventListFileId?: string;
    calculatedEventListFileId?: string;
    importSummary?: ImportSummaryErrors;
    eventListDataDeleted?: boolean;
    calculatedEventListDataDeleted?: boolean;
    errorAsyncDeleting?: boolean;
    errorAsyncUploading?: boolean;
    asyncImportSummaries?: ImportSummary[];
    deletionRequest?: DeletionRequest;
    deleted?: boolean;
}
