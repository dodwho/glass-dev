import { ASYNC_UPLOAD_STALE_AFTER_MS } from "../AsyncUploadProgress";
import { GlassAsyncDeletion, isStaleDeletion } from "../GlassAsyncDeletions";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - ASYNC_UPLOAD_STALE_AFTER_MS - 60 * 1000).toISOString();
const RECENT = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
const DAY_AGO = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();

function deletion(changes: Partial<GlassAsyncDeletion>): GlassAsyncDeletion {
    return { uploadId: "up1", attempts: 0, status: "DELETING", ...changes };
}

describe("isStaleDeletion", () => {
    it("keeps a long deletion that is still showing signs of life", () => {
        // Before 1.6.46 any deletion running over 4 hours was restarted alongside itself.
        expect(isStaleDeletion(deletion({ deletingStartedAt: DAY_AGO, lastSeenAt: RECENT }), NOW)).toBe(false);
    });

    it("flags a deletion silent for longer than the stale window", () => {
        expect(isStaleDeletion(deletion({ deletingStartedAt: DAY_AGO, lastSeenAt: OLD }), NOW)).toBe(true);
    });

    it("falls back to the start time before the first sign of life", () => {
        expect(isStaleDeletion(deletion({ deletingStartedAt: RECENT }), NOW)).toBe(false);
        expect(isStaleDeletion(deletion({ deletingStartedAt: OLD }), NOW)).toBe(true);
    });

    it("flags a DELETING entry without any timestamp", () => {
        expect(isStaleDeletion(deletion({}), NOW)).toBe(true);
    });

    it("never flags a pending deletion", () => {
        expect(isStaleDeletion(deletion({ status: "PENDING", deletingStartedAt: OLD }), NOW)).toBe(false);
    });
});
