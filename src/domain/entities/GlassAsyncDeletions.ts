import { ASYNC_UPLOAD_STALE_AFTER_MS } from "./AsyncUploadProgress";
import { Id } from "./Ref";

export type GlassAsyncDeletionStatus = "PENDING" | "DELETING";

export type GlassAsyncDeletion = {
    uploadId: Id;
    attempts: number;
    status: GlassAsyncDeletionStatus;
    deletingStartedAt?: string; // ISO timestamp recorded when status is set to DELETING
    lastSeenAt?: string; // ISO timestamp written while a deletion is running and DHIS2 is still answering it
};

/**
 * A deletion still marked DELETING that has shown no sign of life for as long as an async upload import may
 * (2 hours) was left by a crashed or hung run. A long deletion that is still working is never stale, whatever
 * its size. An entry without any timestamp predates the timestamps and is treated as stale.
 */
export function isStaleDeletion(deletion: GlassAsyncDeletion, now = new Date()): boolean {
    if (deletion.status !== "DELETING") return false;
    const lastSign = deletion.lastSeenAt ?? deletion.deletingStartedAt;
    if (!lastSign) return true;
    return now.getTime() - new Date(lastSign).getTime() > ASYNC_UPLOAD_STALE_AFTER_MS;
}
