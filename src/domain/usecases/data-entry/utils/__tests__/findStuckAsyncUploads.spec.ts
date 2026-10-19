import { AsyncUploadProgress, ASYNC_UPLOAD_STALE_AFTER_MS } from "../../../../entities/AsyncUploadProgress";
import { GlassAsyncUpload } from "../../../../entities/GlassAsyncUploads";
import { findStuckAsyncUploads } from "../AsyncUploadProgressTracker";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - ASYNC_UPLOAD_STALE_AFTER_MS - 60 * 1000).toISOString();
const RECENT = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();

function queueItem(uploadId: string, changes: Partial<GlassAsyncUpload> = {}): GlassAsyncUpload {
    return { uploadId, type: "primary", attempts: 0, status: "UPLOADING", ...changes };
}

function progress(uploadId: string, changes: Partial<AsyncUploadProgress>): AsyncUploadProgress {
    return {
        uploadId,
        runId: "run01",
        orgUnit: "countryOu01",
        trackedEntityType: "tet01",
        state: "IN_PROGRESS",
        heartbeatAt: RECENT,
        savedIdChunks: 1,
        ...changes,
    };
}

describe("findStuckAsyncUploads", () => {
    it("retries, counting an attempt, an upload that stopped while it had no progress record", () => {
        // A crash during the file download, during a SAMPLE import, or just after the record was removed.
        const result = findStuckAsyncUploads([queueItem("up1", { uploadingStartedAt: OLD })], [], NOW);

        expect(result).toEqual({ retry: ["up1"], finish: [], stamp: [] });
    });

    it("finishes, without an attempt, an upload imported by a run that stopped before saving its status", () => {
        const result = findStuckAsyncUploads(
            [queueItem("up1", { uploadingStartedAt: OLD })],
            [progress("up1", { state: "COMPLETED", heartbeatAt: OLD })],
            NOW
        );

        expect(result).toEqual({ retry: [], finish: ["up1"], stamp: [] });
    });

    it("leaves a long import that has only just completed to the run still saving its status", () => {
        const result = findStuckAsyncUploads(
            [queueItem("up1", { uploadingStartedAt: OLD })],
            [progress("up1", { state: "COMPLETED", heartbeatAt: RECENT })],
            NOW
        );

        expect(result).toEqual({ retry: [], finish: [], stamp: [] });
    });

    it("leaves a live import, however long ago it started", () => {
        const result = findStuckAsyncUploads(
            [queueItem("up1", { uploadingStartedAt: OLD })],
            [progress("up1", { state: "IN_PROGRESS", heartbeatAt: RECENT })],
            NOW
        );

        expect(result).toEqual({ retry: [], finish: [], stamp: [] });
    });

    it("leaves interrupted and undo-required imports to the undo recovery", () => {
        const result = findStuckAsyncUploads(
            [queueItem("up1", { uploadingStartedAt: OLD }), queueItem("up2", { uploadingStartedAt: OLD })],
            [progress("up1", { heartbeatAt: OLD }), progress("up2", { state: "UNDO_REQUIRED", heartbeatAt: OLD })],
            NOW
        );

        expect(result).toEqual({ retry: [], finish: [], stamp: [] });
    });

    it("leaves an upload without a progress record that started recently (downloading its file)", () => {
        const result = findStuckAsyncUploads([queueItem("up1", { uploadingStartedAt: RECENT })], [], NOW);

        expect(result).toEqual({ retry: [], finish: [], stamp: [] });
    });

    it("stamps an upload left UPLOADING before the start time was recorded", () => {
        const result = findStuckAsyncUploads([queueItem("up1")], [], NOW);

        expect(result).toEqual({ retry: [], finish: [], stamp: ["up1"] });
    });

    it("ignores pending uploads and the progress records of other uploads", () => {
        const result = findStuckAsyncUploads(
            [queueItem("up1", { status: "PENDING" }), queueItem("up2", { type: "secondary", uploadingStartedAt: OLD })],
            [progress("up1", { state: "COMPLETED", heartbeatAt: OLD })],
            NOW
        );

        expect(result).toEqual({ retry: ["up2"], finish: [], stamp: [] });
    });
});
