/* Synthetic upload files for the test country and year. The code combinations come from e2e/fixtures/seeds
   (codes only, taken from real submissions so they pass the checks); every identifier, age, date and count is
   made up here. A fixed seed makes each file identical on every run, which the golden files rely on. */
import fs from "fs";
import path from "path";
import XlsxPopulate from "@eyeseetea/xlsx-populate";
import JSZip from "jszip";
import _ from "lodash";
import { fileMarker, modules, testYear } from "./config";
import { readCsv, Row, writeCsv } from "./csv";
import { get } from "./dhis2";

const seedsDir = path.join(__dirname, "..", "fixtures", "seeds");
const outputDir = path.join(__dirname, "..", ".fixtures");

const readSeed = (name: string): Row[] => readCsv(path.join(seedsDir, name));

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number) {
    let state = seed;
    const next = () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return { int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)) };
}

const fixturePath = (countryCode: string, name: string, extension: string) =>
    path.join(outputDir, `${fileMarker}_${countryCode}_${testYear}_${name}.${extension}`);

function writeFixture(countryCode: string, name: string, columns: string[], rows: Row[]): string {
    fs.mkdirSync(outputDir, { recursive: true });
    const file = fixturePath(countryCode, name, "csv");
    writeCsv(file, columns, rows);
    return file;
}

const pad = (n: number) => String(n).padStart(2, "0");

function dateInYear(rng: ReturnType<typeof random>, maxDayOfYear = 365): Date {
    return new Date(Date.UTC(Number(testYear), 0, rng.int(1, maxDayOfYear)));
}

const isoDate = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

const individualColumns = {
    common: [
        "COUNTRY",
        "YEAR",
        "HCF_ID",
        "HCF_TYPE",
        "HOSPITALUNITTYPE",
        "PATIENT_ID",
        "AGE",
        "GENDER",
        "PATIENTTYPE",
        "DATEOFHOSPITALISATION_VISIT",
        "PATIENTCOUNTER",
        "LABORATORYCODE",
        "SAMPLE_DATE",
        "ISOLATEID",
        "SPECIMEN",
        "PATHOGEN",
        "ANTIBIOTIC",
        "SIR",
        "REFERENCEGUIDELINESSIR",
        "DISKLOAD",
        "RESULTETESTSIGN",
        "RESULTETESTVALUE",
        "RESULTETESTSIR",
        "RESULTZONEVALUE",
        "RESULTZONESIGN",
        "RESULTZONESIR",
        "RESULTMICSIGN",
        "RESULTMICVALUE",
        "RESULTMICSIR",
    ],
    AMR_INDIVIDUAL: ["AB_CLASS"],
    AMR_FUNGAL: ["AST_METHOD", "IDENT_METHOD", "PERFORMED_TEST"],
};

/**
 * An AMR Individual or Fungal RIS file with at least `minRows` rows: whole isolates (one row per antibiotic)
 * until the count is reached. `blockingRows` rows get another country's code, which the upload must reject.
 */
export function risIndividualFungalFile(
    module: "AMR_INDIVIDUAL" | "AMR_FUNGAL",
    name: string,
    minRows: number,
    blockingRows = 0
): string {
    const seed = readSeed(module === "AMR_INDIVIDUAL" ? "amr-individual-isolates.csv" : "amr-fungal-isolates.csv");
    const isolates = Object.values(_.groupBy(seed, row => row.ISOLATE));
    const rng = random(minRows);
    const rows: Row[] = [];

    for (let i = 0; rows.length < minRows; i++) {
        const isolate = isolates[i % isolates.length] ?? [];
        const sampleDate = dateInYear(rng);
        const visitDate = new Date(
            Math.max(Date.UTC(Number(testYear), 0, 1), sampleDate.getTime() - rng.int(0, 10) * 864e5)
        );
        const patient = {
            COUNTRY: modules[module].country.code,
            YEAR: testYear,
            HCF_ID: `E2E-HCF-${(i % 5) + 1}`,
            PATIENT_ID: `E2E-P${i + 1}`,
            AGE: String(rng.int(0, 95)),
            DATEOFHOSPITALISATION_VISIT: isoDate(visitDate),
            PATIENTCOUNTER: String(i + 1),
            LABORATORYCODE: `E2E-LAB-${(i % 3) + 1}`,
            SAMPLE_DATE: isoDate(sampleDate),
            ISOLATEID: `E2E-I${i + 1}`,
        };
        for (const seedRow of isolate) rows.push({ ...seedRow, ...patient });
    }
    rows.slice(0, blockingRows).forEach(row => (row.COUNTRY = "FRA"));

    const prefix = module === "AMR_INDIVIDUAL" ? "Individual" : "Fungal";
    return writeFixture(
        modules[module].country.code,
        `${prefix}_${name}`,
        [...individualColumns.common, ...individualColumns[module]],
        rows
    );
}

const risColumns = [
    "COUNTRY",
    "YEAR",
    "SPECIMEN",
    "PATHOGEN",
    "GENDER",
    "ORIGIN",
    "AGEGROUP",
    "ANTIBIOTIC",
    "RESISTANT",
    "INTERMEDIATE",
    "NONSUSCEPTIBLE",
    "SUSCEPTIBLE",
    "UNKNOWN_NO_AST",
    "UNKNOWN_NO_BREAKPOINTS",
    "BATCHID",
];
const sampleColumns = [
    "COUNTRY",
    "YEAR",
    "SPECIMEN",
    "GENDER",
    "ORIGIN",
    "AGEGROUP",
    "NUMSAMPLEDPATIENTS",
    "NUMINFECTED",
    "BATCHID",
];

/**
 * AMR aggregate RIS and SAMPLE files for one batch: every seed pathogen/antibiotic pair for every demographic
 * group, with made-up counts. `blockingRows` RIS rows get the wrong year, which the upload must reject.
 */
export function amrAggregateFiles(batchId: string, blockingRows = 0): { ris: string; sample: string } {
    const combinations = readSeed("amr-ris-combinations.csv");
    const groups = readSeed("amr-demographic-groups.csv");
    const rng = random(42);
    const base = { COUNTRY: modules.AMR.country.code, YEAR: testYear, BATCHID: batchId };

    const risRows = combinations.flatMap(combination =>
        groups.map(group => {
            const resistant = rng.int(0, 40);
            const intermediate = rng.int(0, 10);
            return {
                ...base,
                ...combination,
                ...group,
                RESISTANT: String(resistant),
                INTERMEDIATE: String(intermediate),
                NONSUSCEPTIBLE: String(resistant + intermediate),
                SUSCEPTIBLE: String(rng.int(0, 200)),
                UNKNOWN_NO_AST: String(rng.int(0, 5)),
                UNKNOWN_NO_BREAKPOINTS: "0",
            };
        })
    );
    risRows.slice(0, blockingRows).forEach(row => (row.YEAR = String(Number(testYear) - 1)));

    const specimens = [...new Set(combinations.map(combination => combination.SPECIMEN ?? ""))];
    const sampleRows = specimens.flatMap(SPECIMEN =>
        groups.map(group => {
            const sampled = rng.int(500, 5000);
            return {
                ...base,
                SPECIMEN,
                ...group,
                NUMSAMPLEDPATIENTS: String(sampled),
                NUMINFECTED: String(rng.int(10, sampled / 10)),
            };
        })
    );

    const suffix = blockingRows > 0 ? `_${batchId}_with_errors` : `_${batchId}`;
    return {
        ris: writeFixture(base.COUNTRY, `RIS${suffix}`, risColumns, risRows),
        sample: writeFixture(base.COUNTRY, `SAMPLE${suffix}`, sampleColumns, sampleRows),
    };
}

type CellValue = string | number | Date;
type TemplateSheet = { sheet: string; headerMarker: string; rows: Record<string, CellValue>[] };

const cleanHeader = (header: unknown) =>
    String(header ?? "")
        .split("\n")[0]
        ?.replace(" *", "")
        .trim() ?? "";

/**
 * Fills an empty template downloaded from the app and saves it the way Excel saves a filled-in template. Each sheet
 * is found by the start of its name and its header row by the text of its first cell; values are written under the
 * matching header as Excel stores what a user types or picks from a list: numbers as numbers, dates as dates with a
 * date format, list choices as their code.
 */
async function fillTemplate(template: string, file: string, sheets: TemplateSheet[]): Promise<string> {
    const workbook = await XlsxPopulate.fromFileAsync(template);
    // Titles, headers and the drop-down lists are formulas (=_<id>) that name a row of the Metadata sheet
    // (identifier in column A, name or code in column C).
    const metadata = workbook.sheet("Metadata");
    const nameById = new Map<unknown, unknown>((metadata?.usedRange()?.value() ?? []).map(row => [row[0], row[2]]));
    const formulaText = (cell: XlsxPopulate.Cell) => nameById.get(String(cell.formula() ?? "").replace(/^=?_/, ""));

    for (const { sheet: sheetName, headerMarker, rows } of sheets) {
        const sheet = workbook.sheets().find(s => s.name().startsWith(sheetName));
        if (!sheet) throw new Error(`No sheet "${sheetName}" in the template`);
        const lastColumn = sheet.usedRange()?.endCell().columnNumber() ?? 0;
        const headerRow = [...Array(20).keys()].map(i => i + 1).find(r => sheet.cell(r, 1).value() === headerMarker);
        if (!headerRow) throw new Error(`No "${headerMarker}" header in sheet "${sheetName}"`);
        const columns = new Map<string, number>();
        for (let column = 1; column <= lastColumn; column++) {
            const cell = sheet.cell(headerRow, column);
            columns.set(cleanHeader(cell.value() ?? formulaText(cell)), column);
        }

        rows.forEach((row, index) => {
            for (const [header, value] of Object.entries(row).filter(([, value]) => value !== "")) {
                const column = columns.get(header);
                if (!column) throw new Error(`No column "${header}" in sheet "${sheetName}"`);
                const cell = sheet.cell(headerRow + 1 + index, column);
                if (value instanceof Date)
                    cell.value(XlsxPopulate.dateToNumber(value)).style("numberFormat", "yyyy-mm-dd");
                else cell.value(typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value);
            }
        });
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const saved = await saveFormulaResults((await workbook.outputAsync()) as Buffer, nameById);
    fs.writeFileSync(file, saved);
    return file;
}

/**
 * Adds to every =_<id> formula the result Excel saves with it (xlsx-populate keeps formulas but writes no result).
 * The app reads both: the formula to know which data element or option a cell is, the result as its text.
 */
async function saveFormulaResults(xlsx: Buffer, nameById: Map<unknown, unknown>): Promise<Buffer> {
    const zip = await JSZip.loadAsync(xlsx);
    const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    for (const sheetFile of Object.keys(zip.files).filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))) {
        const xml = await zip.file(sheetFile)?.async("string");
        if (!xml) continue;
        const withResults = xml.replace(
            /<c ([^>]*)><f([^>]*)>_([A-Za-z0-9]+)<\/f><\/c>/g,
            (cell, attributes: string, formulaAttributes: string, id: string) => {
                const result = nameById.get(id);
                if (typeof result === "number")
                    return `<c ${attributes}><f${formulaAttributes}>_${id}</f><v>${result}</v></c>`;
                if (typeof result !== "string") return cell;
                return `<c ${attributes} t="str"><f${formulaAttributes}>_${id}</f><v>${escapeXml(result)}</v></c>`;
            }
        );
        zip.file(sheetFile, withResults);
    }
    return zip.generateAsync({ type: "nodebuffer" });
}

/** A local-time date in the test year, as the browser (same time zone) will read it back. */
const localDate = (dayOfYear: number) => new Date(Number(testYear), 0, dayOfYear);

/** AMC substance-level data: the seed substances with made-up DDD totals, all dated 1 January. */
export function amcSubstanceFile(template: string): Promise<string> {
    const rng = random(7);
    const rows = readSeed("amc-substances.csv").map(substance => ({
        "Org Unit": modules.AMC.country.code,
        Date: localDate(1),
        ...substance,
        ddds_manual: rng.int(1000, 5_000_000),
    }));
    return fillTemplate(template, fixturePath(modules.AMC.country.code, "Substance_Level_Data", "xlsx"), [
        { sheet: "Data Entry", headerMarker: "Event id", rows },
    ]);
}

/** AMC product-level data: the seed products under made-up ids, with made-up package counts. */
export function amcProductFile(template: string): Promise<string> {
    const rng = random(11);
    const seed = readSeed("amc-products.csv");
    const consumptionColumns = ["health_sector_manual", "health_level_manual", "data_status_manual"];
    const productId = (i: number) => `E2E-PRODUCT-${i + 1}`;
    const products = seed.map((product, i) => ({
        "TEI id": productId(i),
        "Org Unit": modules.AMC.country.code,
        "Enrollment Date": localDate(1),
        "Incident Date": localDate(1),
        "Product id": productId(i),
        "Product name": `E2E product ${i + 1}`,
        ..._.omit(product, consumptionColumns),
    }));
    const consumption = seed.map((product, i) => ({
        "TEI Id": productId(i),
        Date: localDate(1),
        ..._.pick(product, consumptionColumns),
        packages_manual: rng.int(10, 50_000),
    }));
    return fillTemplate(template, fixturePath(modules.AMC.country.code, "Product_Level_Data", "xlsx"), [
        { sheet: "TEI Instances", headerMarker: "TEI id", rows: products },
        { sheet: "(1)", headerMarker: "Event id", rows: consumption },
    ]);
}

// The org unit groups the app uses to find EGASP clinics and labs (MetadataDefaultRepository).
const egaspGroups = { clinics: "lohCVAxPxMM", labs: "KhLlLrKWPKu" };

/** The first EGASP clinic or lab (by code) under the test country. */
async function firstSite(group: string): Promise<string> {
    const { id: country, code } = modules.EGASP.country;
    const { organisationUnits } = await get<{ organisationUnits: { code: string }[] }>(
        `organisationUnits?filter=path:like:${country}&filter=organisationUnitGroups.id:eq:${group}&fields=code&paging=false`
    );
    const [site] = organisationUnits.map(ou => ou.code).sort();
    if (!site) throw new Error(`No EGASP clinic or lab in group ${group} under ${code}`);
    return site;
}

/**
 * EGASP: the seed answers with made-up identifiers, ages and visit dates (other dates keep their seed offsets),
 * reported by one clinic and tested by one lab of the test country.
 */
export async function egaspFile(template: string): Promise<string> {
    const { code: countryCode } = modules.EGASP.country;
    const clinic = await firstSite(egaspGroups.clinics);
    const lab = await firstSite(egaspGroups.labs);
    const rng = random(13);
    const rows = readSeed("egasp-rows.csv").map((seedRow, i) => {
        const visitDay = rng.int(1, 300);
        const row: Record<string, CellValue> = {};
        for (const [column, value] of Object.entries(seedRow)) {
            if (value === "") continue;
            row[column] = column.startsWith("date_") ? localDate(visitDay + Number(value)) : value;
        }
        return {
            ...row,
            "Org Unit": clinic,
            "EGASP date": localDate(visitDay),
            lab_id: lab,
            pt_id: `E2E-PT-${i + 1}`,
            egasp_id: `E2E-EGASP-${i + 1}`,
            age: rng.int(18, 65),
        };
    });
    return fillTemplate(template, fixturePath(countryCode, "EGASP", "xlsx"), [
        { sheet: "Data Entry", headerMarker: "Event id", rows },
    ]);
}
