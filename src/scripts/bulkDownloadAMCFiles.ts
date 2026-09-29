/*
================================================================
AMC full-data export — every country, every year, every program, as CSV
================================================================
Writes the complete AMC dataset as five flat, joinable CSV tables. See
domain/entities/data-entry/amc/AmcExportTable.ts for what each table IS and how the two reporting
routes converge; see the README this script drops beside the files for the join model.

These are ANALYSIS files. Unlike the .xlsx output of bulkDownloadAMUFiles.ts they are not in the
upload-template format and cannot be re-uploaded.

WHAT MAKES THIS COMPLETE
------------------------
Scope comes from the DATA, never from upload records. The previous CSV mode picked countries and
years out of the GLASS uploads program, which is only complete if upload records are a perfect index
of what is in the tracker — an assumption nothing verifies. Here:

  * Org units are the ones the AMC programs are actually ASSIGNED to.
  * There is no year dimension at all, so no year can be missed and no date boundary can clip a row.
  * Every run ends with a whole-system reconciliation: DHIS2's own ouMode=ALL count per table against
    the rows actually written. Matching totals make completeness PROVEN rather than assumed; a
    mismatch is reported loudly and names the gap.

WHAT MAKES IT FAST
------------------
The work is ~2.6M records. What used to make that slow was request COUNT, not data volume: slicing
every fetch by (country x year x program) produced thousands of passes, most returning nothing, each
paying a server-side COUNT on every page. Here each (table x org unit) is one paginated pass, empty
org units cost a single fast request, and only page 1 asks for a total. Records stream page -> rows
-> disk and are then discarded, so memory is flat and there is no row cap of any kind.

NO RESUME, DELIBERATELY
-----------------------
At this volume a full run is minutes, so a manifest/resume mechanism would be more code and more
state than re-running costs. CsvStreamWriter's `.partial` contract already guarantees an interrupted
run cannot leave a complete-looking file. If runtime ever grows to hours, add resume then — see
bulkDownloadAMRIndividualFiles.ts, which needs it for a far larger dataset.

Run with:  yarn bulk-download-amc-files
*/

import { D2Api } from "@eyeseetea/d2-api/2.34";
import dotenv from "dotenv";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
    AmcExportDefaultRepository,
    DEFAULT_PAGE_SIZE,
} from "../data/repositories/amc-export/AmcExportDefaultRepository";
import {
    AMC_EXPORT_TABLES,
    AmcExportTable,
    AmcExportUnit,
    AmcTableColumns,
    buildHeaders,
    planExportUnits,
    PRODUCT_ID_ATTRIBUTE_CODE,
    tablesOfUnit,
} from "../domain/entities/data-entry/amc/AmcExportTable";
import { Id } from "../domain/entities/Ref";
import { getD2APiFromInstance } from "../utils/d2-api";
import { promiseMapConcurrent } from "../utils/promises";
import { getEnvVars, getInstance, warmUpSession } from "./common";
import { CsvStreamWriter, formatCsvRow } from "./utils/csvStreamWriter";

// .env.local first, then .env — dotenv never overrides an already-set key, so this gives .env.local
// precedence (where this repo keeps credentials). `-r dotenv/config` only loads .env.
dotenv.config({ path: ".env.local" });
dotenv.config();

/*
================================================================
CONFIG — edit before each run
================================================================
*/

// Restrict to specific countries by DHIS2 org unit code (ISO/M49). Leave EMPTY for the whole system,
// which is the point of this script. A non-empty list is what a future per-country UI download would
// pass, and is useful for spot-checking one country against the old output.
const ORG_UNIT_CODES: string[] = [];

// Restrict to specific tables. Leave EMPTY for all five. Table ids are in AMC_EXPORT_TABLES; the one
// most people want on its own is "consumption_calculated".
const TABLE_IDS: string[] = [];

// Max org-unit fetches in flight. Every unit is an independent paginated stream, so this is the main
// throughput dial. See the concurrency note at the bottom of this file before changing it.
const CONCURRENCY = 8;

// Tracker page size. 1000 is proven against this instance. Raising it is the cheapest remaining
// performance lever, but DHIS2 may cap it server-side — verify the row totals still reconcile.
const PAGE_SIZE = DEFAULT_PAGE_SIZE;

// Whole-system ouMode=ALL count per table, reconciled against rows written. One extra request per
// table, and it is what makes completeness provable. Turn off only if the instance rejects ouMode=ALL.
const VERIFY_TOTALS = true;

// How hard to retry a single page before giving up on its org unit. Sized for transient server
// overload rather than a network blip: a real run lost 4 countries (2,286 rows) to HTTP 500s that all
// arrived while several very large countries were in flight, and the 3-attempt/6-second default gave
// up long before the server recovered. Raise the attempts, not CONCURRENCY, if 500s reappear — the
// delay is only ever paid when a request actually fails.
const PAGE_RETRY = { attempts: 5, baseDelayMs: 5000 };

// Prepend a UTF-8 BOM so Excel opens the files as UTF-8 on double-click. Harmless to other readers;
// off by default because it is a byte most non-Excel tooling would rather not see.
const WRITE_BOM = false;

// Warn (do not fail) when the programs are assigned to more org units than a country-level program
// should be. Sweeping a facility-level assignment would still be CORRECT, just slower than expected.
const ORG_UNIT_COUNT_WARN_THRESHOLD = 2000;

const AMC_PROGRAM_IDS = [...new Set(AMC_EXPORT_TABLES.map(table => table.programId))];

/*
================================================================
Output folder, logging, progress
================================================================
*/

// A short, filesystem-safe label for the instance this run targets, derived purely from the resolved
// base URL — no manual hostname->name table (that would need upkeep and risks asserting a wrong
// label, e.g. mis-calling something "PROD"). Host prefix alone is not enough: extranet.who.int/
// dhis2-demo-indiv and extranet.who.int/dhis2-indiv share a host and differ only by path.
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

const envLabel = deriveEnvLabel(process.env.REACT_APP_DHIS2_BASE_URL ?? "");
const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.join(process.cwd(), `AMC_bulk_${envLabel}_${runTimestamp}`);
mkdirSync(outputDir, { recursive: true });

const logFilePath = path.join(outputDir, "log.txt");
const summaryFilePath = path.join(outputDir, "summary.csv");
writeFileSync(
    summaryFilePath,
    formatCsvRow(["table", "orgUnitCode", "orgUnitName", "orgUnitId", "expected", "written", "outcome", "detail"])
);

// Everything printed is also appended to the logfile, so the full run is captured for after-the-fact
// diagnosis. Writes are wrapped so logging can never crash the run.
function toLogFile(args: unknown[]): void {
    try {
        appendFileSync(
            logFilePath,
            args
                .map(arg =>
                    arg instanceof Error
                        ? arg.stack ?? String(arg)
                        : typeof arg === "string"
                        ? arg
                        : JSON.stringify(arg)
                )
                .join(" ") + "\n"
        );
    } catch {
        /* ignore logfile write failures */
    }
}

const original = { log: console.log, warn: console.warn, error: console.error };
for (const level of ["log", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => {
        const stamped = [`[${new Date().toLocaleTimeString()}]`, ...args];
        original[level](...stamped);
        toLogFile(stamped);
    };
}

function recordUnit(
    table: AmcExportTable,
    orgUnit: OrgUnit,
    expected: number | "",
    written: number | "",
    outcome: string,
    detail = ""
): void {
    appendFileSync(
        summaryFilePath,
        formatCsvRow([table.id, orgUnit.code, orgUnit.name, orgUnit.id, expected, written, outcome, detail])
    );
}

/*
================================================================
Setup
================================================================
*/

interface OrgUnit {
    id: Id;
    code: string;
    name: string;
}

/*
Org units are read from the AMC programs' OWN assignment, narrowed to level 3 (country) — not from a
hardcoded country list, and not the raw assignment unfiltered.

The raw assignment was tried first and rejected: on extranet.who.int/dhis2-indiv the AMC programs are
assigned to 3,517 org units, but only 264 of them are countries — the other 3,253 are provinces and
districts (e.g. "TJK-4-4 Khatlon", "NGA-4-14 Enugu State"), almost certainly inherited from a
platform-wide access grant rather than a deliberate AMC configuration. Sweeping all 3,517 turned a
sub-hour export into a multi-hour one dominated by requests to units that were never going to hold
AMC data, several hundred of which additionally failed outright (see the FAILED log lines this
produced — a malformed response with no pagination total, most likely a proxy/permission edge case
tied to those units specifically).

Level 3 is not a guess: the reconciliation from a prior full run matched DHIS2's own ouMode=ALL count
EXACTLY when only level-3 country totals were summed (835,463 = 835,463 on product_register) — proof,
not assumption, that on this instance no AMC row lives below country level.

This still needs no hardcoded country list and no Kosovo special case, because Kosovo already exists
as a normal level-3 unit here (code XKX) — it is included by the same rule as every other country,
not by name.

Should a future instance genuinely hold data below country level, this filter would exclude it
silently on its own — but it would NOT go undetected: the ouMode=ALL reconciliation at the end of the
run compares against the whole system, independent of which org units were swept, so a gap would
still surface as a non-zero difference there.
*/
async function fetchOrgUnits(api: D2Api): Promise<OrgUnit[]> {
    const { objects } = await api.models.programs
        .get({
            fields: { id: true, organisationUnits: { id: true, code: true, name: true, level: true } },
            filter: { id: { in: AMC_PROGRAM_IDS } },
            paging: false,
        })
        .getData();

    if (objects.length !== AMC_PROGRAM_IDS.length) {
        const found = new Set(objects.map(program => program.id));
        throw new Error(
            `AMC program(s) not found on this instance: ${AMC_PROGRAM_IDS.filter(id => !found.has(id)).join(", ")}`
        );
    }

    const byId = new Map<Id, OrgUnit & { level: number }>();
    for (const program of objects) {
        for (const orgUnit of program.organisationUnits) {
            byId.set(orgUnit.id, {
                id: orgUnit.id,
                code: orgUnit.code ?? "",
                name: orgUnit.name,
                level: orgUnit.level,
            });
        }
    }

    const countries = [...byId.values()].filter(orgUnit => orgUnit.level === 3);
    const excluded = byId.size - countries.length;
    if (excluded > 0) {
        console.log(
            `[amc-export] ${excluded.toLocaleString()} non-country org unit(s) assigned to the AMC programs were ` +
                `excluded from the sweep (kept ${countries.length} at level 3). See the comment above fetchOrgUnits.`
        );
    }

    return countries.sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id));
}

/*
================================================================
Export
================================================================
*/

interface TableResult {
    table: AmcExportTable;
    fileName: string;
    written: number;
    failures: number;
}

/** One open CSV file for the duration of an export unit. */
interface OpenTable {
    table: AmcExportTable;
    filePath: string;
    writer: CsvStreamWriter;
}

async function openTable(table: AmcExportTable, columns: AmcTableColumns): Promise<OpenTable> {
    const filePath = path.join(outputDir, table.fileName);
    await CsvStreamWriter.discardPartial(filePath);
    return { table, filePath, writer: new CsvStreamWriter(filePath, buildHeaders(table, columns), { bom: WRITE_BOM }) };
}

/** Finalises a unit's files, renaming any that are not a complete export so they cannot be mistaken
 *  for one, and reports each. `failures` is per unit, because a failed org unit compromises every
 *  table that unit was writing at the time. */
async function closeTables(open: OpenTable[], failures: number): Promise<TableResult[]> {
    const results: TableResult[] = [];
    for (const { table, filePath, writer } of open) {
        await writer.finalize();
        let fileName = table.fileName;
        if (failures > 0) {
            fileName = table.fileName.replace(/\.csv$/, ".INCOMPLETE.csv");
            renameSync(filePath, path.join(outputDir, fileName));
        }
        console.log(
            `DONE ${fileName} — ${writer.rowsWritten.toLocaleString()} rows` +
                (failures > 0 ? `, ${failures} org unit(s) incomplete` : "")
        );
        results.push({ table, fileName, written: writer.rowsWritten, failures });
    }
    return results;
}

/**
 * Exports one unit: either a whole tracker program (register + every stage, from a single nested
 * sweep) or one standalone event program. See planExportUnits in AmcExportTable.ts for why the
 * product tables are grouped rather than fetched separately.
 */
async function exportUnit(params: {
    repository: AmcExportDefaultRepository;
    unit: AmcExportUnit;
    orgUnits: OrgUnit[];
    codeByOrgUnitId: Record<Id, string>;
}): Promise<TableResult[]> {
    const { repository, unit, orgUnits, codeByOrgUnitId } = params;

    const tables = tablesOfUnit(unit);
    const columnsByTableId = new Map<string, AmcTableColumns>();
    for (const table of tables) columnsByTableId.set(table.id, await repository.getColumns(table));

    if (unit.kind === "trackerProgram") {
        const registerColumns = columnsByTableId.get(unit.registerTable.id);
        if (registerColumns && !registerColumns.valueCodes.includes(PRODUCT_ID_ATTRIBUTE_CODE)) {
            console.warn(
                `[amc-export] product_register has no ${PRODUCT_ID_ATTRIBUTE_CODE} attribute — the productId column ` +
                    `on the product consumption tables will be empty. Their trackedEntity column still joins.`
            );
        }
    }

    const open: OpenTable[] = [];
    for (const table of tables) open.push(await openTable(table, columnsByTableId.get(table.id) as AmcTableColumns));
    const writerByTableId = new Map<string, CsvStreamWriter>(open.map(entry => [entry.table.id, entry.writer]));

    const unmapped = new Set<Id>();
    const label = unit.kind === "trackerProgram" ? unit.registerTable.programId : unit.table.id;
    let failures = 0;
    let completed = 0;

    await promiseMapConcurrent(
        orgUnits,
        async orgUnit => {
            const startedAt = Date.now();
            try {
                let written = 0;
                let expected: number | "" = "";
                let reconciled = true;

                if (unit.kind === "trackerProgram") {
                    const onRows = async (tableId: string, rows: string[][]) => {
                        await writerByTableId.get(tableId)?.writeRows(rows);
                    };
                    // Tracks what the nested sweep emitted, so a recovery after a partial failure can
                    // skip it by identity rather than guess by page position.
                    const writtenTrackedEntities = new Set<Id>();

                    let result;
                    try {
                        result = await repository.streamTrackerProgram({
                            programId: unit.programId,
                            registerTable: unit.registerTable,
                            stageTables: unit.stageTables,
                            orgUnitId: orgUnit.id,
                            columnsByTableId,
                            codeByOrgUnitId,
                            pageSize: PAGE_SIZE,
                            onRows,
                            writtenTrackedEntities,
                        });
                    } catch (nestedError) {
                        // A DHIS2 defect makes some entities unserialisable with nested events (see
                        // streamTrackerProgramFallback). It is deterministic, so retrying the same
                        // shape is pointless — switch to the request shapes that do work for them.
                        const message = nestedError instanceof Error ? nestedError.message : String(nestedError);
                        console.warn(
                            `[amc-export] ${label}/${orgUnit.code}: nested sweep failed, recovering the remainder ` +
                                `via the events endpoint. (${message})`
                        );
                        const recovery = await repository.streamTrackerProgramFallback({
                            programId: unit.programId,
                            registerTable: unit.registerTable,
                            stageTables: unit.stageTables,
                            orgUnitId: orgUnit.id,
                            columnsByTableId,
                            codeByOrgUnitId,
                            pageSize: PAGE_SIZE,
                            alreadyWritten: writtenTrackedEntities,
                            onRows,
                        });

                        // The register's server-side count is only available from the nested query's
                        // first page, which is exactly what failed here — so this unit reconciles on
                        // the whole-system totals at the end of the run rather than per country.
                        const recoveredTotal = [...recovery.writtenByTableId.values()].reduce((s, n) => s + n, 0);
                        for (const id of recovery.unmappedIds) unmapped.add(id);
                        for (const table of tables) {
                            recordUnit(table, orgUnit, "", recovery.writtenByTableId.get(table.id) ?? 0, "RECOVERED");
                        }
                        console.log(
                            `[amc-export] ${label} ${++completed}/${orgUnits.length} ${orgUnit.code}: ` +
                                `recovered ${recoveredTotal.toLocaleString()} row(s) in ` +
                                `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
                        );
                        return;
                    }
                    for (const id of result.unmappedIds) unmapped.add(id);

                    // Only the register has a server-side count for this fetch shape (the entity
                    // total). The stage tables are covered by the whole-system reconciliation at the
                    // end of the run instead — see streamTrackerProgram.
                    const registerWritten = result.writtenByTableId.get(unit.registerTable.id) ?? 0;
                    expected = result.registerExpected;
                    reconciled = registerWritten === result.registerExpected;
                    written = [...result.writtenByTableId.values()].reduce((sum, count) => sum + count, 0);

                    for (const table of tables) {
                        recordUnit(
                            table,
                            orgUnit,
                            table.id === unit.registerTable.id ? result.registerExpected : "",
                            result.writtenByTableId.get(table.id) ?? 0,
                            table.id === unit.registerTable.id ? (reconciled ? "OK" : "COUNT_MISMATCH") : "OK"
                        );
                    }
                } else {
                    const result = await repository.streamTable({
                        table: unit.table,
                        orgUnitId: orgUnit.id,
                        columns: columnsByTableId.get(unit.table.id) as AmcTableColumns,
                        context: { codeByOrgUnitId, productIdByTrackedEntity: new Map() },
                        pageSize: PAGE_SIZE,
                        onRows: async rows => {
                            await writerByTableId.get(unit.table.id)?.writeRows(rows);
                        },
                    });
                    for (const id of result.unmappedIds) unmapped.add(id);
                    expected = result.expected;
                    written = result.written;
                    reconciled = result.written === result.expected;
                    recordUnit(
                        unit.table,
                        orgUnit,
                        result.expected,
                        result.written,
                        reconciled ? "OK" : "COUNT_MISMATCH"
                    );
                }

                if (!reconciled) {
                    failures++;
                    console.warn(
                        `[amc-export] ${label}/${orgUnit.code}: expected ${expected} but wrote a differing count.`
                    );
                }

                completed++;
                // Only org units that actually held data are logged: on a whole-system sweep most are
                // empty, and a line each would bury the run's real progress.
                if (written > 0) {
                    console.log(
                        `[amc-export] ${label} ${completed}/${orgUnits.length} ${orgUnit.code}: ` +
                            `${written.toLocaleString()} rows in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
                    );
                }
            } catch (error) {
                // One bad org unit must not cost the whole unit — record it and carry on. Every file
                // this unit writes is marked INCOMPLETE at the end, since the failure could have
                // affected any of them.
                failures++;
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[amc-export] ${label}/${orgUnit.code} FAILED: ${message}`);
                for (const table of tables) recordUnit(table, orgUnit, "", "", "FAILED", message);
                completed++;
            }
        },
        CONCURRENCY
    );

    if (unmapped.size > 0) {
        console.warn(
            `[amc-export] ${label}: ${unmapped.size} data element(s)/attribute(s) carried values but are not part ` +
                `of the program metadata, so they have no column and their values are NOT in the file: ` +
                `${[...unmapped].join(", ")}`
        );
    }

    return closeTables(open, failures);
}

async function main(): Promise<void> {
    const startedAt = Date.now();
    const api = getD2APiFromInstance(getInstance(getEnvVars()));
    await warmUpSession(api);
    const repository = new AmcExportDefaultRepository(api, PAGE_RETRY);

    console.log(`DHIS2 instance: ${process.env.REACT_APP_DHIS2_BASE_URL ?? "(unset)"} (env label: ${envLabel})`);
    console.log(`Output folder:  ${outputDir}`);

    const selectedTables =
        TABLE_IDS.length === 0 ? AMC_EXPORT_TABLES : AMC_EXPORT_TABLES.filter(table => TABLE_IDS.includes(table.id));
    if (selectedTables.length === 0)
        throw new Error(`TABLE_IDS matched no table. Valid ids: ${AMC_EXPORT_TABLES.map(t => t.id).join(", ")}`);

    // The product id lives on the register and nowhere else, so exporting a product consumption table
    // without it yields a blank productId column. That is a legitimate thing to want (the
    // trackedEntity column still joins), but it must never happen by accident.
    if (
        selectedTables.some(table => table.joinsProductRegister) &&
        !selectedTables.some(table => table.id === "product_register")
    ) {
        console.warn(
            "[amc-export] TABLE_IDS selects a product consumption table but not product_register — the productId " +
                'column will be empty. Add "product_register" to populate it; the trackedEntity column joins either way.'
        );
    }

    const allOrgUnits = await fetchOrgUnits(api);
    if (allOrgUnits.length > ORG_UNIT_COUNT_WARN_THRESHOLD) {
        console.warn(
            `[amc-export] The AMC programs are assigned to ${allOrgUnits.length.toLocaleString()} org units — far more ` +
                `than a country-level program needs. The export is still correct, but expect it to be slow; consider ` +
                `narrowing the assignment or this script's sweep.`
        );
    }

    const orgUnits =
        ORG_UNIT_CODES.length === 0
            ? allOrgUnits
            : ORG_UNIT_CODES.map(code => {
                  const orgUnit = allOrgUnits.find(candidate => candidate.code === code);
                  if (!orgUnit) throw new Error(`Unknown org unit code (not assigned to the AMC programs): ${code}`);
                  return orgUnit;
              });

    console.log(
        `Exporting ${selectedTables.length} table(s) for ${orgUnits.length} org unit(s), ` +
            `all years, concurrency ${CONCURRENCY}, page size ${PAGE_SIZE}.`
    );
    writeFileSync(path.join(outputDir, "README.txt"), buildReadme(selectedTables));

    const codeByOrgUnitId = Object.fromEntries(allOrgUnits.map(orgUnit => [orgUnit.id, orgUnit.code]));

    // Units are exported one at a time — the org units WITHIN a unit already provide far more
    // concurrent work than CONCURRENCY consumes, so running units in parallel too would only add
    // contention and interleaved logs for no throughput. No ordering constraint remains between
    // units: the product tables now share one fetch, so an event and its product arrive together and
    // nothing has to be read before anything else (see planExportUnits).
    const units = planExportUnits(selectedTables);
    console.log(
        `Fetch plan: ${units
            .map(unit =>
                unit.kind === "trackerProgram"
                    ? `[1 nested sweep -> ${tablesOfUnit(unit)
                          .map(table => table.id)
                          .join(" + ")}]`
                    : `[${unit.table.id}]`
            )
            .join(" ")}`
    );

    const results: TableResult[] = [];
    for (const unit of units) {
        results.push(...(await exportUnit({ repository, unit, orgUnits, codeByOrgUnitId })));
    }

    await reconcile(repository, results);

    console.log(`Completed in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    console.log(`Output folder: ${outputDir}`);
    console.log(`Summary:       ${summaryFilePath}`);
}

/*
================================================================
Whole-system reconciliation
================================================================
DHIS2's own count for the entire system (ouMode=ALL, no org unit) against the rows this run wrote.
Equal totals mean the org-unit sweep saw everything there is — the completeness claim stops being an
assumption about program assignment and becomes a measured fact. Unequal totals name the gap.
*/
async function reconcile(repository: AmcExportDefaultRepository, results: TableResult[]): Promise<void> {
    if (!VERIFY_TOTALS) return;
    if (ORG_UNIT_CODES.length > 0 || TABLE_IDS.length > 0) {
        console.log("Reconciliation skipped — this run exported a subset, so system totals are not comparable.");
        return;
    }

    console.log("Reconciling against whole-system counts (ouMode=ALL)...");
    const rows: (string | number)[][] = [["table", "systemTotal", "rowsWritten", "difference", "verdict"]];
    let anyGap = false;

    for (const { table, written } of results) {
        try {
            const systemTotal = await repository.countRecords(table);
            const difference = systemTotal - written;
            if (difference !== 0) anyGap = true;
            rows.push([
                table.id,
                systemTotal,
                written,
                difference,
                difference === 0
                    ? "COMPLETE"
                    : difference > 0
                    ? "ROWS MISSING FROM EXPORT"
                    : "EXPORT HAS MORE THAN SYSTEM COUNT",
            ]);
            console.log(
                `  ${table.id}: system ${systemTotal.toLocaleString()} vs written ${written.toLocaleString()}` +
                    (difference === 0 ? "  COMPLETE" : `  DIFFERENCE ${difference.toLocaleString()}`)
            );
        } catch (error) {
            // ouMode=ALL can be unsupported or permission-restricted. That makes the check
            // unavailable, not the export wrong — say so precisely rather than implying a data gap.
            const message = error instanceof Error ? error.message : String(error);
            rows.push([table.id, "", written, "", `CHECK UNAVAILABLE: ${message}`]);
            console.warn(`  ${table.id}: whole-system count unavailable (${message}) — completeness not verified.`);
        }
    }

    writeFileSync(path.join(outputDir, "reconciliation.csv"), rows.map(row => formatCsvRow(row)).join(""));
    console.log(
        anyGap
            ? "RECONCILIATION FOUND A GAP — see reconciliation.csv. Do not treat this export as complete."
            : "Reconciliation clean: every table matches the whole-system count."
    );
}

function buildReadme(tables: AmcExportTable[]): string {
    return `AMC full-data export
====================

One file per AMC table, one row per DHIS2 record, every country and every year. These are ANALYSIS
files: they are NOT in the upload-template format and cannot be re-uploaded.

The AMC pipeline
----------------
A country reports by one of two routes, and both converge on the same calculated program:

    PRODUCT ROUTE                                   SUBSTANCE ROUTE
      (1) Product Register
          the product catalogue: what each product IS
              |                                             |
      (2) Raw Product Consumption                   (4) Raw Substance Consumption
          "N packs of product X in 2023"                "N DDDs of substance Y in 2023"
              |                                             |
      (3) Raw Product Consumption Calculated                |
          packs converted to substance terms,               |
          still ONE ROW PER PRODUCT                         |
              |                                             |
              +---------------> (5) <----------------------+

          (5) Substance Consumption Calculated
              every reporting country, both routes — THE analysis dataset

(5) is where every country lands regardless of how it reported. Its DHIS2 name reads as "calculated
FROM substance submissions", which is the most common misreading of this model — it actually covers
product-reporting countries too. (1)-(4) are the provenance trail behind (5).

Files
-----
${tables.map(table => `  ${table.fileName.padEnd(42)} ${table.description}`).join("\n")}

A file named *.INCOMPLETE.csv holds real data but had at least one org unit fail or fail to
reconcile — see summary.csv for which, and re-run.

How to join them
----------------
1. Product register <-> product events
     AMC_product_consumption_raw.trackedEntity        = AMC_product_register.trackedEntity
     AMC_product_consumption_calculated.trackedEntity = AMC_product_register.trackedEntity
   Both event files also carry productId (the country's own product identifier) denormalised from the
   register, so they are usable without the join.

2. Product <-> substance
   The substance programs hold no tracked entity, so nothing links them to products by uid. Join on
   the substanceKey column, present on AMC_product_consumption_calculated,
   AMC_consumption_calculated and AMC_substance_consumption_raw, and built identically on all three:

     orgUnitCode | year | atc | route_admin | salt | combination | health_sector | health_level

   The underlying data elements differ per file (*_manual on the submitted table, *_autocalculated on
   the calculated ones); substanceKey normalises that away. It is a many-to-many key: several
   products can contribute to one substance row.

3. Everything joins to a country and a period through orgUnitCode (ISO/M49) and period.

Columns
-------
event / trackedEntity / enrollment / orgUnit are DHIS2 uids and are the authoritative record identity.
orgUnitCode is the country code; period is the event date (YYYY-MM-DD).
All other column names are the DHIS2 data element / attribute CODES — the same names the upload
templates use — and values are the codes DHIS2 stores (e.g. "ORAL"), not option uids.

Verifying this export
---------------------
summary.csv          one row per (table, country): DHIS2's count vs rows written.
reconciliation.csv   per table: the whole-system count vs rows written. All zeroes in the
                     "difference" column means the export is provably complete.
`;
}

main().catch(error => {
    console.error("Fatal error:", error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});

/*
================================================================
A note on concurrency (CONCURRENCY above)
================================================================
Every unit is an independent paginated stream, so raising CONCURRENCY raises throughput linearly
until something else becomes the ceiling. In practice the ceiling is almost never Node:

  * The proxy in front of DHIS2 limits concurrent connections per client. Past that limit requests
    are queued or refused, and refused requests show up as retries — so the run gets SLOWER while
    looking busier. This is the usual real ceiling.
  * DHIS2's own connection pool is shared with every other user of the instance. A bulk export that
    saturates it degrades the live app for everyone.
  * Node itself is single-threaded, but this workload is I/O-bound (waiting on HTTP, writing to a
    stream), so threads/workers would not help. CPU is spent on JSON parsing, and that is small
    next to the network wait.

8 is a deliberately conservative starting point. To tune: raise it, and watch rows/second in the log
rather than assuming. If rows/second stops improving, or retry warnings appear, you have found the
ceiling — go back one step. Do NOT tune it upward on a production instance during working hours.

If throughput needs to go further than the proxy allows, the next lever is PAGE_SIZE (fewer, larger
round-trips for the same data), not more connections.
*/
