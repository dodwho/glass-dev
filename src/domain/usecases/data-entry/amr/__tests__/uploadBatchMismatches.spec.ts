import { uploadBatchMismatches } from "../uploadBatchMismatches";

describe("uploadBatchMismatches", () => {
    it("passes when every upload record names the chosen dataset", () => {
        const uploads = [
            { fileName: "ris.csv", batchId: "DS2" },
            { fileName: "sample.csv", batchId: "DS2" },
        ];
        expect(uploadBatchMismatches(uploads, "DS2")).toEqual([]);
    });

    it("names each record saved under another dataset (GBR 2024: record DS2, import DS3)", () => {
        const uploads = [
            { fileName: "ukhsa.csv", batchId: "DS2" },
            { fileName: "sample.csv", batchId: "" },
        ];
        expect(uploadBatchMismatches(uploads, "DS3")).toEqual([
            "ukhsa.csv: saved as DS2, chosen DS3",
            "sample.csv: saved as no dataset, chosen DS3",
        ]);
    });
});
