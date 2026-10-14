import { TextDecoder } from "util";
import * as XLSX from "xlsx";
import { SpreadsheetXlsxDataSource } from "../SpreadsheetXlsxDefaultRepository";

// jest's jsdom environment has no TextDecoder; browsers and Node do.
Object.assign(global, { TextDecoder });

// XLSX.read auto-detects a Node Buffer reliably under jest's jsdom env, whereas a bare ArrayBuffer
// is not picked up there (a SheetJS environment-detection quirk; the real browser app passes a
// File.arrayBuffer() that works fine). readFromArrayBuffer forwards its argument straight to
// XLSX.read, so handing it a Buffer exercises the same code path.
function csvToArrayBuffer(csv: string): ArrayBuffer {
    return bytesToArrayBuffer(Buffer.from(csv, "utf8"));
}

function bytesToArrayBuffer(bytes: Buffer): ArrayBuffer {
    return bytes as unknown as ArrayBuffer;
}

async function readFirstRow(data: ArrayBuffer) {
    const spreadsheet = await new SpreadsheetXlsxDataSource().readFromArrayBuffer(data);
    return { headers: spreadsheet.sheets[0]?.headers, row: spreadsheet.sheets[0]?.rows[0] };
}

describe("SpreadsheetXlsxDataSource text encoding", () => {
    it("reads a UTF-8 CSV without garbling non-ASCII characters", async () => {
        const { row } = await readFirstRow(csvToArrayBuffer("DISKLOAD,PATHOGEN\n30µg,Café\n"));

        expect(row).toEqual({ DISKLOAD: "30µg", PATHOGEN: "Café" });
    });

    it("drops a UTF-8 byte order mark from the first header", async () => {
        const { headers, row } = await readFirstRow(csvToArrayBuffer("﻿DISKLOAD,X\n10µg,1\n"));

        expect(headers).toEqual(["DISKLOAD", "X"]);
        expect(row).toEqual({ DISKLOAD: "10µg", X: "1" });
    });

    it("still reads a CSV saved in a single-byte encoding (Windows-1252) as before", async () => {
        // "µ" is the single byte 0xB5 in Windows-1252, which is not valid UTF-8.
        const latin1 = Buffer.concat([Buffer.from("DISKLOAD,X\n30"), Buffer.from([0xb5]), Buffer.from("g,1\n")]);
        const { row } = await readFirstRow(bytesToArrayBuffer(latin1));

        expect(row).toEqual({ DISKLOAD: "30µg", X: "1" });
    });

    it("still reads .xlsx workbooks from their bytes", async () => {
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(
            workbook,
            XLSX.utils.aoa_to_sheet([
                ["DISKLOAD", "X"],
                ["30µg", 1],
            ]),
            "Data"
        );
        const xlsx: Buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

        const { row } = await readFirstRow(bytesToArrayBuffer(xlsx));

        expect(row).toEqual({ DISKLOAD: "30µg", X: 1 });
    });
});

describe("SpreadsheetXlsxDataSource date handling", () => {
    it("keeps ISO date cells as literal YYYY-MM-DD strings (no JS Date coercion)", async () => {
        const csv = ["SAMPLE_DATE,SPECIMEN", "2024-10-09,BLOOD"].join("\n");

        const spreadsheet = await new SpreadsheetXlsxDataSource().readFromArrayBuffer(csvToArrayBuffer(csv));
        const value: unknown = spreadsheet.sheets[0]?.rows[0]?.["SAMPLE_DATE"];

        // A literal string, not a coerced Date object (a Date would be typeof "object").
        expect(typeof value).toBe("string");
        expect(value).toBe("2024-10-09");
    });

    it("keeps non-ISO date cells as their literal text so format validation can flag them", async () => {
        const csv = ["SAMPLE_DATE,SPECIMEN", "8/5/2024,BLOOD"].join("\n");

        const spreadsheet = await new SpreadsheetXlsxDataSource().readFromArrayBuffer(csvToArrayBuffer(csv));
        const value: unknown = spreadsheet.sheets[0]?.rows[0]?.["SAMPLE_DATE"];

        // A literal string, not a coerced Date object (a Date would be typeof "object").
        expect(typeof value).toBe("string");
        expect(value).toBe("8/5/2024");
    });
});
