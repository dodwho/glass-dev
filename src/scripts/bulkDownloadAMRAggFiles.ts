/*
================================================================
AMR (aggregate) RIS + SAMPLE bulk export — re-uploadable CSV
================================================================
Exports the AMR module's AGGREGATE datasets (the RIS and SAMPLE data-entry files), for every country
and every year, into ONE CSV per file type, in the exact column contract the upload path parses.

This is NOT the AMR - Individual / AMR - Fungal tracker line-list (see bulkDownloadAMRIndividualFiles.ts)
and shares no concepts with the AMC/AMU consumption exports.

Round-trip contract (verified against the live import code, cited below) — this script is the exact
inverse of ImportRISFile.ts / ImportSampleFile.ts:

  - One file row becomes N data values, one per dataset data element, all sharing the same
    (orgUnit, period, attributeOptionCombo, categoryOptionCombo). Exporting therefore means REGROUPING
    data values back by that 4-tuple: one output row per distinct (AOC, COC) within a country/year.
      ImportRISFile.ts:74-107, ImportSampleFile.ts:63-96
  - COUNTRY is the org unit CODE, not its uid (import resolves it via getOrgUnitsByCode).
  - YEAR is the period.
  - The dataset category combination supplies PATHOGEN/ANTIBIOTIC/BATCHID (RIS) or BATCHID (SAMPLE) —
    import reads them as `risData[category.code]`, so the category CODES are the file column names,
    except BATCHIDDS whose file column is "BATCHID" (RISDataCSVDefaultRepository.ts:48).
  - The data element category combination (AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID) supplies
    SPECIMEN/GENDER/ORIGIN/AGEGROUP.
  - Import maps the file's "UNK" to the metadata option codes UNKG/UNKO/UNKA per category
    (getCategoryOptionCombo.tsx:20-22). This export applies the exact inverse; getting it wrong would
    silently produce files that fail to re-import.
  - Data elements whose own category combo is the DEFAULT one are not disaggregated by
    SPECIMEN/GENDER/ORIGIN/AGEGROUP (getCategoryOptionCombo.tsx:16-17): they hold ONE value per
    (orgUnit, period, AOC). They are broadcast to every row of that AOC on export, which is the
    faithful inverse of an import in which every file row wrote to the same target.
  - Every OTHER data element is resolved against the SPECIMEN/GENDER/ORIGIN/AGEGROUP combination, even
    where its own combo differs (the RIS data set's ABCLASS is one such element). That is what the
    import does, so it is what the inverse must do; anything stored under the element's own combo
    instead is reported as unknownCategoryOptionCombos rather than guessed at.

Architecture:
  1. Resolve metadata once per file type: dataset data elements (id -> file column), and both category
     combinations flattened to "categoryOptionCombo id -> the file cells it fills". Every lookup in the
     hot loop is then a single Map hit.
  2. Per (country, year) unit, stream /api/dataValueSets.csv and regroup it into rows in memory. The
     response is parsed incrementally (papaparse over the HTTP stream), so the raw payload is never
     materialised; peak memory is one unit's OUTPUT rows, which is irreducible — that grouping is the
     whole job.
  3. Write the finished unit into the shared per-file-type CSV under a write lock, so concurrent
     fetches never interleave rows and each country/year lands contiguously.

A unit is only written once it has been parsed in full, so a failed unit is retried whole with no risk
of duplicated or half-written rows.
*/

import { D2Api } from "@eyeseetea/d2-api/2.34";
import dotenv from "dotenv";
import _ from "lodash";
import Papa from "papaparse";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { DataStoreClient } from "../data/data-store/DataStoreClient";
import { GlassModuleDefaultRepository } from "../data/repositories/GlassModuleDefaultRepository";
import {
    AMR_GLASS_PROE_UPLOADS_PROGRAM_ID,
    getValueById,
    uploadsDHIS2Ids,
} from "../data/repositories/GlassUploadsProgramRepository";
import { MODULE_NAMES } from "../domain/entities/GlassModule";
import { GlassUploadsStatus } from "../domain/entities/GlassUploads";
import {
    AMR_AMR_DS_INPUT_FILES_RIS_DS_ID,
    AMR_AMR_DS_Input_files_Sample_DS_ID,
    AMR_BATCHID_CC_ID,
    AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID,
} from "../domain/usecases/data-entry/amr/amrAggMetadataIds";
import {
    AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID,
    defaultCategoryCombo,
} from "../domain/usecases/data-entry/utils/getCategoryOptionCombo";
import { getD2APiFromInstance } from "../utils/d2-api";
import { setupConsoleLogger } from "../utils/logger";
import { isRetryableError, promiseMapConcurrent, retryAsync } from "../utils/promises";
import { getEnvVars, getInstance, warmUpSession } from "./common";
import { CsvStreamWriter, escapeCsvField } from "./utils/csvStreamWriter";

// .env.local first, then .env — dotenv never overrides an already-set key, so this gives .env.local
// precedence, matching Create React App (which is where this repo's credentials live).
//
// This ONLY holds if nothing loaded .env first. The npm script therefore deliberately omits the
// `-r dotenv/config` preload the other bulk scripts use: that preload reads .env before this module
// runs, so .env would win for every key present in both files — and both files define
// REACT_APP_DHIS2_BASE_URL with different instances. Run this script via `npm run
// bulk-download-amr-agg-files`, and check the "DHIS2 instance:" line it logs before letting it work.
dotenv.config({ path: ".env.local" });
dotenv.config();

/*
================================================================
CONFIG — edit before each run
================================================================
*/

type FileTypeName = "RIS" | "SAMPLE";

// Which aggregate file types to export. Each produces its own single CSV covering every exported
// country and year; they are never combined into one file.
const FILE_TYPES: FileTypeName[] = ["RIS", "SAMPLE"];

// DHIS2 org unit codes (ISO/M49 country codes) to include. Leave EMPTY for every country.
const ORG_UNIT_CODES: string[] = [];

// Years to export. Leave EMPTY to auto-detect: the contiguous range spanned by the AMR module's
// upload records (see PRUNE_BY_COVERAGE for why the range, not just the observed years, is used).
const YEARS: string[] = [];

// Coverage (the AMR uploads event program) is PLANNING input, never a data-loss gate.
//
// false (default): every country/year is queried. ~200 countries x ~10 years of cheap, mostly-empty
// dataValueSets requests, and the export is then provably complete — including data that predates the
// uploads program or was loaded outside it. Prefer this for an authoritative extract.
//
// true: country/years with no upload record are skipped without being queried. Much faster, but any
// data not represented by an upload record is silently absent from the output.
const PRUNE_BY_COVERAGE = false;

// Max concurrent (country, year) fetches. Writes are serialised regardless (see withWriteLock), so
// this only parallelises network + parsing. Peak memory is roughly this many units' output rows.
const FETCH_CONCURRENCY = 6;

// Rows handed to the CSV writer per stream write. Bounds the transient string built per write while
// keeping the per-row cost invisible at millions of rows.
const WRITE_BATCH_SIZE = 5000;

// Plan the run (metadata resolution, column contract, coverage, planned unit list, manifest) and exit
// WITHOUT fetching any data value or writing any data CSV. Use this to review scope and the resolved
// header first.
const DRY_RUN = false;

// Prepend a UTF-8 BOM to the CSVs (Excel-friendliness). Off by default; harmless either way on re-import.
const WRITE_BOM = false;

// Statuses that mean an upload's data actually reached the datasets (coverage evidence only).
const COVERAGE_STATUSES: GlassUploadsStatus[] = ["IMPORTED", "VALIDATED", "COMPLETED"];

/*
================================================================
File type contracts — mirrors of the upload parsers
================================================================
*/

interface FileTypeSpec {
    fileType: FileTypeName;
    dataSetId: string;
    /** Dataset category combination: supplies the attributeOptionCombo dimensions. */
    dataSetCategoryComboId: string;
    /** Canonical upload column order. Emitted in full even if a column has no data source. */
    columns: string[];
    /** Columns the upload validator refuses the file without — a missing source here is fatal. */
    requiredColumns: string[];
}

// Column order and names are taken verbatim from the upload parsers, which are the only definition of
// the file format: RISDataCSVDefaultRepository.mapSheetRowsToRISData/validate and
// SampleDataCSVDeafultRepository.mapSheetRowsToSampleData/validate.
const FILE_TYPE_SPECS: Record<FileTypeName, FileTypeSpec> = {
    RIS: {
        fileType: "RIS",
        dataSetId: AMR_AMR_DS_INPUT_FILES_RIS_DS_ID,
        dataSetCategoryComboId: AMR_DATA_PATHOGEN_ANTIBIOTIC_BATCHID_CC_ID,
        columns: [
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
        ],
        requiredColumns: [
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
        ],
    },
    SAMPLE: {
        fileType: "SAMPLE",
        dataSetId: AMR_AMR_DS_Input_files_Sample_DS_ID,
        dataSetCategoryComboId: AMR_BATCHID_CC_ID,
        // NUMINFECTED is parsed by the upload but not required by its validator, so it is emitted when
        // the dataset defines it and left as an empty column otherwise.
        columns: [
            "COUNTRY",
            "YEAR",
            "SPECIMEN",
            "GENDER",
            "ORIGIN",
            "AGEGROUP",
            "NUMINFECTED",
            "NUMSAMPLEDPATIENTS",
            "BATCHID",
        ],
        requiredColumns: [
            "COUNTRY",
            "YEAR",
            "SPECIMEN",
            "GENDER",
            "ORIGIN",
            "AGEGROUP",
            "NUMSAMPLEDPATIENTS",
            "BATCHID",
        ],
    },
};

const COUNTRY_COLUMN = "COUNTRY";
const YEAR_COLUMN = "YEAR";

// Category code -> file column. Import reads dataset categories as `externalData[category.code]`
// (ImportRISFile.ts:77-79), so codes ARE column names — except BATCHIDDS, whose file column is BATCHID
// (RISDataCSVDefaultRepository.ts:48). An unmapped category code is a metadata change this export must
// not guess at, and is reported as fatal.
const CATEGORY_CODE_TO_COLUMN: Record<string, string> = {
    SPECIMEN: "SPECIMEN",
    GENDER: "GENDER",
    ORIGIN: "ORIGIN",
    AGEGROUP: "AGEGROUP",
    PATHOGEN: "PATHOGEN",
    ANTIBIOTIC: "ANTIBIOTIC",
    BATCHIDDS: "BATCHID",
};

// Exact inverse of getCategoryOptionComboByDataElement's "UNK" -> "UNKG"/"UNKO"/"UNKA" mapping. The
// forward mapping makes those option codes unreachable from any other file value, so the inverse is
// unambiguous.
const UNKNOWN_OPTION_CODE_BY_COLUMN: Record<string, string> = {
    GENDER: "UNKG",
    ORIGIN: "UNKO",
    AGEGROUP: "UNKA",
};

function toFileValue(column: string, optionCode: string): string {
    return UNKNOWN_OPTION_CODE_BY_COLUMN[column] === optionCode ? "UNK" : optionCode;
}

/*
================================================================
Logging — console capture mirrors the other bulk scripts
================================================================
*/

enum LogLevel {
    INFO = "info",
    WARN = "warn",
    ERROR = "error",
}

let logFilePath = "";
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

function serializeLogArg(arg: unknown): string {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack ?? String(arg);
    try {
        return JSON.stringify(arg, (_key, value) => (value instanceof Error ? value.stack ?? String(value) : value));
    } catch {
        return String(arg);
    }
}

function appendConsoleToLogFile(args: unknown[]): void {
    if (!logFilePath) return;
    try {
        appendFileSync(logFilePath, args.map(serializeLogArg).join(" ") + "\n");
    } catch {
        // ignore logfile write failures
    }
}

function installConsoleCapture(): void {
    const wrap =
        (original: (...args: unknown[]) => void) =>
        (...args: unknown[]) => {
            const stamped = [`[${new Date().toLocaleString()}]`, ...args];
            original(...stamped);
            appendConsoleToLogFile(stamped);
        };
    console.log = wrap(originalLog);
    console.error = wrap(originalError);
    console.warn = wrap(originalWarn);
    console.info = wrap(originalInfo);
}

function log(message: string, level: LogLevel = LogLevel.INFO): void {
    if (level === LogLevel.ERROR) console.error(`[ERROR] ${message}`);
    else if (level === LogLevel.WARN) console.warn(`[WARN] ${message}`);
    else console.log(`[INFO] ${message}`);
}

/*
================================================================
Environment / auth
================================================================
*/

interface EnvVars {
    url: string;
    token?: string;
    auth?: { username: string; password: string };
}

// The data fetch bypasses d2-api (which buffers whole responses) and calls dataValueSets.csv directly
// so the payload can be parsed as it arrives. Each request carries its own credentials, so unlike the
// cookie-session scripts there is no session to keep warm mid-run.
function getAuthHeader(env: EnvVars): string {
    if (env.token) return `ApiToken ${env.token}`;
    return `Basic ${Buffer.from(`${env.auth?.username}:${env.auth?.password}`).toString("base64")}`;
}

// "https://host/path" -> "host-path", for output naming. Algorithmic, so a new instance never needs a
// hostname table.
function deriveEnvLabel(rawUrl: string): string {
    try {
        const url = new URL(rawUrl);
        const hostPrefix = url.hostname.split(".")[0] ?? "";
        const pathTail = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
        return (
            [hostPrefix, pathTail]
                .filter(Boolean)
                .join("-")
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, "-")
                .replace(/-+/g, "-")
                .replace(/^-|-$/g, "") || "unknown-env"
        );
    } catch {
        return "unknown-env";
    }
}

let api!: D2Api;
let baseUrl = "";
let authHeader = "";

/*
================================================================
Metadata resolution — the export's column contract
================================================================
*/

/** A single output cell: the column index to fill and the file value to put there. */
type Cell = readonly [index: number, value: string];

interface ResolvedSpec {
    spec: FileTypeSpec;
    dataSetName: string;
    header: string[];
    /** attributeOptionCombo id -> PATHOGEN/ANTIBIOTIC/BATCHID cells. */
    aocCells: Map<string, Cell[]>;
    /** categoryOptionCombo id -> SPECIMEN/GENDER/ORIGIN/AGEGROUP cells. */
    cocCells: Map<string, Cell[]>;
    /** Data elements disaggregated by SPECIMEN/GENDER/ORIGIN/AGEGROUP: one value per output row. */
    dimensionedDataElements: Map<string, number>;
    /** Data elements with the DEFAULT category combo: one value per AOC, broadcast to its rows. */
    aocLevelDataElements: Map<string, number>;
    countryIndex: number;
    yearIndex: number;
}

const categoryComboFields = {
    id: true,
    name: true,
    categories: { id: true, code: true, categoryOptions: { id: true } },
    categoryOptionCombos: { id: true, categoryOptions: { id: true, code: true } },
} as const;

interface FlatCategoryCombo {
    id: string;
    name: string;
    /** File columns this combination contributes, in metadata category order. */
    columns: string[];
    /** categoryOptionCombo id -> [column, file value] pairs. */
    optionsByCombo: Map<string, { column: string; value: string }[]>;
}

// The dimension combination is shared by every file type, and both combinations are large enough that
// re-fetching them per file type is a pointless round trip.
const categoryCombosById = new Map<string, Promise<FlatCategoryCombo>>();

function fetchCategoryCombo(categoryComboId: string): Promise<FlatCategoryCombo> {
    const cached = categoryCombosById.get(categoryComboId);
    if (cached) return cached;
    const pending = fetchCategoryComboUncached(categoryComboId);
    categoryCombosById.set(categoryComboId, pending);
    return pending;
}

async function fetchCategoryComboUncached(categoryComboId: string): Promise<FlatCategoryCombo> {
    const response = await api.models.categoryCombos
        .get({ fields: categoryComboFields, filter: { id: { eq: categoryComboId } } })
        .getData();

    const combo = response.objects[0];
    if (!combo) throw new Error(`Category combination ${categoryComboId} not found on this DHIS2 instance.`);

    const unmappedCategories = combo.categories.filter(category => !CATEGORY_CODE_TO_COLUMN[category.code]);
    if (unmappedCategories.length > 0) {
        throw new Error(
            `Category combination "${combo.name}" (${combo.id}) contains categories with no known file column: ` +
                `${unmappedCategories.map(c => `${c.code || "(no code)"} (${c.id})`).join(", ")}. ` +
                `The upload parsers define the file columns; refusing to guess a mapping.`
        );
    }

    const columnByOptionId = new Map<string, string>();
    for (const category of combo.categories) {
        const column = CATEGORY_CODE_TO_COLUMN[category.code] as string;
        for (const option of category.categoryOptions) columnByOptionId.set(option.id, column);
    }

    const optionsByCombo = new Map<string, { column: string; value: string }[]>();
    for (const categoryOptionCombo of combo.categoryOptionCombos) {
        const cells = categoryOptionCombo.categoryOptions.map(option => {
            const column = columnByOptionId.get(option.id);
            if (!column) {
                throw new Error(
                    `Category option ${option.id} of combination "${combo.name}" belongs to no category of that ` +
                        `combination — the metadata is inconsistent and the export cannot be trusted.`
                );
            }
            // The import matches file values against option CODES, so an option without one could
            // never have been imported and cannot be exported into a re-uploadable file either.
            const optionCode = (option.code ?? "").trim();
            if (!optionCode) {
                throw new Error(
                    `Category option ${option.id} (column ${column}) of combination "${combo.name}" has no code, so ` +
                        `no file value can represent it.`
                );
            }
            return { column, value: toFileValue(column, optionCode) };
        });
        optionsByCombo.set(categoryOptionCombo.id, cells);
    }

    return {
        id: combo.id,
        name: combo.name,
        columns: combo.categories.map(category => CATEGORY_CODE_TO_COLUMN[category.code] as string),
        optionsByCombo,
    };
}

const dataSetFields = {
    id: true,
    name: true,
    dataSetElements: { dataElement: { id: true, code: true, categoryCombo: { id: true } } },
} as const;

async function fetchDataSet(dataSetId: string) {
    const response = await api.models.dataSets
        .get({ fields: dataSetFields, filter: { id: { eq: dataSetId } } })
        .getData();

    const dataSet = response.objects[0];
    if (!dataSet) throw new Error(`Data set ${dataSetId} not found on this DHIS2 instance.`);
    return dataSet;
}

async function resolveSpec(spec: FileTypeSpec): Promise<ResolvedSpec> {
    const [dataSet, dataSetCombo, dimensionCombo] = await Promise.all([
        fetchDataSet(spec.dataSetId),
        fetchCategoryCombo(spec.dataSetCategoryComboId),
        fetchCategoryCombo(AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID),
    ]);

    const dataElements = dataSet.dataSetElements.map(({ dataElement }) => dataElement);
    const uncoded = dataElements.filter(dataElement => !dataElement.code);
    if (uncoded.length > 0) {
        throw new Error(
            `Data set "${dataSet.name}" has data element(s) with no code (${uncoded
                .map(d => d.id)
                .join(", ")}). The import addresses data elements by code, so an uncoded one cannot be exported.`
        );
    }

    // Every column the metadata can actually fill, in a stable order.
    const producedColumns = [
        COUNTRY_COLUMN,
        YEAR_COLUMN,
        ...dimensionCombo.columns,
        ...dataSetCombo.columns,
        ...dataElements.map(dataElement => dataElement.code),
    ];
    const duplicated = Object.entries(_.countBy(producedColumns))
        .filter(([, count]) => count > 1)
        .map(([column]) => column);
    if (duplicated.length > 0) {
        throw new Error(
            `Two metadata sources map to the same file column(s) for ${spec.fileType}: ${duplicated.join(", ")}. ` +
                `The export cannot decide which one owns the column.`
        );
    }

    // The canonical upload columns always appear, in their canonical order, so the output is the file
    // format even where the instance has nothing to put in a column. Anything the metadata produces
    // that the upload does not parse is appended rather than dropped, so metadata drift is visible.
    const extraColumns = producedColumns.filter(column => !spec.columns.includes(column));
    const unsourcedColumns = spec.columns.filter(column => !producedColumns.includes(column));
    const unsourcedRequired = unsourcedColumns.filter(column => spec.requiredColumns.includes(column));
    if (unsourcedRequired.length > 0) {
        throw new Error(
            `${spec.fileType}: required upload column(s) ${unsourcedRequired.join(", ")} have no source in data set ` +
                `"${dataSet.name}" or its category combinations — an export would not be re-uploadable.`
        );
    }
    if (unsourcedColumns.length > 0) {
        log(
            `${spec.fileType}: optional upload column(s) ${unsourcedColumns.join(", ")} have no source in the ` +
                `metadata and will be emitted empty.`,
            LogLevel.WARN
        );
    }
    if (extraColumns.length > 0) {
        log(
            `${spec.fileType}: the metadata defines ${extraColumns.join(", ")}, which the upload parser does not ` +
                `read. Appended after the canonical columns rather than dropped.`,
            LogLevel.WARN
        );
    }

    const header = [...spec.columns, ...extraColumns];
    const columnIndex = new Map(header.map((column, index) => [column, index] as const));
    const toCells = (cells: { column: string; value: string }[]): Cell[] =>
        cells.map(cell => [columnIndex.get(cell.column) as number, cell.value] as const);

    // Mirrors getCategoryOptionComboByDataElement exactly, which is the only rule that decides where a
    // value went on the way in: the DEFAULT category combo means "no disaggregation", and EVERY other
    // combo is looked up against the SPECIMEN/GENDER/ORIGIN/AGEGROUP combination — even when the data
    // element's own combo is a different one. Classifying by the data element's own combo instead would
    // put this export out of step with the import it has to invert.
    const dimensionedDataElements = new Map<string, number>();
    const aocLevelDataElements = new Map<string, number>();
    const foreignComboDataElements: string[] = [];
    for (const dataElement of dataElements) {
        const index = columnIndex.get(dataElement.code) as number;
        if (dataElement.categoryCombo.id === defaultCategoryCombo) {
            aocLevelDataElements.set(dataElement.id, index);
            continue;
        }
        dimensionedDataElements.set(dataElement.id, index);
        if (dataElement.categoryCombo.id !== AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID) {
            foreignComboDataElements.push(`${dataElement.code} (own combo ${dataElement.categoryCombo.id})`);
        }
    }
    if (aocLevelDataElements.size > 0) {
        const codes = dataElements.filter(de => aocLevelDataElements.has(de.id)).map(de => de.code);
        log(
            `${spec.fileType}: data element(s) ${codes.join(", ")} use the default category combination, so DHIS2 ` +
                `holds one value per batch rather than one per file row. That single value is repeated on every row ` +
                `of its batch — the faithful inverse of an import in which every file row overwrote the same target.`,
            LogLevel.WARN
        );
    }
    if (foreignComboDataElements.length > 0) {
        const onInstanceDefault = instanceDefault.categoryComboId
            ? foreignComboDataElements.filter(entry => entry.includes(instanceDefault.categoryComboId as string))
            : [];
        log(
            `${spec.fileType}: data element(s) ${foreignComboDataElements.join(", ")} declare a category combination ` +
                `other than ${AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID}, yet the import writes them with a category ` +
                `option combo taken from that combination, so this export reads them back the same way.` +
                (onInstanceDefault.length > 0
                    ? ` Note that ${onInstanceDefault.length} of these sit on this instance's REAL default ` +
                      `combination (${instanceDefault.categoryComboId}), which the import does not recognise as ` +
                      `default because it hardcodes ${defaultCategoryCombo} — so it disaggregates them anyway. ` +
                      `Mirroring that is what keeps the round trip intact.`
                    : ""),
            LogLevel.WARN
        );
    }

    return {
        spec,
        dataSetName: dataSet.name,
        header,
        aocCells: new Map([...dataSetCombo.optionsByCombo].map(([id, cells]) => [id, toCells(cells)])),
        cocCells: new Map([...dimensionCombo.optionsByCombo].map(([id, cells]) => [id, toCells(cells)])),
        dimensionedDataElements,
        aocLevelDataElements,
        countryIndex: columnIndex.get(COUNTRY_COLUMN) as number,
        yearIndex: columnIndex.get(YEAR_COLUMN) as number,
    };
}

/*
================================================================
Org units and coverage
================================================================
*/

/** Kosovo is not a level-3 org unit on every instance, so the AMC/AMR scripts add it by uid. */
const KOSOVO_ORG_UNIT = { id: "I8AMbKhxlj9", code: "601624" };

async function fetchCountries(): Promise<{ code: string; id: string }[]> {
    const response = await api.models.organisationUnits
        .get({ fields: { id: true, code: true }, filter: { level: { eq: "3" } }, paging: false })
        .getData();

    const countries = response.objects.filter((ou): ou is { id: string; code: string } => Boolean(ou.code));

    // The sibling scripts append Kosovo unconditionally. Doing that blindly is why an instance without
    // it produced one "failed" unit per year per file type: DHIS2 answers dataValueSets for an unknown
    // org unit with a bare HTTP 500, which is indistinguishable from a real server fault and wrongly
    // marks the whole export INCOMPLETE. Confirm it exists first, and say so plainly when it does not.
    if (countries.some(country => country.id === KOSOVO_ORG_UNIT.id)) return countries;

    const kosovo = await api.models.organisationUnits
        .get({ fields: { id: true, code: true }, filter: { id: { eq: KOSOVO_ORG_UNIT.id } } })
        .getData();

    const found = kosovo.objects[0];
    if (!found) {
        log(
            `Kosovo (${KOSOVO_ORG_UNIT.id} / code ${KOSOVO_ORG_UNIT.code}) does not exist on this instance, so it is ` +
                `not exported. No data is missing because of this — there is nothing there to export.`
        );
        return countries;
    }
    return [...countries, { id: found.id, code: found.code || KOSOVO_ORG_UNIT.code }];
}

const COVERAGE_PAGE_SIZE = 500;

/** `${orgUnitId}|${year}|${fileType}` keys of country/years with an upload record that reached the datasets. */
async function fetchCoverage(moduleId: string): Promise<{ keys: Set<string>; years: Set<string> } | null> {
    const keys = new Set<string>();
    const years = new Set<string>();
    const coverageStatuses = new Set<string>(COVERAGE_STATUSES);

    try {
        let page = 1;
        let result;
        do {
            result = await api.tracker.events
                .get({
                    fields: { event: true, orgUnit: true, dataValues: { dataElement: true, value: true } },
                    program: AMR_GLASS_PROE_UPLOADS_PROGRAM_ID,
                    filter: `${uploadsDHIS2Ids.moduleId}:eq:${moduleId}`,
                    totalPages: true,
                    page,
                    pageSize: COVERAGE_PAGE_SIZE,
                })
                .getData();

            for (const event of result.instances) {
                const status = getValueById(event.dataValues, uploadsDHIS2Ids.status) ?? "";
                if (!coverageStatuses.has(status) || !event.orgUnit) continue;

                const year = (getValueById(event.dataValues, uploadsDHIS2Ids.period) ?? "").match(/\d{4}/)?.[0];
                if (!year) continue;

                const fileType = getValueById(event.dataValues, uploadsDHIS2Ids.documentFileType) ?? "";
                years.add(year);
                keys.add(`${event.orgUnit}|${year}|${fileType}`);
            }
            page++;
        } while (result.page < Math.ceil((result.total as number) / COVERAGE_PAGE_SIZE));

        return { keys, years };
    } catch (error) {
        log(`Coverage lookup failed (${error instanceof Error ? error.message : String(error)}).`, LogLevel.WARN);
        return null;
    }
}

/*
================================================================
Data value fetching — streamed dataValueSets CSV
================================================================
*/

// DHIS2 lower-cases its dataValueSets CSV headers, but the export depends on these four columns, so a
// change is caught explicitly instead of silently producing empty rows.
const DHIS2_CSV_COLUMNS = ["dataelement", "period", "categoryoptioncombo", "attributeoptioncombo", "value"] as const;

type Dhis2DataValueRecord = Partial<Record<typeof DHIS2_CSV_COLUMNS[number], string>>;

/**
 * Adapts a fetch response body to a Node stream for papaparse, backpressure intact.
 *
 * Which shape arrives depends on where `fetch` comes from, and this repo currently gets BOTH cases
 * wrong if you assume one: on Node 16 there is no global fetch, and d2-api installs
 * `cross-fetch/polyfill` (node-fetch) as a side effect of being imported — its body is already a Node
 * Readable. Node 18+ would instead supply undici, whose body is a web ReadableStream with `getReader`.
 * Both are handled so a Node upgrade does not silently break this script (and so it does not depend on
 * d2-api's polyfill happening to have been loaded first in some other runtime).
 *
 * The web-stream branch is written against the reader protocol rather than `Readable.fromWeb`, which
 * this project's @types/node does not declare, and pulls one chunk per `read()` so the response is
 * consumed at the speed it is parsed.
 */
function toNodeStream(body: unknown): Readable {
    const candidate = body as {
        pipe?: unknown;
        getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }> };
    };

    if (typeof candidate.pipe === "function") return body as Readable;

    if (typeof candidate.getReader !== "function") {
        throw new Error(
            "The fetch response body is neither a Node stream nor a web ReadableStream, so the dataValueSets " +
                "response cannot be streamed. Check which fetch implementation is in use."
        );
    }

    const reader = candidate.getReader();
    return new Readable({
        read() {
            reader.read().then(
                ({ done, value }) => this.push(done || !value ? null : Buffer.from(value)),
                error => this.destroy(error instanceof Error ? error : new Error(String(error)))
            );
        },
    });
}

class HttpError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
        this.name = "HttpError";
    }
}

async function streamDataValues(
    dataSetId: string,
    orgUnitId: string,
    year: string,
    onRecord: (record: Dhis2DataValueRecord) => void
): Promise<void> {
    const url = `${baseUrl.replace(
        /\/+$/,
        ""
    )}/api/dataValueSets.csv?dataSet=${dataSetId}&orgUnit=${orgUnitId}&period=${year}`;
    const response = await fetch(url, { headers: { Authorization: authHeader } });

    if (!response.ok || !response.body) {
        const detail = response.ok ? "response had no body" : (await response.text().catch(() => "")).slice(0, 500);
        throw new HttpError(response.status, `dataValueSets ${response.status} ${response.statusText} — ${detail}`);
    }
    const body = response.body;

    await new Promise<void>((resolve, reject) => {
        const stream = toNodeStream(body);
        let headersChecked = false;
        Papa.parse<Dhis2DataValueRecord>(stream, {
            header: true,
            skipEmptyLines: true,
            transformHeader: header => header.trim().toLowerCase(),
            chunk: (results, parser) => {
                try {
                    if (!headersChecked) {
                        const fields = results.meta.fields ?? [];
                        const missing = DHIS2_CSV_COLUMNS.filter(column => !fields.includes(column));
                        if (missing.length > 0) {
                            throw new Error(
                                `dataValueSets CSV is missing expected column(s) ${missing.join(", ")} ` +
                                    `(got: ${fields.join(", ") || "none"}).`
                            );
                        }
                        headersChecked = true;
                    }
                    for (const record of results.data) onRecord(record);
                } catch (error) {
                    parser.abort();
                    reject(error);
                }
            },
            complete: () => resolve(),
            error: reject,
        });
    });
}

/*
================================================================
Per-unit export — regroup data values back into file rows
================================================================
*/

interface UnitAnomalies {
    unknownAttributeOptionCombos: number;
    unknownCategoryOptionCombos: number;
    unknownDataElements: number;
    periodMismatches: number;
    /** Values on non-disaggregated data elements for a batch that has no rows to carry them. */
    orphanBatchLevelValues: number;
}

/**
 * A dropped value is the one outcome this export cannot make good, so a bare count of them is not
 * enough to act on: it says something was lost without saying what. These sets keep the distinct
 * offending ids (bounded, so a systemic problem cannot grow them without limit) and are resolved to
 * names at the end of the file type, turning "316 unknown category option combos" into a list an
 * analyst can actually look up in DHIS2.
 */
const MAX_TRACKED_UNKNOWN_IDS = 50;

interface UnknownIdSamples {
    attributeOptionCombos: Set<string>;
    categoryOptionCombos: Set<string>;
    dataElements: Set<string>;
}

function createUnknownIdSamples(): UnknownIdSamples {
    return { attributeOptionCombos: new Set(), categoryOptionCombos: new Set(), dataElements: new Set() };
}

function trackUnknownId(samples: Set<string>, id: string): void {
    if (samples.size < MAX_TRACKED_UNKNOWN_IDS) samples.add(id);
}

interface UnitResult extends UnitAnomalies {
    rows: string[][];
    dataValuesRead: number;
}

function createUnitAnomalies(): UnitAnomalies {
    return {
        unknownAttributeOptionCombos: 0,
        unknownCategoryOptionCombos: 0,
        unknownDataElements: 0,
        periodMismatches: 0,
        orphanBatchLevelValues: 0,
    };
}

async function buildUnitRows(
    resolved: ResolvedSpec,
    orgUnitCode: string,
    orgUnitId: string,
    year: string,
    unknownIds: UnknownIdSamples
): Promise<UnitResult> {
    // One output row per (attributeOptionCombo, categoryOptionCombo) — the exact grouping the import
    // exploded a file row into. Rows are pre-filled with their dimension cells on creation, so the
    // per-data-value work is a single array write.
    const rowsByAoc = new Map<string, Map<string, string[]>>();
    const batchLevelCellsByAoc = new Map<string, Map<number, string>>();
    const anomalies = createUnitAnomalies();
    let dataValuesRead = 0;

    await streamDataValues(resolved.spec.dataSetId, orgUnitId, year, record => {
        dataValuesRead++;
        const dataElement = record.dataelement ?? "";
        const attributeOptionCombo = record.attributeoptioncombo ?? "";
        const value = record.value ?? "";

        const dimensionedIndex = resolved.dimensionedDataElements.get(dataElement);
        if (dimensionedIndex !== undefined) {
            const categoryOptionCombo = record.categoryoptioncombo ?? "";
            const cocCells = resolved.cocCells.get(categoryOptionCombo);
            if (!cocCells) {
                anomalies.unknownCategoryOptionCombos++;
                trackUnknownId(unknownIds.categoryOptionCombos, categoryOptionCombo);
                return;
            }
            const aocCells = resolved.aocCells.get(attributeOptionCombo);
            if (!aocCells) {
                anomalies.unknownAttributeOptionCombos++;
                trackUnknownId(unknownIds.attributeOptionCombos, attributeOptionCombo);
                return;
            }

            let rowsByCoc = rowsByAoc.get(attributeOptionCombo);
            if (!rowsByCoc) {
                rowsByCoc = new Map();
                rowsByAoc.set(attributeOptionCombo, rowsByCoc);
            }
            let row = rowsByCoc.get(categoryOptionCombo);
            if (!row) {
                const period = record.period ?? year;
                if (period !== year) anomalies.periodMismatches++;
                row = new Array<string>(resolved.header.length).fill("");
                row[resolved.countryIndex] = orgUnitCode;
                row[resolved.yearIndex] = period;
                for (const [index, cellValue] of aocCells) row[index] = cellValue;
                for (const [index, cellValue] of cocCells) row[index] = cellValue;
                rowsByCoc.set(categoryOptionCombo, row);
            }
            row[dimensionedIndex] = value;
            return;
        }

        const batchLevelIndex = resolved.aocLevelDataElements.get(dataElement);
        if (batchLevelIndex !== undefined) {
            let cells = batchLevelCellsByAoc.get(attributeOptionCombo);
            if (!cells) {
                cells = new Map();
                batchLevelCellsByAoc.set(attributeOptionCombo, cells);
            }
            cells.set(batchLevelIndex, value);
            return;
        }

        anomalies.unknownDataElements++;
        trackUnknownId(unknownIds.dataElements, dataElement);
    });

    const rows: string[][] = [];
    for (const [attributeOptionCombo, rowsByCoc] of rowsByAoc) {
        const batchLevelCells = batchLevelCellsByAoc.get(attributeOptionCombo);
        for (const row of rowsByCoc.values()) {
            if (batchLevelCells) for (const [index, value] of batchLevelCells) row[index] = value;
            rows.push(row);
        }
    }
    for (const attributeOptionCombo of batchLevelCellsByAoc.keys()) {
        if (!rowsByAoc.has(attributeOptionCombo)) anomalies.orphanBatchLevelValues++;
    }

    return { ...anomalies, rows, dataValuesRead };
}

/*
================================================================
Run bookkeeping
================================================================
*/

type UnitStatus = "SUCCEEDED" | "FAILED";

interface UnitOutcome extends Partial<UnitAnomalies> {
    fileType: FileTypeName;
    orgUnitCode: string;
    orgUnitId: string;
    year: string;
    status: UnitStatus;
    rowsWritten: number;
    dataValuesRead: number;
    durationMs: number;
    reason?: string;
}

const PROGRESS_CSV_HEADER = [
    "fileType",
    "orgUnitCode",
    "orgUnitId",
    "year",
    "status",
    "rowsWritten",
    "dataValuesRead",
    "unknownAttributeOptionCombos",
    "unknownCategoryOptionCombos",
    "unknownDataElements",
    "periodMismatches",
    "orphanBatchLevelValues",
    "durationMs",
    "reason",
].join(",");

function appendProgressRow(progressFilePath: string, outcome: UnitOutcome): void {
    const row = [
        outcome.fileType,
        outcome.orgUnitCode,
        outcome.orgUnitId,
        outcome.year,
        outcome.status,
        outcome.rowsWritten,
        outcome.dataValuesRead,
        outcome.unknownAttributeOptionCombos ?? 0,
        outcome.unknownCategoryOptionCombos ?? 0,
        outcome.unknownDataElements ?? 0,
        outcome.periodMismatches ?? 0,
        outcome.orphanBatchLevelValues ?? 0,
        outcome.durationMs,
        outcome.reason ?? "",
    ]
        .map(value => escapeCsvField(value))
        .join(",");
    appendFileSync(progressFilePath, row + "\n");
}

// Serialises the write burst of a finished unit so concurrently-fetched units never interleave and each
// country/year lands as one contiguous block in the shared file.
let writeChain: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    const result = writeChain.then(action);
    writeChain = result.catch(() => undefined);
    return result;
}

/*
================================================================
main()
================================================================
*/

interface PlannedUnit {
    orgUnitCode: string;
    orgUnitId: string;
    year: string;
}

async function exportFileType(
    resolved: ResolvedSpec,
    units: PlannedUnit[],
    outputDir: string,
    fileName: string,
    progressFilePath: string
): Promise<{
    outcomes: UnitOutcome[];
    rowsWritten: number;
    outputFile: string;
    unknownIds: UnknownIdSamples;
}> {
    const { fileType } = resolved.spec;
    const dataPath = path.join(outputDir, fileName);
    await CsvStreamWriter.discardPartial(dataPath);
    const writer = new CsvStreamWriter(dataPath, resolved.header, { bom: WRITE_BOM });
    const outcomes: UnitOutcome[] = [];
    const unknownIds = createUnknownIdSamples();
    let completed = 0;

    log(
        `${fileType}: starting ${units.length} unit(s). A "unit" is one (country, year) query against data set ` +
            `${resolved.spec.dataSetId}; ${FETCH_CONCURRENCY} run at a time, and a country/year with no data is a ` +
            `normal, successful unit that contributes no rows.`
    );

    await promiseMapConcurrent(
        units,
        async unit => {
            const startedAt = Date.now();
            const label = `${unit.orgUnitCode} ${unit.year}`;
            let outcome: UnitOutcome;
            try {
                // Retrying the WHOLE unit is safe here (unlike the streaming tracker exports): nothing
                // is written until the unit has been parsed in full, so a retry cannot duplicate rows.
                const result = await retryAsync(
                    () => buildUnitRows(resolved, unit.orgUnitCode, unit.orgUnitId, unit.year, unknownIds),
                    { attempts: 3, baseDelayMs: 2000, shouldRetry: isRetryableError }
                );

                await withWriteLock(async () => {
                    for (const batch of _.chunk(result.rows, WRITE_BATCH_SIZE)) await writer.writeRows(batch);
                });

                outcome = {
                    fileType: resolved.spec.fileType,
                    orgUnitCode: unit.orgUnitCode,
                    orgUnitId: unit.orgUnitId,
                    year: unit.year,
                    status: "SUCCEEDED",
                    rowsWritten: result.rows.length,
                    dataValuesRead: result.dataValuesRead,
                    durationMs: Date.now() - startedAt,
                    unknownAttributeOptionCombos: result.unknownAttributeOptionCombos,
                    unknownCategoryOptionCombos: result.unknownCategoryOptionCombos,
                    unknownDataElements: result.unknownDataElements,
                    periodMismatches: result.periodMismatches,
                    orphanBatchLevelValues: result.orphanBatchLevelValues,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log(`${fileType} [${completed + 1}/${units.length}] ${label} FAILED: ${message}`, LogLevel.ERROR);
                outcome = {
                    fileType,
                    orgUnitCode: unit.orgUnitCode,
                    orgUnitId: unit.orgUnitId,
                    year: unit.year,
                    status: "FAILED",
                    rowsWritten: 0,
                    dataValuesRead: 0,
                    durationMs: Date.now() - startedAt,
                    reason: message,
                };
            }

            outcomes.push(outcome);
            appendProgressRow(progressFilePath, outcome);
            completed++;

            // One line per unit, so at any moment it is visible which country/year is being processed
            // and what it produced. Empty country/years are the common case and say so explicitly,
            // rather than looking like something silently went missing.
            if (outcome.status === "SUCCEEDED") {
                const seconds = (outcome.durationMs / 1000).toFixed(1);
                const detail =
                    outcome.dataValuesRead === 0
                        ? "no data for this country/year"
                        : `${outcome.rowsWritten.toLocaleString()} rows from ` +
                          `${outcome.dataValuesRead.toLocaleString()} data values`;
                log(`${fileType} [${completed}/${units.length}] ${label}: ${detail} (${seconds}s)`);
            }
        },
        FETCH_CONCURRENCY
    );

    await writer.finalize();

    const failed = outcomes.filter(outcome => outcome.status === "FAILED");
    const withData = outcomes.filter(outcome => outcome.status === "SUCCEEDED" && outcome.dataValuesRead > 0).length;
    log(
        `${fileType}: finished all ${units.length} unit(s) — ${withData} had data, ` +
            `${outcomes.length - failed.length - withData} were empty, ${failed.length} failed. ` +
            `${writer.rowsWritten.toLocaleString()} rows written.`
    );

    if (failed.length === 0) {
        return { outcomes, rowsWritten: writer.rowsWritten, outputFile: fileName, unknownIds };
    }

    // A file with a known gap must not be presented as the complete extract, so the gap is named in
    // the filename itself and not only in the manifest.
    const incompleteName = fileName.replace(/\.csv$/, "__INCOMPLETE.csv");
    await rename(dataPath, path.join(outputDir, incompleteName));
    return { outcomes, rowsWritten: writer.rowsWritten, outputFile: incompleteName, unknownIds };
}

/**
 * The instance's real DEFAULT category combination, resolved by name rather than by the
 * `defaultCategoryCombo` constant — which is instance-specific and, on the WHO instance, names a
 * combination that does not exist (bjDvmb4bfuf returns 404; the real default is JzvGfLYkX17).
 *
 * This is used for DIAGNOSTICS ONLY, never for classifying data elements. Classification has to keep
 * using the same constant the import uses, wrong or not: the import decides where a value was written,
 * so an export that "corrected" the constant would stop inverting the import and would misread every
 * data element whose combo is the real default (ABCLASS being exactly that case).
 */
let instanceDefault: { categoryComboId?: string; categoryOptionComboId?: string } = {};

async function resolveInstanceDefaultCombo(): Promise<void> {
    try {
        const response = await api.models.categoryCombos
            .get({
                fields: { id: true, categoryOptionCombos: { id: true } },
                filter: { name: { eq: "default" } },
            })
            .getData();
        const combo = response.objects[0];
        instanceDefault = {
            categoryComboId: combo?.id,
            categoryOptionComboId: combo?.categoryOptionCombos[0]?.id,
        };
        if (combo && combo.id !== defaultCategoryCombo) {
            log(
                `This instance's default category combination is ${combo.id}, but the application code hardcodes ` +
                    `${defaultCategoryCombo} (getCategoryOptionCombo.tsx). The import therefore treats data elements ` +
                    `on the real default combination as if they were disaggregated, and this export mirrors that so ` +
                    `the two stay consistent. Worth raising separately — it is an import-side bug, not an export one.`,
                LogLevel.WARN
            );
        }
    } catch {
        instanceDefault = {};
    }
}

/**
 * Turns the dropped-value counts into something actionable: resolves the sampled ids to DHIS2 names
 * and logs them. A value is dropped when it is stored under a combo the file format has no column for,
 * which is the only way this export loses data — so it is reported by name, at WARN, rather than
 * sitting in the manifest as a number.
 */
async function describeDroppedValues(
    fileType: FileTypeName,
    unknownIds: UnknownIdSamples,
    counts: { attributeOptionCombos: number; categoryOptionCombos: number; dataElements: number }
): Promise<Record<string, unknown>> {
    const total = counts.attributeOptionCombos + counts.categoryOptionCombos + counts.dataElements;
    if (total === 0) {
        log(`${fileType}: no data values were dropped — every value found a place on a file row.`);
        return { total: 0 };
    }

    const describe = async (
        kind: "categoryOptionCombos" | "dataElements",
        ids: Set<string>
    ): Promise<{ id: string; name: string }[]> => {
        if (ids.size === 0) return [];
        try {
            const response =
                kind === "dataElements"
                    ? await api.models.dataElements
                          .get({ fields: { id: true, name: true }, filter: { id: { in: [...ids] } }, paging: false })
                          .getData()
                    : await api.models.categoryOptionCombos
                          .get({ fields: { id: true, name: true }, filter: { id: { in: [...ids] } }, paging: false })
                          .getData();
            const byId = new Map(response.objects.map(object => [object.id, object.name]));
            return [...ids].map(id => ({ id, name: byId.get(id) ?? "(not found in metadata)" }));
        } catch (error) {
            log(
                `${fileType}: could not resolve names for dropped ${kind} (${
                    error instanceof Error ? error.message : String(error)
                }). Reporting raw ids.`,
                LogLevel.WARN
            );
            return [...ids].map(id => ({ id, name: "(lookup failed)" }));
        }
    };

    const [attributeOptionCombos, categoryOptionCombos, dataElements] = await Promise.all([
        describe("categoryOptionCombos", unknownIds.attributeOptionCombos),
        describe("categoryOptionCombos", unknownIds.categoryOptionCombos),
        describe("dataElements", unknownIds.dataElements),
    ]);

    const render = (entries: { id: string; name: string }[]) =>
        entries.map(entry => `${entry.name} [${entry.id}]`).join("; ") || "none";

    // By far the most likely offender is the DEFAULT combo, and "default [Xr12mI7VPn3]" on its own
    // reads like an internal error rather than what it is: a value stored with no disaggregation at
    // all, which no file row can represent because the format requires those columns to be filled.
    const involvesDefault = [...attributeOptionCombos, ...categoryOptionCombos].some(
        entry => entry.id === instanceDefault.categoryOptionComboId
    );
    const defaultNote = involvesDefault
        ? ` NOTE: the DEFAULT combination is among these — those values are stored in DHIS2 without any ` +
          `SPECIMEN/GENDER/ORIGIN/AGEGROUP (or PATHOGEN/ANTIBIOTIC/BATCHID) breakdown, so there is no file row ` +
          `that could carry them. This is a property of the stored data, not of the export.`
        : "";

    log(
        `${fileType}: ${total.toLocaleString()} data value(s) could not be placed on a file row and were NOT ` +
            `exported. By cause — attributeOptionCombo ${counts.attributeOptionCombos}, categoryOptionCombo ` +
            `${counts.categoryOptionCombos}, dataElement ${counts.dataElements}. ` +
            `Distinct offenders (max ${MAX_TRACKED_UNKNOWN_IDS} each): ` +
            `AOC: ${render(attributeOptionCombos)} | COC: ${render(categoryOptionCombos)} | ` +
            `DE: ${render(dataElements)}.${defaultNote}`,
        LogLevel.WARN
    );

    return { total, counts, attributeOptionCombos, categoryOptionCombos, dataElements };
}

async function main(): Promise<void> {
    const startTime = Date.now();
    const envVars = getEnvVars();
    const instance = getInstance(envVars);
    api = getD2APiFromInstance(instance);
    baseUrl = envVars.url;
    authHeader = getAuthHeader(envVars);
    await warmUpSession(api);
    await setupConsoleLogger({ isDebug: false });

    const envLabel = deriveEnvLabel(baseUrl);
    const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputDir = path.join(process.cwd(), `AMR-AGG_bulk_download_${envLabel}_${runTimestamp}`);
    mkdirSync(outputDir, { recursive: true });

    logFilePath = path.join(outputDir, `AMR-AGG_bulk_download_log_${runTimestamp}.txt`);
    const progressFilePath = path.join(outputDir, `AMR-AGG_bulk_download_progress_${runTimestamp}.csv`);
    const manifestPath = path.join(outputDir, `AMR-AGG_bulk_download_manifest_${runTimestamp}.json`);
    installConsoleCapture();
    if (!existsSync(progressFilePath)) writeFileSync(progressFilePath, PROGRESS_CSV_HEADER + "\n");

    console.info(`DHIS2 instance: ${baseUrl} (env label: ${envLabel})`);
    console.info(`File types: ${FILE_TYPES.join(", ")}`);
    console.info(`Output folder: ${outputDir}`);

    const glassModule = await new GlassModuleDefaultRepository(new DataStoreClient(instance))
        .getByName(MODULE_NAMES.AMR)
        .toPromise();

    // Must run before resolveSpec: its data-element warnings explain themselves in terms of the
    // instance's real default combination.
    await resolveInstanceDefaultCombo();

    const resolvedSpecs = new Map<FileTypeName, ResolvedSpec>();
    for (const fileType of FILE_TYPES) {
        const resolved = await resolveSpec(FILE_TYPE_SPECS[fileType]);
        resolvedSpecs.set(fileType, resolved);
        console.info(
            `${fileType}: data set "${resolved.dataSetName}" (${resolved.spec.dataSetId}), ` +
                `${resolved.dimensionedDataElements.size + resolved.aocLevelDataElements.size} data element(s). ` +
                `Columns (${resolved.header.length}): ${resolved.header.join(", ")}`
        );
    }

    const countries = await fetchCountries();
    const selectedCountries =
        ORG_UNIT_CODES.length === 0
            ? countries
            : ORG_UNIT_CODES.map(code => {
                  const country = countries.find(candidate => candidate.code === code);
                  if (!country) throw new Error(`Unknown org unit code: ${code}`);
                  return country;
              });

    const coverage = await fetchCoverage(glassModule.id);
    let years = YEARS;
    if (years.length === 0) {
        if (!coverage || coverage.years.size === 0) {
            throw new Error(
                "YEARS is empty (auto-detect) but no upload coverage was found — set YEARS explicitly rather than " +
                    "exporting an unbounded period range."
            );
        }
        // The full contiguous range, not just the years an upload record exists for: a gap year with
        // data but no upload record would otherwise be silently missing from an "all years" export.
        const numericYears = [...coverage.years].map(Number);
        const [from, to] = [Math.min(...numericYears), Math.max(...numericYears)];
        years = _.range(from, to + 1).map(String);
        log(`Auto-detected year range ${from}-${to} from ${coverage.years.size} year(s) of AMR upload records.`);
    }
    if (PRUNE_BY_COVERAGE && !coverage) {
        throw new Error(
            "PRUNE_BY_COVERAGE is on but the coverage lookup failed — refusing to skip country/years blindly."
        );
    }

    const plannedByFileType = new Map<FileTypeName, PlannedUnit[]>();
    let skippedUnits = 0;
    for (const fileType of FILE_TYPES) {
        const units: PlannedUnit[] = [];
        for (const country of selectedCountries) {
            for (const year of years) {
                if (PRUNE_BY_COVERAGE && !coverage?.keys.has(`${country.id}|${year}|${fileType}`)) {
                    skippedUnits++;
                    continue;
                }
                units.push({ orgUnitCode: country.code, orgUnitId: country.id, year });
            }
        }
        plannedByFileType.set(fileType, units);
        log(`${fileType}: ${units.length} country/year unit(s) planned.`);
    }

    const manifest: Record<string, unknown> = {
        runTimestamp,
        envLabel,
        instanceUrl: baseUrl,
        module: { name: glassModule.name, id: glassModule.id },
        config: { FILE_TYPES, ORG_UNIT_CODES, YEARS: years, PRUNE_BY_COVERAGE, FETCH_CONCURRENCY },
        fileTypes: Object.fromEntries(
            [...resolvedSpecs].map(([fileType, resolved]) => [
                fileType,
                {
                    dataSet: { id: resolved.spec.dataSetId, name: resolved.dataSetName },
                    dataSetCategoryCombo: resolved.spec.dataSetCategoryComboId,
                    dimensionCategoryCombo: AMR_SPECIMEN_GENDER_AGE_ORIGIN_CC_ID,
                    header: resolved.header,
                    plannedUnits: plannedByFileType.get(fileType)?.length ?? 0,
                },
            ])
        ),
        skippedUnits,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    if (DRY_RUN) {
        log(`DRY_RUN complete — no data value was fetched and no data CSV was written. Review ${manifestPath}.`);
        return;
    }

    const results: Record<string, unknown> = {};
    for (const fileType of FILE_TYPES) {
        const resolved = resolvedSpecs.get(fileType) as ResolvedSpec;
        const units = plannedByFileType.get(fileType) as PlannedUnit[];
        const fileName = `AMR-AGG_${fileType}_${envLabel}_${runTimestamp}.csv`;
        const { outcomes, rowsWritten, outputFile, unknownIds } = await exportFileType(
            resolved,
            units,
            outputDir,
            fileName,
            progressFilePath
        );

        const failed = outcomes.filter(outcome => outcome.status === "FAILED");
        const sum = (key: keyof UnitAnomalies) => _.sumBy(outcomes, outcome => outcome[key] ?? 0);
        const droppedValues = await describeDroppedValues(fileType, unknownIds, {
            attributeOptionCombos: sum("unknownAttributeOptionCombos"),
            categoryOptionCombos: sum("unknownCategoryOptionCombos"),
            dataElements: sum("unknownDataElements"),
        });

        results[fileType] = {
            outputFile,
            rowsWritten,
            dataValuesRead: _.sumBy(outcomes, outcome => outcome.dataValuesRead),
            unitsSucceeded: outcomes.length - failed.length,
            unitsFailed: failed.length,
            failedUnits: failed.map(outcome => `${outcome.orgUnitCode}/${outcome.year}: ${outcome.reason ?? ""}`),
            droppedValues,
            periodMismatches: sum("periodMismatches"),
            orphanBatchLevelValues: sum("orphanBatchLevelValues"),
            rowsByYear: _(outcomes)
                .groupBy(outcome => outcome.year)
                .mapValues(group => _.sumBy(group, outcome => outcome.rowsWritten))
                .value(),
        };

        if (failed.length > 0) {
            // Group by reason: a batch of failures almost always shares one cause, and naming that
            // cause once is the difference between "10 units failed" and knowing what to do about it.
            const byReason = _.groupBy(failed, outcome => outcome.reason ?? "unknown error");
            log(`${fileType}: ${failed.length} of ${units.length} unit(s) failed. Causes:`, LogLevel.ERROR);
            for (const [reason, group] of Object.entries(byReason)) {
                log(
                    `  - ${group.length} unit(s): ${reason}\n` +
                        `      affected: ${group.map(o => `${o.orgUnitCode}/${o.year}`).join(", ")}`,
                    LogLevel.ERROR
                );
            }
            log(
                `${fileType}: the output is therefore named __INCOMPLETE. To fill the gap, re-run with ` +
                    `FILE_TYPES = ["${fileType}"], ORG_UNIT_CODES = [${_.uniq(
                        failed.map(o => `"${o.orgUnitCode}"`)
                    ).join(", ")}] and YEARS = [${_.uniq(failed.map(o => `"${o.year}"`)).join(", ")}], then ` +
                    `concatenate the two CSVs (dropping the second header).`,
                LogLevel.ERROR
            );
        }

        manifest.results = results;
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }

    manifest.unitOutcomesFile = path.basename(progressFilePath);
    manifest.elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    console.info(`Export completed in ${manifest.elapsedSeconds} seconds`);
    console.info(`Summary: ${JSON.stringify(results, null, 2)}`);
    console.info(`Output folder: ${outputDir}`);
    console.info(`Progress report: ${progressFilePath}`);
    console.info(`Manifest: ${manifestPath}`);
}

main().catch(error => {
    console.error("Fatal error occurred:", error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exit(1);
});
