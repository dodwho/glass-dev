import _ from "lodash";
import * as XLSX from "xlsx";
import {
    Async,
    Row,
    Sheet,
    Spreadsheet,
    SpreadsheetDataSource,
} from "../../domain/repositories/SpreadsheetXlsxRepository";

// READ_OPTIONS_NOTE: we read with { raw: true } (not { cellDates: true }) so every cell is kept
// as the literal text the user typed. cellDates coerces date-like cells into JS Date objects, which
// (a) breaks the ISO date-format validation (a Date stringifies to "Wed Oct 09 2024 ...") and
// (b) shifts the calendar day depending on the runtime timezone. Downstream readers (getNumberValue,
// getTextValue) tolerate string values, so this is safe for every module that uses this data source.
//
// ENCODING_NOTE: given raw bytes, SheetJS reads a CSV as a single-byte code page, so UTF-8 text came out
// garbled ("30µg" was stored as "30Âµg"). A file that is valid UTF-8 text is therefore decoded first and
// parsed as a string. Spreadsheets (zip or OLE binaries) and CSVs in a legacy single-byte encoding are not
// valid UTF-8 and are still read from the bytes, exactly as before.
export class SpreadsheetXlsxDataSource implements SpreadsheetDataSource {
    async read(inputFile: File): Async<Spreadsheet> {
        try {
            const arrayBuffer = await inputFile.arrayBuffer();
            return this.readFromArrayBuffer(arrayBuffer, inputFile.name);
        } catch {
            return { name: "", sheets: [] };
        }
    }

    async readFromArrayBuffer(arrayBuffer: ArrayBuffer, fileName?: string): Async<Spreadsheet> {
        try {
            const workbook = readWorkbook(arrayBuffer);

            const sheets = _(workbook.Sheets)
                .toPairs()
                .map(([sheetName, worksheet]): Sheet => {
                    const headers = XLSX.utils.sheet_to_json<string[]>(worksheet, { header: 1, defval: "" })[0] || [];
                    const rows = XLSX.utils.sheet_to_json<Row<string>>(worksheet, { raw: true, skipHidden: false });

                    return {
                        name: sheetName,
                        headers,
                        rows,
                    };
                })
                .value();

            const spreadsheet: Spreadsheet = {
                name: fileName || "spreadsheet.xlsx",
                sheets,
            };

            return spreadsheet;
        } catch {
            return { name: "", sheets: [] };
        }
    }

    async readFromBlob(blob: Blob, fileName?: string): Async<Spreadsheet> {
        try {
            const arrayBuffer = await blob.arrayBuffer();
            return this.readFromArrayBuffer(arrayBuffer, fileName);
        } catch {
            return { name: "", sheets: [] };
        }
    }
}

// See READ_OPTIONS_NOTE and ENCODING_NOTE above.
function readWorkbook(data: ArrayBuffer): XLSX.WorkBook {
    const text = decodeUtf8Text(data);
    return text === undefined
        ? XLSX.read(data, { raw: true, type: "array" })
        : XLSX.read(text, { raw: true, type: "string" });
}

function decodeUtf8Text(data: ArrayBuffer | ArrayBufferView): string | undefined {
    const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
    if (isZipOrOleFile(bytes)) return undefined;

    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
        return decoder.decode(bytes);
    } catch {
        return undefined;
    }
}

// .xlsx/.ods are zip archives ("PK\x03\x04"), .xls is an OLE compound file (D0 CF 11 E0).
function isZipOrOleFile(bytes: Uint8Array): boolean {
    const startsWith = (signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
    return startsWith([0x50, 0x4b, 0x03, 0x04]) || startsWith([0xd0, 0xcf, 0x11, 0xe0]);
}
