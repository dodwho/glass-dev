import { canCompleteUpload, GlassUploadsStatus, secondaryUploadMayHoldValues } from "../GlassUploads";

const statuses: GlassUploadsStatus[] = ["UPLOADED", "IMPORTED", "VALIDATED", "COMPLETED", "DELETED"];

describe("canCompleteUpload", () => {
    // IMPORTED means DHIS2 reported errors after the data was saved; such an upload must be deleted, not completed.
    it("allows only a VALIDATED upload to be completed", () => {
        expect(statuses.filter(canCompleteUpload)).toEqual(["VALIDATED"]);
    });
});

describe("secondaryUploadMayHoldValues", () => {
    it("skips the values of an UPLOADED file in modules that import in the first step", () => {
        expect(statuses.filter(status => secondaryUploadMayHoldValues(status, false))).toEqual([
            "IMPORTED",
            "VALIDATED",
            "COMPLETED",
            "DELETED",
        ]);
        expect(secondaryUploadMayHoldValues("uploaded", false)).toBe(false);
    });

    // An AMR aggregate import cut off before its status was saved leaves values behind an UPLOADED upload (Norway 2024)
    it("deletes the values of an AMR aggregate (dry-run) file whatever its status", () => {
        expect(statuses.every(status => secondaryUploadMayHoldValues(status, true))).toBe(true);
    });
});
