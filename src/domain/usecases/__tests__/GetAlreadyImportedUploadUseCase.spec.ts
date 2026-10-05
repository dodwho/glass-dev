import { GlassUploads } from "../../entities/GlassUploads";
import { findAlreadyImportedUpload } from "../GetAlreadyImportedUploadUseCase";

const file = { fileName: "ris_2024.csv", fileType: "RIS", rows: 1500 };

function upload(overrides: Partial<GlassUploads>): GlassUploads {
    return {
        id: "upload1",
        batchId: "DS1",
        countryCode: "CPV",
        fileType: "RIS",
        fileId: "file1",
        fileName: "ris_2024.csv",
        inputLineNb: 0,
        outputLineNb: 0,
        period: "2024",
        specimens: [],
        status: "IMPORTED",
        uploadDate: "2026-09-01T10:00:00.000",
        dataSubmission: "ds1",
        module: "module1",
        orgUnit: "ou1",
        rows: 1500,
        correspondingRisUploadId: "",
        ...overrides,
    };
}

const noneQueued = new Set<string>();

describe("findAlreadyImportedUpload", () => {
    it.each(["IMPORTED", "VALIDATED", "COMPLETED"] as const)("finds the same file with status %s", status => {
        const existing = upload({ status });
        expect(findAlreadyImportedUpload([existing], noneQueued, file)).toBe(existing);
    });

    it("finds the same file waiting in the async-upload queue", () => {
        const existing = upload({ status: "UPLOADED" });
        expect(findAlreadyImportedUpload([existing], new Set(["upload1"]), file)).toBe(existing);
    });

    it("ignores an upload that was not imported and is not queued, so it can be retried", () => {
        expect(findAlreadyImportedUpload([upload({ status: "UPLOADED" })], noneQueued, file)).toBeUndefined();
    });

    it("ignores deleted uploads and uploads whose imported data was deleted", () => {
        const uploads = [upload({ status: "DELETED" }), upload({ status: "IMPORTED", eventListDataDeleted: true })];
        expect(findAlreadyImportedUpload(uploads, new Set(["upload1"]), file)).toBeUndefined();
    });

    it("treats a browser copy suffix as the same file, in either direction", () => {
        const original = upload({});
        const copy = upload({ id: "upload2", fileName: "ris_2024 (1).csv" });
        expect(findAlreadyImportedUpload([original], noneQueued, { ...file, fileName: "ris_2024 (1).csv" })).toBe(
            original
        );
        expect(findAlreadyImportedUpload([copy], noneQueued, file)).toBe(copy);
        expect(findAlreadyImportedUpload([copy], noneQueued, { ...file, fileName: "ris_2024 (12).csv" })).toBe(copy);
    });

    it("does not treat a year in brackets or other name changes as a copy suffix", () => {
        const uploads = [
            upload({ fileName: "ris (2023).csv" }),
            upload({ fileName: "ris_2024 (copy).csv" }),
            upload({ fileName: "ris_2024(1).csv" }),
        ];
        expect(findAlreadyImportedUpload(uploads, noneQueued, { ...file, fileName: "ris (2024).csv" })).toBeUndefined();
        expect(findAlreadyImportedUpload(uploads, noneQueued, file)).toBeUndefined();
    });

    it("ignores a file with a different name, type or number of rows", () => {
        const uploads = [
            upload({ fileName: "ris_2024_v2.csv" }),
            upload({ fileType: "SAMPLE" }),
            upload({ rows: 1499 }),
        ];
        expect(findAlreadyImportedUpload(uploads, noneQueued, file)).toBeUndefined();
    });
});
