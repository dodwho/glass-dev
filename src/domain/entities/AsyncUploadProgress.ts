import { Id } from "./Ref";

/**
 * Durable record of an async upload that is being imported into DHIS2. It is written before any data is
 * sent, together with the ids of every tracked entity about to be sent, so that the records of a failed
 * or interrupted import can always be found and removed: an upload is either imported entirely or not at all.
 * A COMPLETED record marks a finished import until its final status is saved, so a retry never re-imports it.
 */
export type AsyncUploadProgress = {
    uploadId: Id;
    runId: Id;
    orgUnit: Id;
    trackedEntityType: Id;
    state: "IN_PROGRESS" | "UNDO_REQUIRED" | "COMPLETED";
    heartbeatAt: string;
    savedIdChunks: number;
};

/** An import whose record has not been updated for this long is assumed to have been interrupted. */
export const ASYNC_UPLOAD_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export function isInterrupted(progress: AsyncUploadProgress, now = new Date()): boolean {
    switch (progress.state) {
        case "COMPLETED":
            return false;
        case "UNDO_REQUIRED":
            return true;
        case "IN_PROGRESS":
            return now.getTime() - new Date(progress.heartbeatAt).getTime() > ASYNC_UPLOAD_STALE_AFTER_MS;
    }
}
