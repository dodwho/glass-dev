import { GlassUploads } from "../../entities/GlassUploads";
import { withoutRisIndividualUploads } from "../GetGlassUploadsByDataSubmissionUseCase";

function upload(id: string, fileType: string): GlassUploads {
    return {
        id,
        batchId: "DS1",
        countryCode: "KWT",
        fileType,
        fileId: `file-${id}`,
        fileName: `${id}.csv`,
        inputLineNb: 0,
        outputLineNb: 0,
        period: "2025",
        specimens: [],
        status: "COMPLETED",
        uploadDate: "2026-10-04T10:00:00.000",
        dataSubmission: "ds1",
        module: "module1",
        orgUnit: "ou1",
        rows: 10,
        correspondingRisUploadId: "",
    };
}

describe("withoutRisIndividualUploads", () => {
    it("drops RIS Individual files, which never share the aggregate datasets", () => {
        const uploads = [upload("ind", "RIS Individual")];
        expect(withoutRisIndividualUploads(uploads)).toEqual([]);
    });

    it("keeps aggregate RIS and SAMPLE files and the Individual SAMPLE file, which share the datasets", () => {
        const uploads = [upload("ris", "RIS"), upload("sample", "SAMPLE"), upload("indSample", "SAMPLE File")];
        expect(withoutRisIndividualUploads(uploads)).toEqual(uploads);
    });
});
