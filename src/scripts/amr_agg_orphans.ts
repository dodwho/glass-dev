import { boolean, command, flag, number, option, optional, run, string, subcommands } from "cmd-ts";
import dotenv from "dotenv";
import _ from "lodash";
import Papa from "papaparse";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { D2Api } from "@eyeseetea/d2-api/2.41";
import { DataValueSetsDataValue } from "@eyeseetea/d2-api/api";

import { DataStoreClient } from "../data/data-store/DataStoreClient";
import { Instance } from "../data/entities/Instance";
import { DataValuesDefaultRepository } from "../data/repositories/data-entry/DataValuesDefaultRepository";
import { RISDataCSVDefaultRepository } from "../data/repositories/data-entry/RISDataCSVDefaultRepository";
import { SampleDataCSVDeafultRepository } from "../data/repositories/data-entry/SampleDataCSVDeafultRepository";
import { GlassDocumentsDefaultRepository } from "../data/repositories/GlassDocumentsDefaultRepository";
import { GlassModuleDefaultRepository } from "../data/repositories/GlassModuleDefaultRepository";
import {
    AMR_GLASS_PROE_UPLOADS_PROGRAM_ID,
    getValueById,
    uploadsDHIS2Ids,
} from "../data/repositories/GlassUploadsProgramRepository";
import { DataValue } from "../domain/entities/data-entry/DataValue";
import { MODULE_NAMES } from "../domain/entities/GlassModule";
import {
    mapRISDataToDataValues,
    mapSampleDataToDataValues,
} from "../domain/usecases/data-entry/amr/mapAMRAggFileToDataValues";
import { DownloadDocumentAsArrayBufferUseCase } from "../domain/usecases/DownloadDocumentAsArrayBufferUseCase";
import { deleteDataValues } from "../domain/usecases/data-entry/utils/deleteDataValues";
import { getD2APiFromInstance } from "../utils/d2-api";
import { promiseMapConcurrent, retryAsync } from "../utils/promises";
import {
    choiceOf,
    describeAuth,
    getEnvVars,
    getInstance,
    getInstanceKey,
    StringsSeparatedByCommas,
    warmUpSession,
} from "./common";
import {
    AMR_AGG_FILE_TYPES,
    AmrAggFileType,
    BatchJudgement,
    classifyLiveUploads,
    ComparableValue,
    compareValues,
    DELETABLE_VERDICTS,
    describeWrites,
    DeleteTarget,
    explainMislabel,
    FileMatch,
    describeOverlap,
    findBatchOverlaps,
    findChangesBeforeDelete,
    findForeignLabels,
    findOrphans,
    findProbableSource,
    judgeBatch,
    MislabelFinding,
    WAITING_PERIOD_DAYS,
    NEXT_STEPS,
    ORPHAN_CSV_COLUMNS,
    parseOrphanCsv,
    parseYears,
    QUIET_VERDICTS,
    RowLabel,
    StoredBatch,
    toAmrAggFileType,
    UploadRecord,
    uploadedAt,
    isLiveUpload,
    valuesHeldByLiveFiles,
    validateTarget,
    valueKey,
    Verdict,
    VERDICTS,
} from "./utils/amrAggOrphans";
import {
    AmrAggMetadata,
    Country,
    DATA_SETS,
    getAmrAggMetadata,
    getCountries,
    instanceArg,
    InstanceName,
    isDroppedConnection,
    readStoredValues,
    selectInstance,
} from "./utils/amrAggDhis2";

// .env.local (the secrets) first, then .env: dotenv never overrides a key already set, so .env.local wins. Run
// without `-r dotenv/config`, which would read the tracked .env (a test server) first.
dotenv.config({ path: ".env.local" });
dotenv.config();

/*
================================================================
AMR aggregate (RIS / SAMPLE): find, verify and delete data that should not be stored.

Values belong in DHIS2 only under an upload at IMPORTED, VALIDATED or COMPLETED, and only the values its file
maps to. Orphans are left behind mainly because the app skips deleting the data of an AMR upload still at
UPLOADED, even when its values were written (page closed or status save failed after the import).

  find    fast, read-only: every country/year/file type/batch with values stored but no live upload that may own
          them. Reads no files, so these are candidates only: verify and delete also check every other live
          upload's file.
  verify  read-only: every batch compared value by value with its owning upload's file, read and mapped with
          the app's own import code (mapAMRAggFileToDataValues). One verdict per batch (see VERDICTS).
  delete  removes only what verify finds does not belong, worked out again at delete time: a whole ORPHAN batch,
          or the LEFTOVER_VALUES of a submitted batch (values no live upload's file has). Anything else is
          refused. It saves a backup of the real values, dry-runs and checks the count, checks nothing changed
          since, deletes only with --commit plus --confirmInstance, then verifies the batch again. Every target,
          refused or failed ones included, is recorded in deletion-log.jsonl and deletion-report.md.

The delete is the same dataValueSets DELETE the GLASS app runs (deleteDataValues), with the module's
asyncDeleteChunkSizes. DHIS2 keeps a data value audit entry for every deleted value.
================================================================
*/

const DEFAULT_CONCURRENCY = 4;
const UPLOADS_PAGE_SIZE = 500;
const DEFAULT_OUT_DIR = "amr-agg-orphan-deletions";

interface Context extends AmrAggMetadata {
    api: D2Api;
    instance: Instance;
    instanceKey: string;
    /** AMR and AMR - Individual: both store SAMPLE files in the AMR aggregate SAMPLE data set. */
    uploadModuleIds: string[];
    asyncDeleteChunkSize: number | undefined;
    rootOrgUnitId: string;
    countries: Country[];
    waitingDays: number;
    downloadFile: (fileId: string) => Promise<ArrayBuffer>;
}

async function loadContext(
    instanceName: InstanceName | undefined,
    waitingDays = WAITING_PERIOD_DAYS
): Promise<Context> {
    if (instanceName) selectInstance(instanceName);
    const envVars = getEnvVars();
    const instanceKey = getInstanceKey(envVars.url) ?? envVars.url;
    console.log(`Target instance: ${envVars.url} (auth: ${describeAuth(envVars)})`);

    const instance = getInstance(envVars);
    const api = getD2APiFromInstance(instance);
    await warmUpSession(api);

    const dataStoreClient = new DataStoreClient(instance);
    const moduleRepository = new GlassModuleDefaultRepository(dataStoreClient);
    const glassModule = await moduleRepository.getByName(MODULE_NAMES.AMR).toPromise();
    const individualModule = await moduleRepository.getByName(MODULE_NAMES.AMR_INDIVIDUAL).toPromise();

    const roots = await api.models.organisationUnits
        .get({ fields: { id: true }, filter: { level: { eq: "1" } }, paging: false })
        .getData();
    const root = roots.objects[0];
    if (!root || roots.objects.length > 1) throw new Error(`Expected one root org unit, found ${roots.objects.length}`);

    const countries = await getCountries(api);
    const metadata = await getAmrAggMetadata(api, instance, countries);

    const downloadUseCase = new DownloadDocumentAsArrayBufferUseCase(
        new GlassDocumentsDefaultRepository(dataStoreClient, instance)
    );

    console.log(
        `AMR module ${glassModule.id}; batch codes ${metadata.batchCodes.join(", ")}; ${countries.length} countries; ` +
            `delete chunk size ${glassModule.asyncDeleteChunkSizes?.primaryUpload ?? "none (one request)"}`
    );

    return {
        api,
        instance,
        instanceKey,
        uploadModuleIds: [glassModule.id, individualModule.id],
        asyncDeleteChunkSize: glassModule.asyncDeleteChunkSizes?.primaryUpload,
        rootOrgUnitId: root.id,
        countries,
        ...metadata,
        waitingDays,
        // Preprod drops some connections under load, so those are retried. Any other failure (a document missing
        // on the server comes back the same way every time) is reported at once as unreadable, never guessed at.
        downloadFile: fileId =>
            retryAsync(() => downloadUseCase.execute(fileId).toPromise(), {
                attempts: 4,
                shouldRetry: isDroppedConnection,
            }),
    };
}

/**
 * Every AMR upload record, deleted ones included (deleted ones only explain where an orphan came from). Read from the
 * root down rather than in the user's default scope, so a user who cannot see every country gets an error instead of
 * a list missing uploads, whose data would then look orphaned.
 */
async function fetchUploads(context: Context, orgUnitId?: string): Promise<UploadRecord[]> {
    const uploads: UploadRecord[] = [];
    let page = 1;
    let result;
    do {
        result = await retryAsync(() =>
            context.api.tracker.events
                .get({
                    fields: {
                        event: true,
                        orgUnit: true,
                        deleted: true,
                        createdAt: true,
                        dataValues: { dataElement: true, value: true },
                    },
                    program: AMR_GLASS_PROE_UPLOADS_PROGRAM_ID,
                    filter: `${uploadsDHIS2Ids.moduleId}:in:${context.uploadModuleIds.join(";")}`,
                    ...(orgUnitId
                        ? { orgUnit: orgUnitId, orgUnitMode: "SELECTED" as const }
                        : { orgUnit: context.rootOrgUnitId, orgUnitMode: "DESCENDANTS" as const }),
                    includeDeleted: true,
                    // A total order, or events can repeat or go missing across pages.
                    order: "createdAt:asc,event:asc",
                    totalPages: true,
                    page,
                    pageSize: UPLOADS_PAGE_SIZE,
                })
                .getData()
        );

        for (const event of result.instances) {
            const value = (dataElement: string) => getValueById(event.dataValues, dataElement) ?? "";
            const fileType = toAmrAggFileType(value(uploadsDHIS2Ids.documentFileType));
            if (!fileType) continue;
            uploads.push({
                id: event.event,
                orgUnitId: event.orgUnit,
                year: value(uploadsDHIS2Ids.period).match(/\d{4}/)?.[0] ?? "",
                fileType,
                batchId: value(uploadsDHIS2Ids.batchId),
                status: value(uploadsDHIS2Ids.status),
                deleted: Boolean(event.deleted),
                uploadDate: value(uploadsDHIS2Ids.uploadDate),
                createdAt: event.createdAt ?? "",
                fileId: value(uploadsDHIS2Ids.documentId),
                deletionRequestedBy: value(uploadsDHIS2Ids.deletionRequestedBy),
                deletionReason: value(uploadsDHIS2Ids.deletionReason),
            });
        }
        page++;
    } while (result.page < Math.ceil((result.total as number) / UPLOADS_PAGE_SIZE));

    return uploads;
}

/** The values an upload's file maps to, with the app's own reader and mapping; "unreadable" if that fails. */
async function readFileValues(context: Context, upload: UploadRecord, fileType: AmrAggFileType) {
    try {
        const file = await context.downloadFile(upload.fileId);
        const metadata = context.fileMetadata[fileType];
        const mapped =
            fileType === "RIS"
                ? mapRISDataToDataValues(
                      await new RISDataCSVDefaultRepository().getFromArrayBuffer(file).toPromise(),
                      metadata
                  )
                : mapSampleDataToDataValues(
                      await new SampleDataCSVDeafultRepository().getFromArrayBuffer(file).toPromise(),
                      metadata
                  );
        return mapped.dataValues;
    } catch (error) {
        console.warn(
            `  File of upload ${upload.id} could not be read: ${error instanceof Error ? error.message : error}`
        );
        return "unreadable" as const;
    }
}

function batchOf(context: Context, fileType: AmrAggFileType, dataValue: DataValue): string | undefined {
    return context.batchCodeByAoc[fileType].get(dataValue.attributeOptionCombo ?? "");
}

/** When anything last wrote to these values ("" when unknown, which the upload check refuses to guess past). */
function latestWrite(dataValues: DataValueSetsDataValue[]): string {
    return _.maxBy(dataValues, dataValue => Date.parse(dataValue.lastUpdated))?.lastUpdated ?? "";
}

function timestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
    return Papa.unparse({ fields: columns, data: rows.map(row => columns.map(column => row[column] ?? "")) }) + "\n";
}

function instanceSlug(context: Context): string {
    return context.instanceKey.replace(/\W+/g, "-");
}

interface Unit {
    fileType: AmrAggFileType;
    country: { id: string; code: string };
    year: string;
}

interface BatchEvaluation {
    unit: Unit;
    batchId: string;
    stored: DataValueSetsDataValue[];
    lastUpdated: string;
    judgement: BatchJudgement<DataValueSetsDataValue>;
    /** Live imported uploads covering the batch. */
    owners: UploadRecord[];
    /** Live uploads covering the batch still at UPLOADED: never imported as far as the app shows. */
    attempts: UploadRecord[];
    deletedUploads: UploadRecord[];
    /** Who stored the values in question (the deletable ones, else all) and when. */
    writes: string;
    /** The upload record most likely to have written them: evidence only. */
    probableSource?: UploadRecord;
    /** Live uploads in this unit whose file rows carry another country, year or batch than the upload itself. */
    labelMismatches: string[];
}

/**
 * Verdicts for the batches of one country/year/file type: every batch with stored values, plus every batch a live
 * upload claims (to catch uploads whose data is gone). Each file is read at most once per unit and only when a
 * verdict needs it, so a blank-batch upload covering several batches is read once.
 */
async function evaluateUnit(
    context: Context,
    unit: Unit,
    uploads: UploadRecord[],
    batchIds?: string[]
): Promise<{ evaluations: BatchEvaluation[]; unmapped: DataValueSetsDataValue[]; overlaps: string[] }> {
    const { fileType, country, year } = unit;
    const storedByBatch = _.groupBy(
        await readStoredValues(context.api, fileType, country.id, year),
        dataValue => batchOf(context, fileType, dataValue) ?? ""
    );
    const unitUploads = uploads.filter(u => u.orgUnitId === country.id && u.year === year && u.fileType === fileType);
    const claimed = unitUploads.filter(u => !u.deleted && u.batchId !== "").map(u => u.batchId);
    const inScope = _.uniq([...Object.keys(storedByBatch).filter(Boolean), ...claimed])
        .filter(batchId => !batchIds || batchIds.includes(batchId))
        .sort();

    const fileValues = new Map<string, Promise<DataValue[] | "unreadable">>();
    const readFile = (upload: UploadRecord) => {
        const cached = fileValues.get(upload.id) ?? readFileValues(context, upload, fileType);
        fileValues.set(upload.id, cached);
        return cached;
    };

    const evaluations: BatchEvaluation[] = [];
    for (const batchId of inScope) {
        const stored = storedByBatch[batchId] ?? [];
        const lastUpdated = latestWrite(stored);
        const batch = { orgUnitId: country.id, year, fileType, batchId, lastUpdated };
        const { owners, attempts, others } = classifyLiveUploads(uploads, batch);

        const judgement = await judgeBatch({
            year,
            stored,
            owners,
            attempts,
            otherUploads: others,
            zeroNotStoredDataElements: context.zeroNotStoredDataElements,
            now: Date.now(),
            waitingDays: context.waitingDays,
            getFile: async upload => {
                const values = await readFile(upload);
                return values === "unreadable"
                    ? values
                    : values.filter(
                          value =>
                              value.orgUnit === country.id &&
                              value.period === year &&
                              batchOf(context, fileType, value) === batchId
                      );
            },
        });
        const inQuestion = judgement.deletable.length > 0 ? judgement.deletable : stored;
        const firstCreated = _.minBy(inQuestion, value => Date.parse(value.created))?.created ?? "";

        evaluations.push({
            unit,
            batchId,
            stored,
            lastUpdated,
            judgement,
            owners,
            attempts,
            deletedUploads: unitUploads.filter(u => u.deleted && (u.batchId === "" || u.batchId === batchId)),
            writes: describeWrites(inQuestion),
            probableSource: findProbableSource(unitUploads, batch, firstCreated),
            labelMismatches: [],
        });
    }

    // Only files already read are looked at, so this costs no extra download. Rows labelled with another country or
    // year were stored there: the app has blocked them since March 2023, but older imports did not.
    const codeById = new Map(context.countries.map(c => [c.id, c.code]));
    const labelMismatches: string[] = [];
    for (const [uploadId, values] of fileValues) {
        const upload = unitUploads.find(u => u.id === uploadId);
        const read = await values;
        if (!upload || read === "unreadable") continue;
        const label = (orgUnitId: string, period: string, batchId: string) =>
            `${codeById.get(orgUnitId) ?? "unknown country"} ${period} ${upload.batchId ? batchId : "(any batch)"}`;
        const own = label(country.id, year, upload.batchId);
        const labels = _.uniq(
            read.map(value => label(value.orgUnit, value.period, batchOf(context, fileType, value) ?? "unknown batch"))
        ).sort();
        if (labels.some(rowLabel => rowLabel !== own))
            labelMismatches.push(`${upload.id} is ${own} but its file's rows say ${labels.join(", ")}`);
    }
    for (const evaluation of evaluations) evaluation.labelMismatches = labelMismatches;

    // A cell is its attribute option combo moved to one fixed batch, so the same pathogen/antibiotic lines up across
    // batches.
    const toFirstBatch = (aoc: string) => context.aocTranslators[fileType](aoc, context.batchCodes[0] ?? "");
    const overlaps = findBatchOverlaps(_.omit(storedByBatch, ""), toFirstBatch).map(
        overlap => `${describeUnit(unit)}: ${describeOverlap(overlap)}`
    );
    return { evaluations, unmapped: storedByBatch[""] ?? [], overlaps };
}

function describeUnit(unit: Unit): string {
    return `${unit.country.code} ${unit.year} ${unit.fileType}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A summary row for a unit that could not be read, so the CSV shows the gap rather than hiding it. */
function failedRow(unit: Unit): Record<string, unknown> {
    return {
        orgUnitCode: unit.country.code,
        year: unit.year,
        fileType: unit.fileType,
        batchId: "(all)",
        verdict: "READ_FAILED",
        storedValues: 0,
        deletable: 0,
        meaning: VERDICTS.READ_FAILED,
    };
}

function describeUpload(u: UploadRecord): string {
    const deletion = u.deleted
        ? `, deleted${u.deletionRequestedBy ? ` at the request of ${u.deletionRequestedBy}` : ""}` +
          (u.deletionReason ? ` ("${u.deletionReason}")` : "")
        : "";
    return `${u.id} (${u.status}, batch ${u.batchId || "blank"}, uploaded ${
        u.uploadDate.slice(0, 10) || "date unknown"
    }${deletion})`;
}

function describeUploads(uploads: UploadRecord[]): string {
    return uploads
        .map(u => `${u.id} (${u.status}, batch ${u.batchId || "blank"}, uploaded ${u.uploadDate || "date unknown"})`)
        .join(", ");
}

/*
================================================================
Scope shared by find and verify
================================================================
*/

const scopeArgs = {
    instance: instanceArg,
    years: option({
        type: optional(StringsSeparatedByCommas),
        long: "years",
        description: "Years to scan: 2016-2025, or 2022,2024 (default: every year with data or upload records)",
    }),
    fileType: option({
        type: choiceOf(["RIS", "SAMPLE", "BOTH"] as const),
        long: "fileType",
        defaultValue: () => "BOTH" as const,
        description: "RIS, SAMPLE or BOTH (default)",
    }),
    orgUnits: option({
        type: optional(StringsSeparatedByCommas),
        long: "orgUnits",
        description: "Limit to these ISO3 codes (default: every country)",
    }),
    batchIds: option({
        type: optional(StringsSeparatedByCommas),
        long: "batchIds",
        description: "Limit to these batches, e.g. DS1 (default: every batch)",
    }),
    outDir: option({ type: string, long: "outDir", defaultValue: () => DEFAULT_OUT_DIR }),
    concurrency: option({
        type: number,
        long: "concurrency",
        defaultValue: () => DEFAULT_CONCURRENCY,
        description: `Units read at the same time (default ${DEFAULT_CONCURRENCY})`,
    }),
};

const FIRST_YEAR_PROBED = 2000;

/** Every year with values in either data set or an AMR upload record: one cheap request per year and data set. */
async function detectYears(context: Context, fileTypes: AmrAggFileType[], uploads: UploadRecord[]): Promise<string[]> {
    const years = new Set(uploads.map(upload => upload.year).filter(Boolean));
    const orgUnit = context.countries.map(country => country.id);
    for (let year = FIRST_YEAR_PROBED; year <= new Date().getFullYear(); year++)
        for (const fileType of fileTypes) {
            const probe = await retryAsync(() =>
                context.api.dataValues
                    .getSet({ dataSet: [DATA_SETS[fileType].dataSetId], orgUnit, period: [String(year)], limit: 1 })
                    .getData()
            );
            if (probe.dataValues.length > 0) years.add(String(year));
        }
    return [...years].sort();
}

async function resolveScope(
    context: Context,
    args: { years?: string[]; fileType: AmrAggFileType | "BOTH"; orgUnits?: string[]; batchIds?: string[] },
    uploads: UploadRecord[]
): Promise<Unit[]> {
    const fileTypes = args.fileType === "BOTH" ? [...AMR_AGG_FILE_TYPES] : [args.fileType];

    const unknownCodes = (args.orgUnits ?? []).filter(code => !context.countries.some(c => c.code === code));
    if (unknownCodes.length > 0) throw new Error(`Unknown org unit code(s): ${unknownCodes.join(", ")}`);
    const unknownBatches = (args.batchIds ?? []).filter(batchId => !context.batchCodes.includes(batchId));
    if (unknownBatches.length > 0)
        throw new Error(`Unknown batch id(s): ${unknownBatches.join(", ")}. Valid: ${context.batchCodes.join(", ")}`);

    const years = args.years ? parseYears(args.years) : await detectYears(context, fileTypes, uploads);
    console.log(`Years: ${years.join(", ")}${args.years ? "" : " (every year with data or upload records)"}`);

    const countries = args.orgUnits
        ? context.countries.filter(country => args.orgUnits?.includes(country.code))
        : context.countries;
    return fileTypes.flatMap(fileType =>
        countries.flatMap(country => years.map(year => ({ fileType, country, year })))
    );
}

function progress(units: number) {
    const startedAt = Date.now();
    let done = 0;
    return () => {
        done++;
        if (done % 50 === 0 || done === units) {
            const minutesLeft = (((Date.now() - startedAt) / done) * (units - done)) / 60000;
            console.log(`done ${done} of ${units}, about ${Math.ceil(minutesLeft)} min left`);
        }
    };
}

/*
================================================================
find
================================================================
*/

const find = command({
    name: "find",
    description:
        "Fast, read-only: list batches with stored values but no imported upload (candidates: verify and delete " +
        "also check other uploads' files and the waiting period).",
    args: scopeArgs,
    handler: async args => {
        const context = await loadContext(args.instance);
        const uploads = await fetchUploads(context);
        console.log(`Upload records: ${uploads.length} (${uploads.filter(u => !u.deleted).length} live)`);
        const units = await resolveScope(context, args, uploads);
        console.log(`Scanning ${units.length} country/year/file type unit(s), ${args.concurrency} at a time.`);

        const tick = progress(units.length);
        let unmappedValues = 0;
        const failedUnits: Unit[] = [];
        const stored = (
            await promiseMapConcurrent(
                units,
                async ({ fileType, country, year }): Promise<StoredBatch[]> => {
                    const dataValues = await readStoredValues(context.api, fileType, country.id, year).catch(error => {
                        failedUnits.push({ fileType, country, year });
                        console.warn(
                            `  ${country.code} ${year} ${fileType}: could not be read (${errorMessage(error)})`
                        );
                        return [];
                    });
                    const byBatch = _.groupBy(dataValues, dataValue => batchOf(context, fileType, dataValue) ?? "");
                    unmappedValues += byBatch[""]?.length ?? 0;
                    tick();

                    return Object.entries(byBatch)
                        .filter(([batchId]) => batchId !== "" && (!args.batchIds || args.batchIds.includes(batchId)))
                        .map(([batchId, batchValues]) => ({
                            orgUnitId: country.id,
                            orgUnitCode: country.code,
                            year,
                            fileType,
                            batchId,
                            dataValues: batchValues.length,
                            lastUpdated: latestWrite(batchValues),
                        }));
                },
                args.concurrency
            )
        ).flat();

        const orphans = findOrphans(stored, uploads);
        mkdirSync(args.outDir, { recursive: true });
        const outFile = path.join(args.outDir, `amr_agg_orphans_${instanceSlug(context)}_${timestamp()}.csv`);
        writeFileSync(
            outFile,
            toCsv(
                orphans.map(orphan => ({
                    ...orphan,
                    deletedUploadIds: orphan.deletedUploadIds.join(" "),
                    uploadedUploadIds: orphan.uploadedUploadIds.join(" "),
                })),
                ORPHAN_CSV_COLUMNS
            )
        );

        console.log(
            `\n${stored.length} stored batch(es) found, ${orphans.length} with no imported upload ` +
                `(${_.sumBy(orphans, orphan => orphan.dataValues)} data values).`
        );
        if (unmappedValues > 0)
            console.warn(`Warning: ${unmappedValues} value(s) had an attribute option combo outside the batch combos.`);
        for (const orphan of orphans.slice(0, 20))
            console.log(
                `  ${orphan.year} ${orphan.orgUnitCode} ${orphan.fileType} ${orphan.batchId}: ` +
                    `${orphan.dataValues} values last written ${orphan.lastUpdated.slice(0, 10)}, ` +
                    `deleted uploads: ${orphan.deletedUploadIds.join(" ") || "none"}` +
                    (orphan.uploadedUploadIds.length
                        ? `, not imported (UPLOADED): ${orphan.uploadedUploadIds.join(" ")}`
                        : "")
            );
        if (orphans.length > 20) console.log(`  ... ${orphans.length - 20} more`);
        console.log(`Full list: ${outFile}`);
        if (failedUnits.length > 0) {
            console.warn(
                `INCOMPLETE: ${failedUnits.length} unit(s) could not be read: ${failedUnits
                    .map(describeUnit)
                    .join(", ")}`
            );
            process.exitCode = 1;
        }
    },
});

/*
================================================================
verify
================================================================
*/

const VERIFY_COLUMNS = [
    "orgUnitCode",
    "year",
    "fileType",
    "batchId",
    "verdict",
    "reason",
    "nextStep",
    "storedValues",
    "matched",
    "extra",
    "missing",
    "different",
    "deletable",
    "lastUpdated",
    "ownerUploadId",
    "ownerStatus",
    "possibleOwners",
    "fileMatches",
    "uploadedUploadIds",
    "deletedUploadIds",
    "writes",
    "probableSource",
    "labelMismatches",
    "meaning",
];

const DETAIL_COLUMNS = [
    "orgUnitCode",
    "year",
    "fileType",
    "batchId",
    "kind",
    "dataElement",
    "categoryOptionCombo",
    "attributeOptionCombo",
    "storedValue",
    "fileValue",
];

/** The verdict for this batch in one plain sentence, naming the uploads involved. */
function plainReason(evaluation: BatchEvaluation): string {
    const { judgement, attempts, deletedUploads } = evaluation;
    const day = (upload: UploadRecord) => uploadedAt(upload).slice(0, 10) || "date unknown";
    if (judgement.verdict === "ORPHAN") {
        const sameData = judgement.fileMatches.filter(
            match => match.result !== "unreadable" && match.result.matched > 0
        );
        if (sameData.length > 0)
            return (
                "no imported upload; " +
                sameData
                    .map(({ upload }) => {
                        const registered =
                            upload.year === evaluation.unit.year &&
                            (upload.batchId === "" || upload.batchId === evaluation.batchId)
                                ? ""
                                : `, registered as ${upload.year} ${upload.batchId || "blank batch"}`;
                        return `${upload.id} (UPLOADED ${day(upload)}${registered})`;
                    })
                    .join(", ") +
                (sameData.length > 1 ? " hold this data but were" : " holds this data but was") +
                " never imported"
            );
        if (attempts.length > 0)
            return (
                `no imported upload; ${attempts.map(u => `${u.id} (UPLOADED ${day(u)})`).join(", ")} ` +
                (attempts.length > 1 ? "hold other data" : "holds other data")
            );
        if (deletedUploads.length > 0)
            return `no imported upload; its upload(s) were deleted: ${deletedUploads.map(u => u.id).join(", ")}`;
        return "no upload record at all";
    }
    if (judgement.verdict === "LEFTOVER_VALUES" && judgement.owner)
        return (
            `${judgement.deletable.length} values not in the file of ${judgement.owner.id} ` +
            `(${judgement.owner.status} ${day(judgement.owner)}), written before it: ${evaluation.writes}`
        );
    return VERDICTS[judgement.verdict];
}

function summaryRow(evaluation: BatchEvaluation): Record<string, unknown> {
    const { unit, batchId, stored, lastUpdated, judgement, owners, attempts, deletedUploads, writes, probableSource } =
        evaluation;
    const comparison = judgement.comparison;
    return {
        orgUnitCode: unit.country.code,
        year: unit.year,
        fileType: unit.fileType,
        batchId,
        verdict: judgement.verdict,
        reason: plainReason(evaluation),
        nextStep: NEXT_STEPS[judgement.verdict] ?? "",
        storedValues: stored.length,
        matched: comparison?.matched ?? "",
        extra: comparison?.extra.length ?? "",
        missing: comparison?.missing.length ?? "",
        different: comparison?.different.length ?? "",
        deletable: judgement.deletable.length,
        lastUpdated,
        ownerUploadId: judgement.owner?.id ?? "",
        ownerStatus: judgement.owner?.status ?? "",
        possibleOwners: owners.map(u => `${u.id}:${u.status}:${u.uploadDate.slice(0, 10)}`).join(" "),
        fileMatches: judgement.fileMatches.map(describeFileMatch).join("; "),
        uploadedUploadIds: attempts.map(u => u.id).join(" "),
        deletedUploadIds: deletedUploads.map(u => u.id).join(" "),
        writes,
        probableSource: probableSource ? describeUpload(probableSource) : "",
        labelMismatches: evaluation.labelMismatches.join("; "),
        meaning: VERDICTS[judgement.verdict],
    };
}

function describeFileMatch({ upload, result }: FileMatch): string {
    if (result === "unreadable") return `${upload.id}: file unreadable`;
    return (
        `${upload.id} (${upload.status}): ${result.matched} match, ${result.extra} not in file, ` +
        `${result.missing} missing, ${result.different} different`
    );
}

/** The evidence for one batch in the run report; empty for a batch whose data is as its upload says. */
function reportSection(evaluation: BatchEvaluation): string {
    const { unit, batchId, stored, judgement, owners, attempts, deletedUploads, writes, probableSource } = evaluation;
    if (QUIET_VERDICTS.includes(judgement.verdict)) return "";
    const target = `--orgUnit ${unit.country.code} --period ${unit.year} --batchId ${batchId} --fileType ${unit.fileType}`;
    const lines = [
        `### ${unit.country.code} ${unit.year} ${unit.fileType} ${batchId}: ${judgement.verdict}`,
        `${plainReason(evaluation)}.`,
        `- Stored values: ${stored.length}${
            judgement.deletable.length ? `; deletable: ${judgement.deletable.length}` : ""
        }`,
        `- Values in question: ${writes || "none"}`,
        `- Probable source: ${probableSource ? describeUpload(probableSource) : "no upload record found"}`,
        `- Imported uploads: ${owners.length ? owners.map(describeUpload).join("; ") : "none"}`,
    ];
    if (attempts.length) lines.push(`- Not imported (UPLOADED): ${attempts.map(describeUpload).join("; ")}`);
    if (deletedUploads.length) lines.push(`- Deleted uploads: ${deletedUploads.map(describeUpload).join("; ")}`);
    if (evaluation.labelMismatches.length) lines.push(`- Labels differ: ${evaluation.labelMismatches.join("; ")}`);
    if (judgement.fileMatches.length)
        lines.push(`- Files compared: ${judgement.fileMatches.map(describeFileMatch).join("; ")}`);
    lines.push(
        DELETABLE_VERDICTS.includes(judgement.verdict)
            ? `- Action: \`yarn amr-agg-orphans delete ${target}\` (dry run first)`
            : `- Action: ${NEXT_STEPS[judgement.verdict] ?? "none"}`
    );
    return lines.join("\n") + "\n";
}

/** The two tables a reader needs first: what the tool will delete, and what needs a person. */
function actionTables(rows: Record<string, unknown>[]): string[] {
    const cell = (value: unknown) => String(value ?? "").replace(/\|/g, "/");
    const line = (row: Record<string, unknown>, ...columns: string[]) =>
        `| ${row.orgUnitCode} | ${row.year} | ${row.fileType} | ${row.batchId} | ` +
        columns.map(column => cell(row[column])).join(" | ") +
        " |";
    const safe = rows.filter(row => DELETABLE_VERDICTS.includes(row.verdict as Verdict));
    const person = rows.filter(
        row => !DELETABLE_VERDICTS.includes(row.verdict as Verdict) && !QUIET_VERDICTS.includes(row.verdict as Verdict)
    );
    return [
        `## Safe to delete: ${safe.length} batch(es), ${_.sumBy(safe, row => Number(row.deletable))} values`,
        "The tool deletes these and nothing else, after checking them again. Run `delete --file` with this run's CSV.",
        "",
        "| Country | Year | File | Batch | Values to delete | Why |",
        "|---|---|---|---|---|---|",
        ...safe.map(row => line(row, "deletable", "reason")),
        "",
        `## Needs a person: ${person.length} batch(es). Nothing is deleted.`,
        "",
        "| Country | Year | File | Batch | Stored values | What is wrong | Next step |",
        "|---|---|---|---|---|---|---|",
        ...person.map(row => line(row, "storedValues", "reason", "nextStep")),
        "",
    ];
}

/** One row per value that does not match the file. An ORPHAN's values are all "extra" and are not repeated here. */
function detailRows(evaluation: BatchEvaluation): Record<string, unknown>[] {
    const comparison = evaluation.judgement.comparison;
    if (!comparison) return [];
    const base = {
        orgUnitCode: evaluation.unit.country.code,
        year: evaluation.unit.year,
        fileType: evaluation.unit.fileType,
        batchId: evaluation.batchId,
    };
    const row = (kind: string, value: ComparableValue, storedValue: string, fileValue: string) => ({
        ...base,
        kind,
        dataElement: value.dataElement,
        categoryOptionCombo: value.categoryOptionCombo,
        attributeOptionCombo: value.attributeOptionCombo,
        storedValue,
        fileValue,
    });
    return [
        ...comparison.extra.map(value => row("EXTRA", value, value.value, "")),
        ...comparison.missing.map(value => row("MISSING", value, "", value.value)),
        ...comparison.different.map(({ stored, expected }) => row("DIFFERENT", stored, stored.value, expected.value)),
    ];
}

const verify = command({
    name: "verify",
    description: "Read-only: compare stored values with each owning upload's file and give every batch a verdict.",
    args: scopeArgs,
    handler: async args => {
        const context = await loadContext(args.instance);
        const uploads = await fetchUploads(context);
        console.log(`Upload records: ${uploads.length} (${uploads.filter(u => !u.deleted).length} live)`);
        const units = await resolveScope(context, args, uploads);
        console.log(`Verifying ${units.length} country/year/file type unit(s), ${args.concurrency} at a time.`);

        mkdirSync(args.outDir, { recursive: true });
        const stamp = `${instanceSlug(context)}_${timestamp()}`;
        const summaryFile = path.join(args.outDir, `amr_agg_verify_${stamp}.csv`);
        const detailFile = path.join(args.outDir, `amr_agg_verify_${stamp}_values.csv`);
        const reportFile = path.join(args.outDir, `amr_agg_verify_${stamp}_report.md`);
        writeFileSync(detailFile, toCsv([], DETAIL_COLUMNS));

        const tick = progress(units.length);
        const unmappedUnits: string[] = [];
        const overlapLines: string[] = [];
        // Report sections are kept as text, not evaluations, so a full scan never holds every stored value.
        const sections: { key: string; text: string }[] = [];
        const failedUnits: Unit[] = [];
        const evaluations = (
            await promiseMapConcurrent(
                units,
                async unit => {
                    const result = await evaluateUnit(context, unit, uploads, args.batchIds).catch(error => {
                        failedUnits.push(unit);
                        console.warn(`  ${describeUnit(unit)}: READ_FAILED (${errorMessage(error)})`);
                        return undefined;
                    });
                    if (!result) {
                        tick();
                        return [failedRow(unit)];
                    }
                    if (result.unmapped.length > 0)
                        unmappedUnits.push(`${describeUnit(unit)}: ${result.unmapped.length}`);
                    overlapLines.push(...result.overlaps);
                    // Written as it goes, so the per-value detail of a large scan is never all held in memory.
                    const details = [
                        ...result.evaluations.flatMap(detailRows),
                        ...result.unmapped.map(value => ({
                            orgUnitCode: unit.country.code,
                            year: unit.year,
                            fileType: unit.fileType,
                            batchId: "",
                            kind: "UNKNOWN_BATCH_COMBO",
                            dataElement: value.dataElement,
                            categoryOptionCombo: value.categoryOptionCombo,
                            attributeOptionCombo: value.attributeOptionCombo,
                            storedValue: value.value,
                            fileValue: "",
                        })),
                    ];
                    if (details.length > 0)
                        appendFileSync(
                            detailFile,
                            Papa.unparse(details, { header: false, columns: DETAIL_COLUMNS }) + "\n"
                        );
                    for (const evaluation of result.evaluations) {
                        const text = reportSection(evaluation);
                        const key = [unit.year, unit.country.code, unit.fileType, evaluation.batchId].join(" ");
                        if (text) sections.push({ key, text });
                    }
                    tick();
                    return result.evaluations.map(summaryRow);
                },
                args.concurrency
            )
        ).flat();

        const rows = _.sortBy(evaluations, ["year", "orgUnitCode", "fileType", "batchId"]);
        writeFileSync(summaryFile, toCsv(rows, VERIFY_COLUMNS));

        console.log(`\n${rows.length} batch(es) verified:`);
        for (const [verdict, verdictRows] of Object.entries(_.groupBy(rows, row => row.verdict)))
            console.log(
                `  ${verdict}: ${verdictRows.length} batch(es), ${_.sumBy(verdictRows, r => Number(r.storedValues))} ` +
                    `stored values, ${_.sumBy(verdictRows, r => Number(r.deletable))} deletable. ` +
                    VERDICTS[verdict as Verdict]
            );
        const unmappedLine =
            `Values with an attribute option combo outside the batch combos (kind UNKNOWN_BATCH_COMBO in the values ` +
            `file): ${unmappedUnits.length ? unmappedUnits.sort().join("; ") : "none"}.`;
        if (unmappedUnits.length > 0) console.warn(`Warning: ${unmappedLine}`);
        // Each batch can equal its own file and still repeat another batch: data counted twice.
        const overlapSection = [
            `## Batches holding the same rows: ${overlapLines.length} pair(s)`,
            "",
            "A copy (identical, or one batch inside another) counts the same data twice: ask the country which " +
                "batch is right. A partial overlap can be a subset the country sent on purpose.",
            "",
            ...overlapLines.sort().map(line => `- ${line}`),
            "",
        ];
        if (overlapLines.length > 0) console.warn(`\n${overlapSection.join("\n")}`);

        const tables = actionTables(rows);
        console.log(`\n${tables.slice(0, 40).join("\n")}${tables.length > 40 ? "\n(... more in the report)" : ""}`);
        const counts = Object.entries(_.groupBy(rows, row => row.verdict)).map(
            ([verdict, verdictRows]) =>
                `| ${verdict} | ${verdictRows.length} | ${_.sumBy(verdictRows, r => Number(r.storedValues))} | ` +
                `${_.sumBy(verdictRows, r => Number(r.deletable))} | ${VERDICTS[verdict as Verdict]} |`
        );
        writeFileSync(
            reportFile,
            [
                `# AMR aggregate verify report: ${context.instanceKey}`,
                `Run ${new Date().toISOString()}; ${units.length} country/year/file type units; ` +
                    `${uploads.length} upload records. Read-only: nothing was changed.`,
                "",
                ...tables,
                "## All verdicts",
                "",
                "| Verdict | Batches | Stored values | Deletable | Meaning |",
                "|---|---|---|---|---|",
                ...counts,
                "",
                unmappedLine,
                "",
                ...overlapSection,
                ...(failedUnits.length
                    ? [
                          `**Incomplete: ${failedUnits.length} unit(s) could not be read** and were not checked: ` +
                              failedUnits.map(describeUnit).join(", ") +
                              ". Re-run verify for them.",
                          "",
                      ]
                    : []),
                "## Evidence for each finding",
                ..._.sortBy(sections, "key").map(section => section.text),
            ].join("\n")
        );
        console.log(`Summary: ${summaryFile}\nValues that differ: ${detailFile}\nEvidence report: ${reportFile}`);
        if (failedUnits.length > 0) {
            console.warn(
                `INCOMPLETE: ${failedUnits.length} unit(s) could not be read: ${failedUnits
                    .map(describeUnit)
                    .join(", ")}`
            );
            process.exitCode = 1;
        }
    },
});

/*
================================================================
delete
================================================================
*/

/** What happened to one delete target; every target gets one, refusals and failures included. */
type DeleteResult = "DELETED" | "DRY_RUN" | "REFUSED" | "FAILED" | "NOTHING_STORED";

interface DeleteOutcome extends DeleteTarget {
    instance: string;
    at: string;
    result: DeleteResult;
    message: string;
    verdict: Verdict | null;
    ownerUploadId: string;
    writes: string;
    probableSource: string;
    storedBefore: number;
    toDelete: number;
    dryRunDeleted: number | null;
    deleted: number | null;
    verdictAfter: Verdict | null;
    storedAfter: number | null;
    backupFile: string;
    seconds: number;
}

async function evaluateTarget(
    context: Context,
    target: DeleteTarget
): Promise<{ evaluation: BatchEvaluation | undefined; uploads: UploadRecord[] }> {
    const country = context.countries.find(c => c.code === target.orgUnitCode);
    if (!country) throw new Error(`Unknown org unit code ${target.orgUnitCode}`);
    const unit = { fileType: target.fileType, country, year: target.year };
    const uploads = await fetchUploads(context, country.id);
    const { evaluations } = await evaluateUnit(context, unit, uploads, [target.batchId]);
    return { evaluation: evaluations[0], uploads: uploads.filter(u => u.fileType === target.fileType) };
}

/** Appends the outcome to deletion-log.jsonl and, with the verify evidence, to deletion-report.md. */
function recordOutcome(outDir: string, outcome: DeleteOutcome, evaluation: BatchEvaluation | undefined) {
    appendFileSync(path.join(outDir, "deletion-log.jsonl"), JSON.stringify(outcome) + "\n");
    const label = `${outcome.orgUnitCode} ${outcome.year} ${outcome.fileType} ${outcome.batchId}`;
    const evidence =
        (evaluation && reportSection(evaluation)) || `### ${label}${outcome.verdict ? `: ${outcome.verdict}` : ""}\n`;
    const backup = outcome.backupFile ? ` Backup of the values: ${outcome.backupFile}` : "";
    appendFileSync(
        path.join(outDir, "deletion-report.md"),
        `${evidence}- ${outcome.at} on ${outcome.instance}: **${outcome.result}**. ${outcome.message}${backup}\n\n`
    );
}

/** Deletes what the target's verdict allows, and records what happened whatever it is. */
async function deleteTarget(
    context: Context,
    target: DeleteTarget,
    options: { commit: boolean; outDir: string }
): Promise<DeleteOutcome> {
    const label = `${target.orgUnitCode} ${target.year} ${target.fileType} ${target.batchId}`;
    console.log(`\n--- ${label} ---`);
    const startedAt = Date.now();
    const outcome: DeleteOutcome = {
        ...target,
        instance: context.instanceKey,
        at: new Date().toISOString(),
        result: "FAILED",
        message: "",
        verdict: null,
        ownerUploadId: "",
        writes: "",
        probableSource: "",
        storedBefore: 0,
        toDelete: 0,
        dryRunDeleted: null,
        deleted: null,
        verdictAfter: null,
        storedAfter: null,
        backupFile: "",
        seconds: 0,
    };
    let evaluation: BatchEvaluation | undefined;
    const finish = (result: DeleteResult, message: string) => {
        Object.assign(outcome, { result, message, seconds: Math.round((Date.now() - startedAt) / 1000) });
        console.log(`  ${result}: ${message}`);
        recordOutcome(options.outDir, outcome, evaluation);
        return outcome;
    };

    try {
        const checked = await evaluateTarget(context, target);
        evaluation = checked.evaluation;
        if (!evaluation || evaluation.stored.length === 0) return finish("NOTHING_STORED", "No values stored.");

        const { judgement } = evaluation;
        const probableSource = evaluation.probableSource ? describeUpload(evaluation.probableSource) : "none found";
        Object.assign(outcome, {
            verdict: judgement.verdict,
            ownerUploadId: judgement.owner?.id ?? "",
            writes: evaluation.writes,
            probableSource,
            storedBefore: evaluation.stored.length,
        });
        if (!DELETABLE_VERDICTS.includes(judgement.verdict)) {
            const owner = judgement.owner ? ` Owner: ${describeUploads([judgement.owner])}.` : "";
            return finish("REFUSED", `${judgement.verdict}: ${VERDICTS[judgement.verdict]}.${owner}`);
        }

        const dataValues = judgement.deletable;
        outcome.toDelete = dataValues.length;

        // Every live upload's file of this country, year and data set, in AMR or AMR - Individual, whatever batch its
        // record names: a value one of them maps to is that upload's data, so nothing of the batch is deleted.
        const liveUploads = checked.uploads.filter(upload => isLiveUpload(upload, target.year));
        const liveFileValues = [];
        for (const upload of liveUploads) {
            const fileValues = await readFileValues(context, upload, target.fileType);
            if (fileValues === "unreadable")
                return finish(
                    "REFUSED",
                    `The file of live upload ${describeUploads([upload])} could not be read, so it may hold these ` +
                        `values. Nothing deleted.`
                );
            liveFileValues.push(fileValues);
        }
        const held = valuesHeldByLiveFiles(dataValues, liveFileValues);
        if (held.length > 0)
            return finish(
                "REFUSED",
                `${held.length} of the ${dataValues.length} values are in the file of a live upload ` +
                    `(${describeUploads(liveUploads)}). Nothing deleted.`
            );
        console.log(
            `  ${judgement.verdict}: ${dataValues.length} of ${evaluation.stored.length} stored values do not belong ` +
                `(those last written ${latestWrite(dataValues)}). Why: ${plainReason(evaluation)}.`
        );
        console.log(`  Written: ${evaluation.writes}. Probable source: ${probableSource}.`);

        // The backup is the only copy of the values once deleted that can be re-imported as is, so no backup, no delete.
        outcome.backupFile = path.join(
            options.outDir,
            `backup_${instanceSlug(context)}_${label.replace(/ /g, "_")}_${timestamp()}.json`
        );
        writeFileSync(outcome.backupFile, JSON.stringify({ dataValues }, null, 1));
        console.log(`  Backup (with values, importable as CREATE_AND_UPDATE): ${outcome.backupFile}`);

        const repository = new DataValuesDefaultRepository(context.instance);
        // A dry run writes nothing, so a dropped connection is retried (prod drops the first request on a connection
        // left idle while the files are read: PER 2022 and IND 2024 failed here every time). The real delete is not.
        const dryRun = await retryAsync(() => repository.save(dataValues, "DELETE", true).toPromise(), {
            shouldRetry: isDroppedConnection,
        });
        outcome.dryRunDeleted = dryRun.importCount.deleted;
        console.log(`  Dry run: ${dryRun.status}, would delete ${dryRun.importCount.deleted}`);
        if (dryRun.status === "ERROR" || dryRun.importCount.deleted !== dataValues.length)
            return finish(
                "FAILED",
                `Dry run would delete ${dryRun.importCount.deleted} of ${dataValues.length} values (status ` +
                    `${dryRun.status}${
                        dryRun.conflicts?.length ? `, conflicts: ${JSON.stringify(dryRun.conflicts.slice(0, 5))}` : ""
                    }). Nothing deleted.`
            );

        // Last look just before deleting: a country importing since the check could have changed the verdict.
        const countryId = evaluation.unit.country.id;
        const changes = findChangesBeforeDelete(
            { uploads: checked.uploads, deletable: dataValues },
            {
                uploads: (await fetchUploads(context, countryId)).filter(u => u.fileType === target.fileType),
                stored: await readStoredValues(context.api, target.fileType, countryId, target.year),
            }
        );
        if (changes.length > 0)
            return finish(
                "REFUSED",
                `Changed since it was checked (${changes.length}: ${changes.slice(0, 5).join("; ")}). ` +
                    `Nothing deleted; run again.`
            );

        if (!options.commit)
            return finish("DRY_RUN", `${dryRun.importCount.deleted} of ${dataValues.length} would be deleted.`);

        const summary = await deleteDataValues(dataValues, context.asyncDeleteChunkSize, repository).toPromise();
        outcome.deleted = summary.importCount.deleted;
        const after = (await evaluateTarget(context, target)).evaluation;
        const storedAfter = after?.stored.length ?? 0;
        // An orphan must be gone entirely; an upload's batch must now be exactly its file.
        const verdictAfter = after?.judgement.verdict ?? (judgement.verdict === "ORPHAN" ? "ORPHAN" : "MATCH");
        Object.assign(outcome, { verdictAfter, storedAfter });
        const clean =
            judgement.verdict === "ORPHAN"
                ? storedAfter === 0
                : verdictAfter === "MATCH" && storedAfter === evaluation.stored.length - dataValues.length;
        if (summary.status === "ERROR" || summary.importCount.deleted !== dataValues.length || !clean)
            return finish(
                "FAILED",
                `Delete incomplete (status ${summary.status}, deleted ${summary.importCount.deleted} of ` +
                    `${dataValues.length}, ${storedAfter} stored now, verdict ${verdictAfter}). ` +
                    `Restore or retry from the backup.`
            );
        return finish(
            "DELETED",
            `Deleted ${summary.importCount.deleted} of ${dataValues.length}; ${storedAfter} values stored after ` +
                `(${verdictAfter}).`
        );
    } catch (error) {
        return finish("FAILED", errorMessage(error));
    }
}

const remove = command({
    name: "delete",
    description:
        "Delete only values that do not belong (ORPHAN batch, or LEFTOVER_VALUES no imported upload's file has) " +
        "for one country/year/batch/file type, or for every row of a find/verify CSV (--file). Dry run unless --commit.",
    args: {
        instance: instanceArg,
        file: option({
            type: optional(string),
            long: "file",
            description: "CSV from find or verify: each row is checked again, and only deletable ones are deleted",
        }),
        orgUnit: option({ type: optional(string), long: "orgUnit", description: "ISO3 code, e.g. IRQ" }),
        period: option({ type: optional(string), long: "period", description: "Year, e.g. 2024" }),
        batchId: option({ type: optional(string), long: "batchId", description: "e.g. DS1" }),
        fileType: option({
            type: optional(choiceOf(AMR_AGG_FILE_TYPES)),
            long: "fileType",
            description: "RIS or SAMPLE",
        }),
        commit: flag({
            type: boolean,
            long: "commit",
            description: "Actually delete. Without it: backup + dry run only.",
        }),
        confirmInstance: option({
            type: optional(string),
            long: "confirmInstance",
            description: "Required with --commit: the target instance, e.g. portal-uat.who.int/dhis2-indiv",
        }),
        waitDays: option({
            type: optional(number),
            long: "waitDays",
            description:
                `Days to wait after an UPLOADED upload or a write before deleting (default ${WAITING_PERIOD_DAYS}). ` +
                "Lower it only after confirming no import is running for that country and file type.",
        }),
        outDir: option({ type: string, long: "outDir", defaultValue: () => DEFAULT_OUT_DIR }),
    },
    handler: async args => {
        const singleArgs = [args.orgUnit, args.period, args.batchId, args.fileType];
        if (args.file ? singleArgs.some(Boolean) : !singleArgs.every(Boolean))
            throw new Error("Give either --file, or all of --orgUnit --period --batchId --fileType");
        if (args.waitDays !== undefined && !(Number.isInteger(args.waitDays) && args.waitDays >= 0))
            throw new Error("--waitDays must be a whole number of days, 0 or more");
        if (args.waitDays !== undefined && args.waitDays !== WAITING_PERIOD_DAYS && args.file)
            throw new Error("--waitDays other than the default works for one batch at a time, not with --file");

        const context = await loadContext(args.instance, args.waitDays);
        if (context.waitingDays !== WAITING_PERIOD_DAYS)
            console.log(
                `!!! Waiting period lowered to ${context.waitingDays} day(s) by --waitDays (default ${WAITING_PERIOD_DAYS}).`
            );

        if (args.commit && args.confirmInstance?.toLowerCase() !== context.instanceKey)
            throw new Error(
                `--commit needs --confirmInstance ${context.instanceKey} (the instance this run targets), ` +
                    `got ${args.confirmInstance ?? "nothing"}`
            );

        const { targets, skipped } = args.file
            ? parseOrphanCsv(readFileSync(args.file, "utf8"), context.batchCodes)
            : {
                  targets: [
                      {
                          orgUnitCode: args.orgUnit ?? "",
                          year: args.period ?? "",
                          fileType: args.fileType as AmrAggFileType,
                          batchId: args.batchId ?? "",
                      },
                  ],
                  skipped: 0,
              };
        const problem = targets.map(target => validateTarget(target, context.batchCodes)).find(Boolean);
        if (problem) throw new Error(problem);
        if (skipped > 0)
            console.log(`${skipped} CSV row(s) skipped: their verdict is not ${DELETABLE_VERDICTS.join(" or ")}.`);

        console.log(
            args.commit
                ? `=== COMMIT: values that do not belong WILL be deleted on ${context.instanceKey} ` +
                      `(${targets.length} target(s)). ===`
                : `=== DRY RUN: backup + dry run for ${targets.length} target(s). Nothing is deleted. ===`
        );

        mkdirSync(args.outDir, { recursive: true });
        // One at a time; a refusal is recorded and skipped, a failure is recorded and stops the run.
        const outcomes: DeleteOutcome[] = [];
        for (const [index, target] of targets.entries()) {
            const outcome = await deleteTarget(context, target, { commit: args.commit, outDir: args.outDir });
            outcomes.push(outcome);
            console.log(`done ${index + 1} of ${targets.length}`);
            if (outcome.result === "FAILED") {
                console.error(`Stopped at ${target.orgUnitCode} ${target.year} ${target.fileType} ${target.batchId}.`);
                break;
            }
        }

        const done = outcomes.filter(o => o.result === (args.commit ? "DELETED" : "DRY_RUN"));
        console.log(
            `\n${args.commit ? "Deleted" : "Would delete"} ${_.sumBy(done, o => o.toDelete)} values across ` +
                `${done.length} batch(es). ` +
                Object.entries(_.countBy(outcomes, o => o.result))
                    .map(([result, count]) => `${result}: ${count}`)
                    .join(", ") +
                `.\nLog: ${path.join(args.outDir, "deletion-log.jsonl")}; report: ` +
                path.join(args.outDir, "deletion-report.md")
        );
        for (const outcome of outcomes.filter(o => o.result === "REFUSED" || o.result === "FAILED"))
            console.log(
                `  ${outcome.orgUnitCode} ${outcome.year} ${outcome.fileType} ${outcome.batchId}: ` +
                    `${outcome.result}, ${outcome.message}`
            );
        if (outcomes.some(o => o.result === "REFUSED" || o.result === "FAILED") || outcomes.length < targets.length)
            process.exitCode = 1;
    },
});

/*
================================================================
labels
================================================================
*/

const LABEL_COLUMNS = [
    "orgUnitCode",
    "year",
    "fileType",
    "uploadBatchId",
    "uploadId",
    "status",
    "uploadDate",
    "rowsSay",
    "fileValues",
    "storedThere",
    "differentThere",
    "copyInOwnPlace",
    "sharedWith",
    "writes",
    "notes",
    "finding",
    "fix",
];

/**
 * One group of an upload's file rows that name another country, year or batch than the upload: what is stored
 * there, whether the same data is also under the upload's own label, and which other uploads' files share the cells.
 */
async function describeForeignRows(
    context: Context,
    uploads: UploadRecord[],
    upload: UploadRecord,
    group: { label: RowLabel; values: DataValue[] },
    read: {
        stored: (fileType: AmrAggFileType, orgUnitId: string, year: string) => Promise<DataValueSetsDataValue[]>;
        file: (upload: UploadRecord) => Promise<DataValue[] | "unreadable">;
    }
): Promise<Record<string, unknown>> {
    const fileType = upload.fileType as AmrAggFileType;
    const { label, values } = group;
    const zeros = context.zeroNotStoredDataElements;
    const codeOf = (orgUnitId: string) => context.countries.find(c => c.id === orgUnitId)?.code;
    const inBatch = (batchId: string) => (value: DataValue) => batchOf(context, fileType, value) === batchId;
    const there = `${codeOf(label.orgUnitId) ?? "an unknown country"} ${label.year} ${label.batchId}`;
    const own = `${codeOf(upload.orgUnitId)} ${upload.year} ${upload.batchId || "(any batch)"}`;
    const notes: string[] = [];

    // What the rows' label holds: only readable when the rows name a known country and a year.
    const readable = Boolean(codeOf(label.orgUnitId)) && /^\d{4}$/.test(label.year);
    if (!readable) notes.push(`rows name ${there}, which the import cannot store`);
    const storedThere = readable
        ? (await read.stored(fileType, label.orgUnitId, label.year)).filter(inBatch(label.batchId))
        : [];
    const thereComparison = compareValues(storedThere, values, zeros);
    const fileKeys = new Set(values.map(valueKey));
    const writtenThere = storedThere.filter(value => fileKeys.has(valueKey(value)));

    // The same cells moved to the upload's own country, year and batch.
    const translate = context.aocTranslators[fileType];
    const moved = values.flatMap(value => {
        const aoc = upload.batchId
            ? translate(value.attributeOptionCombo ?? "", upload.batchId)
            : value.attributeOptionCombo;
        return aoc ? [{ ...value, orgUnit: upload.orgUnitId, period: upload.year, attributeOptionCombo: aoc }] : [];
    });
    const ownStored = await read.stored(fileType, upload.orgUnitId, upload.year);
    const copyInOwnPlace = compareValues(ownStored, moved, zeros).matched;

    // Other imported uploads whose files put values in the same cells: one may have overwritten the other.
    const { owners } = classifyLiveUploads(uploads, { ...label, fileType, lastUpdated: "" });
    const sharedWith: MislabelFinding["sharedWith"] = [];
    for (const other of owners.filter(o => o.id !== upload.id)) {
        const otherValues = await read.file(other);
        if (otherValues === "unreadable") {
            notes.push(`could not read upload ${other.id}'s file to check for shared cells`);
            continue;
        }
        const otherThere = otherValues.filter(
            value => value.orgUnit === label.orgUnitId && value.period === label.year && inBatch(label.batchId)(value)
        );
        const shared = compareValues(otherThere, values, zeros);
        const cells = shared.matched + shared.different.length;
        if (cells > 0) sharedWith.push({ uploadId: other.id, cells, differentValues: shared.different.length });
    }

    const finding: MislabelFinding = {
        fileValues: values.length,
        storedThere: thereComparison.matched,
        differentThere: thereComparison.different.length,
        copyInOwnPlace,
        sharedWith,
    };
    const explained = explainMislabel(finding, own, there, upload.status !== "UPLOADED");
    return {
        orgUnitCode: codeOf(upload.orgUnitId),
        year: upload.year,
        fileType,
        uploadBatchId: upload.batchId || "(blank)",
        uploadId: upload.id,
        status: upload.status,
        uploadDate: uploadedAt(upload).slice(0, 10),
        rowsSay: there,
        ...finding,
        sharedWith: sharedWith.map(s => `${s.uploadId}: ${s.cells} cells, ${s.differentValues} different`).join("; "),
        writes: describeWrites(writtenThere),
        notes: notes.join("; "),
        finding: explained.finding,
        fix: explained.fix,
    };
}

const labels = command({
    name: "labels",
    description:
        "Read-only audit: every live upload whose file's rows name another country, year or batch than the upload, " +
        "where that data is stored, whether it is stored twice or overlaps another upload, and how to fix it.",
    args: scopeArgs,
    handler: async args => {
        const context = await loadContext(args.instance);
        const uploads = await fetchUploads(context);
        const fileTypes: string[] = args.fileType === "BOTH" ? [...AMR_AGG_FILE_TYPES] : [args.fileType];
        const years = args.years ? parseYears(args.years) : undefined;
        const codeOf = (orgUnitId: string) => context.countries.find(c => c.id === orgUnitId)?.code ?? "";
        const unknownCodes = (args.orgUnits ?? []).filter(code => !context.countries.some(c => c.code === code));
        if (unknownCodes.length > 0) throw new Error(`Unknown org unit code(s): ${unknownCodes.join(", ")}`);
        const live = uploads.filter(
            u =>
                !u.deleted &&
                fileTypes.includes(u.fileType) &&
                (!years || years.includes(u.year)) &&
                (!args.orgUnits || args.orgUnits.includes(codeOf(u.orgUnitId))) &&
                (!args.batchIds || args.batchIds.includes(u.batchId))
        );
        console.log(`Checking the files of ${live.length} live upload(s), ${args.concurrency} at a time.`);

        const cached = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
            const value = cache.get(key) ?? load();
            cache.set(key, value);
            return value;
        };
        const storedCache = new Map<string, Promise<DataValueSetsDataValue[]>>();
        const fileCache = new Map<string, Promise<DataValue[] | "unreadable">>();
        const read = {
            stored: (fileType: AmrAggFileType, orgUnitId: string, year: string) =>
                cached(storedCache, `${fileType}|${orgUnitId}|${year}`, () =>
                    readStoredValues(context.api, fileType, orgUnitId, year)
                ),
            file: (upload: UploadRecord) =>
                cached(fileCache, upload.id, () => readFileValues(context, upload, upload.fileType as AmrAggFileType)),
        };

        const tick = progress(live.length);
        const unreadable: UploadRecord[] = [];
        const failed: string[] = [];
        const rows = (
            await promiseMapConcurrent(
                live,
                async upload => {
                    try {
                        // Not cached: each upload's own file is read once and dropped, so memory stays flat.
                        const values = await readFileValues(context, upload, upload.fileType as AmrAggFileType);
                        if (values === "unreadable") {
                            unreadable.push(upload);
                            return [];
                        }
                        const fileType = upload.fileType as AmrAggFileType;
                        const foreign = findForeignLabels(
                            upload,
                            values,
                            value => batchOf(context, fileType, value) ?? "unknown batch"
                        );
                        const described = [];
                        for (const group of foreign)
                            described.push(await describeForeignRows(context, uploads, upload, group, read));
                        return described;
                    } catch (error) {
                        failed.push(`${upload.id}: ${errorMessage(error)}`);
                        return [];
                    } finally {
                        tick();
                    }
                },
                args.concurrency
            )
        ).flat();

        mkdirSync(args.outDir, { recursive: true });
        const stamp = `${instanceSlug(context)}_${timestamp()}`;
        const csvFile = path.join(args.outDir, `amr_agg_labels_${stamp}.csv`);
        const reportFile = path.join(args.outDir, `amr_agg_labels_${stamp}_report.md`);
        const sorted = _.sortBy(rows, ["year", "orgUnitCode", "fileType", "uploadBatchId"]);
        writeFileSync(csvFile, toCsv(sorted, LABEL_COLUMNS));

        const checked = live.length - unreadable.length - failed.length;
        const cell = (value: unknown) => String(value ?? "").replace(/\|/g, "/");
        // An imported upload's mislabelled rows are data in the wrong place. An UPLOADED upload's are a file the app
        // refused, unless values like its rows are stored with no imported upload's file holding them.
        const imported = sorted.filter(row => row.status !== "UPLOADED");
        const notImported = sorted.filter(row => row.status === "UPLOADED");
        const wroteAnyway = notImported.filter(row => Number(row.storedThere) > 0 && !row.sharedWith);
        const refused = notImported.filter(row => !wroteAnyway.includes(row));
        const count = (groups: Record<string, unknown>[]) => _.uniq(groups.map(row => row.uploadId)).length;
        const summary =
            `${checked} of ${live.length} live uploads' files checked. Rows labelled with another country, year or ` +
            `batch than their upload: ${count(imported)} imported upload(s) (data in the wrong place), ` +
            `${count(wroteAnyway)} never-imported upload(s) whose rows' values are stored anyway, ` +
            `${count(refused)} refused attempt(s) (nothing to fix).`;
        const kind = (row: Record<string, unknown>) => {
            const [country, year] = String(row.rowsSay).split(" ");
            return country !== row.orgUnitCode ? "country" : year !== row.year ? "year" : "batch";
        };
        const table = (groups: Record<string, unknown>[]) => [
            "| Country | Year | File | Upload (its batch) | Status | Rows say | What is stored | Fix |",
            "|---|---|---|---|---|---|---|---|",
            ...groups.map(
                row =>
                    `| ${row.orgUnitCode} | ${row.year} | ${row.fileType} | ${row.uploadId} (${row.uploadBatchId}) ` +
                    `| ${row.status} | ${row.rowsSay} | ${cell(row.finding)} | ${cell(row.fix)} |`
            ),
            "",
        ];
        const evidence = (row: Record<string, unknown>) =>
            [
                `### ${row.orgUnitCode} ${row.year} ${row.fileType}: upload ${row.uploadId} (${row.uploadBatchId}), rows say ${row.rowsSay}`,
                `- Upload: ${row.status}, uploaded ${row.uploadDate || "date unknown"}`,
                `- File values with this label: ${row.fileValues}; stored there, equal: ${row.storedThere}; ` +
                    `stored there with another value: ${row.differentThere}; same values also under the ` +
                    `upload's own label: ${row.copyInOwnPlace}`,
                `- Written: ${row.writes || "nothing stored"}`,
                `- Shared cells with other uploads: ${row.sharedWith || "none"}`,
                ...(row.notes ? [`- Notes: ${row.notes}`] : []),
                "",
            ].join("\n");
        writeFileSync(
            reportFile,
            [
                `# AMR aggregate label audit: ${context.instanceKey}`,
                `Run ${new Date().toISOString()}. Read-only: nothing was changed. ${summary}`,
                "",
                `## Needs a person: ${count(imported)} imported upload(s) whose data is stored under another label`,
                "",
                ...table(imported),
                `## Never imported, but values like its rows are stored: ${count(wroteAnyway)} upload(s)`,
                "No imported upload's file holds these values, so `verify` treats them as deletable after the " +
                    "waiting period (decision 24 Oct).",
                "",
                ...table(wroteAnyway),
                `## Refused attempts: ${count(refused)} upload(s), nothing to fix`,
                "Still at UPLOADED: the app refused these files because their rows name another batch, year or " +
                    "country. Rows say: " +
                    Object.entries(_.countBy(refused, kind))
                        .map(([what, groups]) => `another ${what} (${groups})`)
                        .join(", ") +
                    ".",
                "",
                "| Country | Year | File | Upload (its batch) | Rows say |",
                "|---|---|---|---|---|",
                ...refused.map(
                    row =>
                        `| ${row.orgUnitCode} | ${row.year} | ${row.fileType} | ${row.uploadId} (${row.uploadBatchId}) | ${row.rowsSay} |`
                ),
                "",
                "## Evidence (imported and stored-anyway uploads)",
                ...[...imported, ...wroteAnyway].map(evidence),
                ...(unreadable.length + failed.length
                    ? [
                          `## Not checked: ${unreadable.length + failed.length} upload(s)`,
                          ...unreadable.map(
                              u => `- ${u.id} (${codeOf(u.orgUnitId)} ${u.year} ${u.fileType}): file unreadable`
                          ),
                          ...failed.map(line => `- ${line}`),
                      ]
                    : []),
            ].join("\n")
        );

        console.log(`\n${summary}`);
        for (const row of [...imported, ...wroteAnyway])
            console.log(
                `  ${row.orgUnitCode} ${row.year} ${row.fileType} upload ${row.uploadId} (${row.uploadBatchId}), ` +
                    `rows say ${row.rowsSay}: ${row.finding}`
            );
        console.log(`Table: ${csvFile}\nReport: ${reportFile}`);
        if (unreadable.length + failed.length > 0) {
            console.warn(
                `INCOMPLETE: ${unreadable.length} file(s) unreadable, ${failed.length} upload(s) failed; ` +
                    `listed in the report.`
            );
            process.exitCode = 1;
        }
    },
});

run(
    subcommands({ name: "amr_agg_orphans", cmds: { find, verify, labels, delete: remove } }),
    process.argv.slice(2)
).catch(err => {
    // Message only: a d2-api error object carries the request headers, including the access token.
    console.error(`Fatal error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
});
