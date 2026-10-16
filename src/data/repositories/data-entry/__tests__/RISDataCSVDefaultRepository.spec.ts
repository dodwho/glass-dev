import { TextDecoder } from "node:util";
import { RISDataCSVDefaultRepository } from "../RISDataCSVDefaultRepository";

// The jsdom environment has no TextDecoder; browsers and Node do.
Object.assign(global, { TextDecoder });

const HEADER =
    "COUNTRY,YEAR,SPECIMEN,PATHOGEN,GENDER,ORIGIN,AGEGROUP,ANTIBIOTIC,RESISTANT,INTERMEDIATE,NONSUSCEPTIBLE,SUSCEPTIBLE,UNKNOWN_NO_AST,UNKNOWN_NO_BREAKPOINTS,BATCHID";

// A Node Buffer goes through the same XLSX.read path as the browser's File.arrayBuffer() (see the
// SpreadsheetXlsxDefaultRepository spec for why a bare ArrayBuffer is not used under jsdom).
function readResults(...lines: string[]) {
    const data = Buffer.from([HEADER, ...lines].join("\n") + "\n", "utf8") as unknown as ArrayBuffer;
    return new RISDataCSVDefaultRepository()
        .getFromArrayBuffer(data)
        .toPromise()
        .then(rows =>
            rows.map(
                ({ RESISTANT, INTERMEDIATE, NONSUSCEPTIBLE, SUSCEPTIBLE, UNKNOWN_NO_AST, UNKNOWN_NO_BREAKPOINTS }) => [
                    RESISTANT,
                    INTERMEDIATE,
                    NONSUSCEPTIBLE,
                    SUSCEPTIBLE,
                    UNKNOWN_NO_AST,
                    UNKNOWN_NO_BREAKPOINTS,
                ]
            )
        );
}

describe("RISDataCSVDefaultRepository", () => {
    it("reads the six AST results as numbers", async () => {
        expect(await readResults('KOR,2025,BLOOD,ESCCOL,M,UNK,15<24,AMP,3,0,3,"1,567",0,0,DS1')).toEqual([
            [3, 0, 3, 1567, 0, 0],
        ]);
    });

    // A blank result is not a 0: the import decides what to store (review decision D1).
    it("reads a blank result cell as null", async () => {
        expect(
            await readResults(
                "KOR,2025,BLOOD,ESCCOL,M,UNK,15<24,AMP,3,,3,10,, ",
                "KOR,2025,BLOOD,ESCCOL,M,UNK,15<24,CIP,,,,,,,DS1"
            )
        ).toEqual([
            [3, null, 3, 10, null, null],
            [null, null, null, null, null, null],
        ]);
    });
});
