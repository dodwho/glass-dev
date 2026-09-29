/*
================================================================
AMC coverage audit — READ ONLY, writes nothing to DHIS2
================================================================
Answers two questions before we commit to an export strategy:

  1. Is ouMode=ALL safe on this instance?
     For each AMC program it compares the ouMode=ALL total against the sum of per-country totals.
     If ouMode=ALL returns FEWER rows, it is being restricted by permissions and must not be used.

  2. Was the old country-pruning dropping data?
     The bulk download picks countries by reading the GLASS uploads program ("which countries
     submitted Product / Substance Level Data?"). That is only complete if upload records are a
     perfect index of what is in the tracker. This lists every country that HAS data in a program but
     is NOT in that program's pruned list — i.e. exactly the rows the old strategy silently skipped.

Cost: one count-only request (pageSize=1, totalPages=true) per country per program, plus one
ouMode=ALL request per program. No event bodies are transferred.

Run with:  yarn amc-coverage-audit
*/

import { D2Api } from "@eyeseetea/d2-api/2.34";
import dotenv from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getD2APiFromInstance } from "../utils/d2-api";
import { getEnvVars, getInstance, warmUpSession } from "./common";
import { promiseMapConcurrent } from "../utils/promises";
import { Id } from "../domain/entities/Ref";
import { GlassUploadsStatus } from "../domain/entities/GlassUploads";
import {
    AMR_GLASS_PROE_UPLOADS_PROGRAM_ID,
    getValueById,
    uploadsDHIS2Ids,
} from "../data/repositories/GlassUploadsProgramRepository";
import {
    AMC_PRODUCT_REGISTER_PROGRAM_ID,
    AMC_RAW_PRODUCT_CONSUMPTION_CALCULATED_STAGE_ID,
    AMC_RAW_PRODUCT_CONSUMPTION_STAGE_ID,
} from "../domain/usecases/data-entry/amc/ImportAMCProductLevelData";
import {
    AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID,
    AMC_SUBSTANCE_CALCULATED_CONSUMPTION_PROGRAM_ID,
} from "../domain/usecases/data-entry/amc/ImportAMCSubstanceLevelData";
import { formatCsvRow } from "./utils/csvStreamWriter";
import { AMC_MODULE_ID } from "../domain/entities/data-entry/amc/amcProgramIds";

dotenv.config({ path: ".env.local" });
dotenv.config();

// Max concurrent count queries. These transfer almost nothing but each is a COUNT on the events
// table, which can be slow — keep it modest.
const CONCURRENCY = 6;

// When false (default), the per-country scan covers only the countries the OLD pruning would have
// fetched. That is enough to detect missed data: if ouMode=ALL returns MORE rows than the pruned
// countries add up to, the difference is exactly what pruning was dropping.
//
// Set true to scan all ~266 countries instead, which additionally names WHICH extra countries hold
// the missing rows. Much slower — a COUNT on the events table takes seconds, so 266 countries x 4
// event tables runs for roughly an hour, versus about a minute for the pruned lists (83/16/99).
const SCAN_ALL_COUNTRIES = false;

// When false, skips the per-country scan entirely and only checks that ouMode=ALL works on every
// table, reporting each one's true total. That takes seconds rather than minutes, and is all that is
// needed to CHOOSE a fetch strategy. Leave true to also measure how many rows the old pruning drops.
const MEASURE_PRUNING_GAP = true;

const COVERAGE_STATUSES: GlassUploadsStatus[] = ["IMPORTED", "VALIDATED", "COMPLETED"];

// The pruned country list each table would be fetched for, expressed as which upload type(s) feed it.
// Calculated Consumption is fed by BOTH pipelines (the product calculation aggregates into it, and so
// does the substance calculation), which is why it is "either" rather than "substance".
type PrunedBy = "product" | "substance" | "either";

interface AuditTable {
    name: string;
    kind: "events" | "trackedEntities";
    programId: Id;
    programStageId?: Id;
    prunedBy: PrunedBy;
}

const TABLES: AuditTable[] = [
    {
        name: "product_register",
        kind: "trackedEntities",
        programId: AMC_PRODUCT_REGISTER_PROGRAM_ID,
        prunedBy: "product",
    },
    {
        name: "product_submitted",
        kind: "events",
        programId: AMC_PRODUCT_REGISTER_PROGRAM_ID,
        programStageId: AMC_RAW_PRODUCT_CONSUMPTION_STAGE_ID,
        prunedBy: "product",
    },
    {
        name: "product_calculated",
        kind: "events",
        programId: AMC_PRODUCT_REGISTER_PROGRAM_ID,
        programStageId: AMC_RAW_PRODUCT_CONSUMPTION_CALCULATED_STAGE_ID,
        prunedBy: "product",
    },
    {
        name: "substance_submitted",
        kind: "events",
        programId: AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID,
        prunedBy: "substance",
    },
    {
        name: "substance_calculated",
        kind: "events",
        programId: AMC_SUBSTANCE_CALCULATED_CONSUMPTION_PROGRAM_ID,
        prunedBy: "either",
    },
];

let api!: D2Api;

interface Country {
    id: Id;
    code: string;
    name: string;
}

// Kosovo is not a level-3 org unit, so the AMC scripts add it by hardcoded uid. That uid does not
// exist on every instance — where it doesn't, every query naming it returns E1003 — so it is only
// added after confirming it is really there.
const KOSOVO = { id: "I8AMbKhxlj9", code: "601624", name: "Kosovo" };

async function fetchCountries(): Promise<Country[]> {
    const { objects } = await api.models.organisationUnits
        .get({ fields: { id: true, name: true, code: true }, filter: { level: { eq: "3" } }, paging: false })
        .getData();
    const countries = objects.map(ou => ({ id: ou.id, code: ou.code ?? "", name: ou.name }));

    if (!countries.some(country => country.id === KOSOVO.id)) {
        const { objects: found } = await api.models.organisationUnits
            .get({ fields: { id: true }, filter: { id: { eq: KOSOVO.id } }, paging: false })
            .getData();
        if (found.length > 0) countries.push(KOSOVO);
        else console.log(`Kosovo (${KOSOVO.id}) does not exist on this instance — excluded.`); // eslint-disable-line no-console
    }

    return countries;
}

// The same lookup the bulk download uses to decide which countries to fetch. Reproduced here rather
// than imported so the audit measures the proxy's real behaviour without coupling the two.
async function fetchUploadCoverage(): Promise<{ product: Set<Id>; substance: Set<Id> }> {
    const product = new Set<Id>();
    const substance = new Set<Id>();
    const statuses = new Set<string>(COVERAGE_STATUSES);

    const pageSize = 500;
    let page = 1;
    let result;
    do {
        result = await api.tracker.events
            .get({
                fields: { event: true, orgUnit: true, dataValues: { dataElement: true, value: true } },
                program: AMR_GLASS_PROE_UPLOADS_PROGRAM_ID,
                filter: `${uploadsDHIS2Ids.moduleId}:eq:${AMC_MODULE_ID}`,
                totalPages: true,
                page,
                pageSize,
            })
            .getData();

        for (const event of result.instances) {
            const status = getValueById(event.dataValues, uploadsDHIS2Ids.status) ?? "";
            if (!statuses.has(status) || !event.orgUnit) continue;
            const label = getValueById(event.dataValues, uploadsDHIS2Ids.documentFileType) ?? "";
            if (label === "Product Level Data") product.add(event.orgUnit);
            else if (label === "Substance Level Data") substance.add(event.orgUnit);
        }
        page++;
    } while (result.page < Math.ceil((result.total as number) / pageSize));

    return { product, substance };
}

function isInPrunedList(table: AuditTable, orgUnitId: Id, coverage: { product: Set<Id>; substance: Set<Id> }): boolean {
    switch (table.prunedBy) {
        case "product":
            return coverage.product.has(orgUnitId);
        case "substance":
            return coverage.substance.has(orgUnitId);
        case "either":
            return coverage.product.has(orgUnitId) || coverage.substance.has(orgUnitId);
    }
}

// A bare "400" is useless for diagnosis — dig the status and DHIS2's own message out of the
// axios-shaped error d2-api throws, so a failure says what the server actually objected to.
function describeError(error: unknown): string {
    const err = error as {
        message?: string;
        response?: { status?: number; data?: unknown };
        request?: { path?: string };
    };
    const status = err?.response?.status;
    const data = err?.response?.data;
    const detail = typeof data === "string" ? data : data ? JSON.stringify(data) : undefined;
    return [status ? `HTTP ${status}` : undefined, err?.message, detail].filter(Boolean).join(" | ");
}

// Count-only: pageSize 1 with totalPages, so DHIS2 returns the total without sending record bodies.
// `orgUnitId` omitted means ouMode=ALL (every org unit) — the strategy being validated.
async function countRecords(table: AuditTable, orgUnitId?: Id): Promise<number> {
    const scope = orgUnitId ? ({ orgUnit: orgUnitId, ouMode: "SELECTED" } as const) : ({ ouMode: "ALL" } as const);

    const result =
        table.kind === "trackedEntities"
            ? await api.tracker.trackedEntities
                  .get({
                      program: table.programId,
                      ...scope,
                      fields: { trackedEntity: true },
                      totalPages: true,
                      page: 1,
                      pageSize: 1,
                  })
                  .getData()
            : await api.tracker.events
                  .get({
                      program: table.programId,
                      // Only send programStage when the table actually names one — passing undefined
                      // can serialise into the query string as an empty value and be rejected.
                      ...(table.programStageId ? { programStage: table.programStageId } : {}),
                      ...scope,
                      fields: { event: true },
                      totalPages: true,
                      page: 1,
                      pageSize: 1,
                  })
                  .getData();

    if (result.total == null) {
        throw new Error(
            `${table.name}: response had no pagination total (orgUnit ${orgUnitId ?? "ALL"}) — cannot audit.`
        );
    }
    return result.total as number;
}

// The ouMode=ALL probe is one of the two things this audit exists to answer, so a failure here is a
// RESULT ("cannot be used on this instance"), not a reason to abandon the run. The per-country scan
// below is unaffected and still produces the pruning answer.
async function tryCountAllMode(table: AuditTable): Promise<{ total: number } | { error: string }> {
    try {
        return { total: await countRecords(table) };
    } catch (error) {
        return { error: describeError(error) };
    }
}

async function main(): Promise<void> {
    const baseUrl = process.env.REACT_APP_DHIS2_BASE_URL ?? "";
    api = getD2APiFromInstance(getInstance(getEnvVars()));
    await warmUpSession(api);

    console.log(`DHIS2 instance: ${baseUrl}`); // eslint-disable-line no-console
    // The version decides whether ouMode is even the right parameter name — DHIS2 renamed it to
    // orgUnitMode in 2.41 — so record it before drawing any conclusion from an ouMode failure.
    try {
        const info = await api.get<{ version?: string; revision?: string }>("/system/info").getData();
        console.log(`DHIS2 version: ${info.version ?? "unknown"} (revision ${info.revision ?? "?"})`); // eslint-disable-line no-console
    } catch (error) {
        console.log(`DHIS2 version: could not be read (${describeError(error)})`); // eslint-disable-line no-console
    }
    console.log("READ ONLY — this script writes nothing to DHIS2.\n"); // eslint-disable-line no-console

    const countries = await fetchCountries();
    const coverage = await fetchUploadCoverage();
    console.log(
        // eslint-disable-line no-console
        `Countries: ${countries.length}. Upload records say: ${coverage.product.size} product uploader(s), ` +
            `${coverage.substance.size} substance uploader(s).`
    );
    // The real request count, not countries x tables: each table scans only its own pruned list
    // unless SCAN_ALL_COUNTRIES is set, and MEASURE_PRUNING_GAP can skip the scan altogether.
    const plannedRequests = TABLES.reduce((sum, table) => {
        if (!MEASURE_PRUNING_GAP) return sum + 1;
        const scanSize = SCAN_ALL_COUNTRIES
            ? countries.length
            : countries.filter(country => isInPrunedList(table, country.id, coverage)).length;
        return sum + 1 + scanSize;
    }, 0);
    console.log(
        // eslint-disable-line no-console
        `Issuing ${plannedRequests.toLocaleString()} count-only requests ` +
            `(${
                MEASURE_PRUNING_GAP ? (SCAN_ALL_COUNTRIES ? "full country scan" : "pruned lists") : "ouMode=ALL only"
            })...\n`
    );

    const detailRows: (string | number)[][] = [];
    const summaries: string[] = [];
    let anyRestricted = false;
    let anyMissed = false;
    let allModeUnsupported = false;

    for (const table of TABLES) {
        const started = Date.now();

        // The strategy under test: one request, no org unit, every country.
        const allMode = await tryCountAllMode(table);
        if ("error" in allMode) {
            console.log(`  ${table.name}: ouMode=ALL failed -> ${allMode.error}`); // eslint-disable-line no-console
        }

        // The comparison set: either every country, or just the ones the old pruning would fetch
        // (see SCAN_ALL_COUNTRIES). A country that errors is recorded rather than aborting the table
        // — one bad org unit must not cost the whole scan, and a silent 0 would look like "no data"
        // and corrupt the conclusion.
        const scanned = !MEASURE_PRUNING_GAP
            ? []
            : SCAN_ALL_COUNTRIES
            ? countries
            : countries.filter(country => isInPrunedList(table, country.id, coverage));
        const countErrors: string[] = [];
        // Progress is printed as the scan runs: an events COUNT takes seconds, so a silent table
        // looks indistinguishable from a hung process.
        let done = 0;
        const perCountry = await promiseMapConcurrent(
            scanned,
            async country => {
                try {
                    const count = await countRecords(table, country.id);
                    return { country, count };
                } catch (error) {
                    countErrors.push(`${country.code}: ${describeError(error)}`);
                    return { country, count: 0, failed: true };
                } finally {
                    done++;
                    if (done % 10 === 0 || done === scanned.length) {
                        console.log(`  ${table.name}: counted ${done}/${scanned.length} countries`); // eslint-disable-line no-console
                    }
                }
            },
            CONCURRENCY
        );
        if (countErrors.length > 0) {
            console.log(
                // eslint-disable-line no-console
                `  ${table.name}: ${countErrors.length} per-country count(s) failed. First few: ` +
                    countErrors.slice(0, 3).join(" ; ")
            );
        }

        const prunedTotal = perCountry.reduce((sum, entry) => sum + entry.count, 0);
        const withData = perCountry.filter(entry => entry.count > 0);

        // Rows pruning would drop. When every country was scanned we can attribute them to specific
        // countries; when only the pruned list was scanned, the shortfall against the ouMode=ALL
        // total is the same number without the attribution.
        const missedByPruning = withData.filter(entry => !isInPrunedList(table, entry.country.id, coverage));
        const missedRows = SCAN_ALL_COUNTRIES
            ? missedByPruning.reduce((sum, entry) => sum + entry.count, 0)
            : "error" in allMode
            ? 0
            : Math.max(0, allMode.total - prunedTotal);

        for (const { country, count } of withData) {
            const inPruned = isInPrunedList(table, country.id, coverage);
            detailRows.push([
                table.name,
                country.code,
                country.name,
                country.id,
                count,
                coverage.product.has(country.id) ? "yes" : "no",
                coverage.substance.has(country.id) ? "yes" : "no",
                inPruned ? "yes" : "NO — MISSED BY OLD PRUNING",
            ]);
        }

        const elapsed = Math.round((Date.now() - started) / 1000);
        if (missedRows > 0) anyMissed = true;

        let allModeLine: string;
        let verdict: string;
        if ("error" in allMode) {
            allModeUnsupported = true;
            allModeLine = `UNSUPPORTED (${allMode.error})`;
            verdict = "ouMode=ALL cannot be used on this instance — use an all-countries loop instead";
        } else if (allMode.total < prunedTotal) {
            anyRestricted = true;
            allModeLine = allMode.total.toLocaleString();
            verdict =
                `ouMode=ALL IS RESTRICTED (${allMode.total.toLocaleString()} < ` +
                `${prunedTotal.toLocaleString()}) — do NOT use it`;
        } else if (allMode.total > prunedTotal) {
            allModeLine = allMode.total.toLocaleString();
            verdict =
                `ouMode=ALL sees MORE (${allMode.total.toLocaleString()} > ` +
                `${prunedTotal.toLocaleString()}) — pruning is DROPPING these rows`;
        } else {
            allModeLine = allMode.total.toLocaleString();
            verdict = "ouMode=ALL matches the scanned total";
        }

        const scannedLabel = SCAN_ALL_COUNTRIES ? "all countries" : "pruned list only";
        const missedLabel = SCAN_ALL_COUNTRIES
            ? `${missedByPruning.length} countries, ${missedRows.toLocaleString()} rows`
            : `${missedRows.toLocaleString()} rows (set SCAN_ALL_COUNTRIES to name the countries)`;

        const summary =
            `${table.name}\n` +
            `    ouMode=ALL total:      ${allModeLine}\n` +
            `    scanned total:         ${prunedTotal.toLocaleString()} (${scannedLabel}, ${
                scanned.length
            } countries)\n` +
            `    countries with data:   ${withData.length} of ${scanned.length} scanned\n` +
            `    MISSED by pruning:     ${missedLabel}\n` +
            `    verdict: ${verdict}  (${elapsed}s)`;
        summaries.push(summary);
        console.log(summary + "\n"); // eslint-disable-line no-console
    }

    const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputDir = path.join(process.cwd(), `AMC_coverage_audit_${runTimestamp}`);
    mkdirSync(outputDir, { recursive: true });
    const reportPath = path.join(outputDir, `AMC_coverage_audit_${runTimestamp}.csv`);
    const header = [
        "table",
        "orgUnitCode",
        "orgUnitName",
        "orgUnitId",
        "recordCount",
        "hasProductUpload",
        "hasSubstanceUpload",
        "inOldPrunedList",
    ];
    writeFileSync(reportPath, formatCsvRow(header) + detailRows.map(row => formatCsvRow(row)).join(""));

    console.log("================ CONCLUSION ================"); // eslint-disable-line no-console
    if (allModeUnsupported) {
        console.log(
            // eslint-disable-line no-console
            "ouMode=ALL is NOT supported on this instance (see the errors above).\n" +
                "  -> The export must loop over ALL countries instead (no upload-record pruning).\n" +
                "     Same completeness, more requests — this is a performance choice, not a correctness one."
        );
    } else if (anyRestricted) {
        console.log(
            // eslint-disable-line no-console
            "ouMode=ALL is restricted on this instance and must NOT be used.\n" +
                "  -> The export should loop over ALL countries instead (no upload-record pruning).\n" +
                "     Same completeness, more requests."
        );
    } else {
        console.log(
            // eslint-disable-line no-console
            "ouMode=ALL is safe on this instance — it sees at least as much as the per-country scan.\n" +
                "  -> The export can use a single ouMode=ALL stream per table."
        );
    }
    if (anyMissed) {
        console.log(
            // eslint-disable-line no-console
            "The old upload-record pruning WAS dropping data (see the MISSED lines above).\n" +
                "  -> Pruning must be removed regardless of which fetch strategy is chosen."
        );
    } else {
        console.log(
            // eslint-disable-line no-console
            "The old upload-record pruning did not drop any rows today.\n" +
                "  -> It was accurate, but it is still a guess that depends on upload records staying\n" +
                "     a perfect index. Removing it costs nothing and removes the dependency."
        );
    }
    console.log(`\nPer-country detail: ${reportPath}`); // eslint-disable-line no-console
}

main().catch(error => {
    console.error("Fatal error:", error instanceof Error ? error.message : error); // eslint-disable-line no-console
    process.exit(1);
});
