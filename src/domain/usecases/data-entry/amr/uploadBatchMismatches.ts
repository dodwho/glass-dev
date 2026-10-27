import { GlassUploads } from "../../../entities/GlassUploads";

/**
 * The import writes under the dataset chosen on screen (and checkBatchId compares the file's rows with it), while the
 * uploads list shows the dataset saved on the upload record. Saving a changed dataset to the record can fail, which
 * left GBR 2024 RIS stored under DS3 with its upload saying DS2 (29 Aug 2025). The real import only starts when every
 * upload record names the dataset it will be written under.
 */
export function uploadBatchMismatches(
    uploads: Pick<GlassUploads, "fileName" | "batchId">[],
    batchId: string
): string[] {
    return uploads
        .filter(upload => upload.batchId !== batchId)
        .map(upload => `${upload.fileName}: saved as ${upload.batchId || "no dataset"}, chosen ${batchId}`);
}
