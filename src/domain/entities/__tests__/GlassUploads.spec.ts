import { canCompleteUpload, GlassUploadsStatus } from "../GlassUploads";

describe("canCompleteUpload", () => {
    // IMPORTED means DHIS2 reported errors after the data was saved; such an upload must be deleted, not completed.
    it("allows only a VALIDATED upload to be completed", () => {
        const statuses: GlassUploadsStatus[] = ["UPLOADED", "IMPORTED", "VALIDATED", "COMPLETED", "DELETED"];

        expect(statuses.filter(canCompleteUpload)).toEqual(["VALIDATED"]);
    });
});
