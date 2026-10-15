/* CSV files for the tests, read and written with papaparse (the library the app uses), so quoted values such as
   product names with commas stay in their column. */
import fs from "fs";
import Papa from "papaparse";

export type Row = Record<string, string>;

export function readCsv(file: string): Row[] {
    return Papa.parse<Row>(fs.readFileSync(file, "utf8"), { header: true, skipEmptyLines: true }).data;
}

export function writeCsv(file: string, columns: string[], rows: Row[]) {
    const data = rows.map(row => columns.map(column => row[column] ?? ""));
    fs.writeFileSync(file, Papa.unparse({ fields: columns, data }, { newline: "\n" }) + "\n", "utf8");
}
