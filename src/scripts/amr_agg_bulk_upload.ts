import { boolean, command, flag, number, option, optional, run, string } from "cmd-ts";
import dotenv from "dotenv";
import _ from "lodash";
import Papa from "papaparse";
import { appendFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getCompositionRoot } from "../CompositionRoot";
import { DataStoreClient } from "../data/data-store/DataStoreClient";
import { RISDataCSVDefaultRepository } from "../data/repositories/data-entry/RISDataCSVDefaultRepository";
import { SampleDataCSVDeafultRepository } from "../data/repositories/data-entry/SampleDataCSVDeafultRepository";
import { GlassDataSubmissionsDefaultRepository } from "../data/repositories/GlassDataSubmissionDefaultRepository";
import { GlassModuleDefaultRepository } from "../data/repositories/GlassModuleDefaultRepository";
import { MODULE_NAMES } from "../domain/entities/GlassModule";
import {
    mapRISDataToDataValues,
    mapSampleDataToDataValues,
} from "../domain/usecases/data-entry/amr/mapAMRAggFileToDataValues";
import { Semaphore } from "../domain/usecases/data-entry/utils/Semaphore";
import { getD2APiFromInstance } from "../utils/d2-api";
import { promiseMapConcurrent, retryAsync } from "../utils/promises";
import { describeAuth, getEnvVars, getInstance, getInstanceKey, getTokenOwner, warmUpSession } from "./common";
import {
    BatchOperations,
    BatchOutcome,
    BatchToLoad,
    checkPreflight,
    describeBatch,
    FileProblem,
    fileTypesOf,
    keyFromRows,
    loadBatch,
    LocalFile,
    pairFiles,
    readyToSubmit,
    submissionTransitions,
} from "./utils/amrAggBulkUpload";
import {
    getAmrAggMetadata,
    getCountries,
    instanceArg,
    InstanceName,
    isDroppedConnection,
    readStoredValues,
    selectInstance,
} from "./utils/amrAggDhis2";
import { AmrAggFileType, compareValues } from "./utils/amrAggOrphans";

// .env.local (the secrets) first, then .env: dotenv never overrides a key already set, so .env.local wins.
dotenv.config({ path: ".env.local" });
dotenv.config();

/*
================================================================
AMR aggregate (RIS / SAMPLE) bulk upload: the app's single upload, run for every batch in a folder.

Reads every file under --folder, keeps the RIS and SAMPLE files the app accepts, and takes each file's country, year
and batch from its rows. Then, per batch:
  1. refuses it if the country is not enrolled in AMR or the year's submission is closed for uploads; skips it if it
     already has data: stored values, or an upload beyond UPLOADED (or queued) in AMR or AMR - Individual;
  2. runs the app's dry run of RIS and SAMPLE (every check the app makes); an error in either refuses the batch.
Without --commit it stops there and writes nothing. With --commit (and --confirmInstance) it goes on as the app does:
  3. submission (created if missing), upload records, SAMPLE linked to RIS, dry-run errors saved;
  4. uploads IMPORTED, real import (if it stops part-way, the values written are deleted and the uploads stay IMPORTED);
  5. reads the batch back and compares it value by value with the files; only if equal: VALIDATED, then COMPLETED.
     Errors after the import (DHIS2 validation rules) or a difference roll the whole batch back.
When every batch of a country/year is loaded (or already there), the year goes COMPLETE -> PENDING_APPROVAL, as with
the app's buttons. No notification is sent.
Country/years run --concurrency at a time (batches of one year one after the other); writes to the shared DataStore
lists (documents, submissions) take turns, since each rewrites the whole list.
Results: results.csv (one row per batch, with each step's seconds), submissions.csv, file-problems.csv.
================================================================
*/

const MODULE = MODULE_NAMES.AMR;
/**
 * No request may hang the run (DEV, 26 Oct: one never returned). Imports run as DHIS2 jobs and their status checks
 * have their own limit (waitForJob), so 10 minutes only cuts off a request that is stuck.
 */
const REQUEST_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OUT_DIR = "amr-agg-bulk-upload";
const RESULT_COLUMNS = [
    "orgUnitCode",
    "year",
    "batchId",
    "risFile",
    "sampleFile",
    "result",
    "message",
    "nextStep",
    "risUploadId",
    "sampleUploadId",
    "dryRunValuesRIS",
    "dryRunValuesSAMPLE",
    "seconds",
    "stepSeconds",
];
const SUBMISSION_COLUMNS = ["orgUnitCode", "year", "before", "after", "note"];

const csvLine = (row: Record<string, unknown>, columns: string[]) =>
    Papa.unparse({ fields: columns, data: [columns.map(column => row[column] ?? "")] }, { header: false }) + "\n";
const csvHeader = (columns: string[]) => columns.join(",") + "\n";

function filesUnder(folder: string): string[] {
    return readdirSync(folder, { recursive: true, encoding: "utf8" })
        .map(name => path.join(folder, name))
        .filter(filePath => statSync(filePath).isFile())
        .sort();
}

async function toFile(filePath: string): Promise<File> {
    return new File([new Uint8Array(await readFile(filePath))], path.basename(filePath));
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads only (dry runs included), so a dropped connection is retried; real writes never are. */
const retryRead = <T>(read: () => Promise<T>) => retryAsync(read, { attempts: 4, shouldRetry: isDroppedConnection });

async function loadContext(instanceName: InstanceName | undefined) {
    if (instanceName) selectInstance(instanceName);
    const envVars = getEnvVars();
    const instanceKey = getInstanceKey(envVars.url) ?? envVars.url;
    console.log(`Target instance: ${envVars.url} (auth: ${describeAuth(envVars)})`);

    const instance = getInstance(envVars, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
    const api = getD2APiFromInstance(instance);
    await warmUpSession(api);

    // The app's own use cases, built exactly as the app builds them.
    const app = getCompositionRoot(instance);
    const dataStoreClient = new DataStoreClient(instance);
    const submissions = new GlassDataSubmissionsDefaultRepository(dataStoreClient);
    const countries = await getCountries(api);
    const metadata = await getAmrAggMetadata(api, instance, countries);
    const amrModule = await new GlassModuleDefaultRepository(dataStoreClient).getByName(MODULE).toPromise();
    const changedBy = await getTokenOwner(api);
    // The documents and submissions lists are each one DataStore key, read and written back whole: two writes at
    // once would lose one of them, so every write to them goes through this lock.
    const dataStoreLock = new Semaphore(1);
    const withDataStoreLock = async <T>(write: () => Promise<T>): Promise<T> => {
        await dataStoreLock.acquire();
        try {
            return await write();
        } finally {
            dataStoreLock.release();
        }
    };
    return {
        api,
        app,
        submissions,
        countries,
        metadata,
        moduleId: amrModule.id,
        changedBy,
        withDataStoreLock,
        instanceKey,
        instanceName,
    };
}

type Context = Awaited<ReturnType<typeof loadContext>>;

/** A file the app accepts as RIS or SAMPLE, with country, year and batch from its rows; or why it is left out. */
async function readLocalFile(context: Context, filePath: string): Promise<LocalFile | FileProblem> {
    try {
        const file = await toFile(filePath);
        const risCheck = await context.app.fileSubmission.validatePrimaryFile(file, MODULE).toPromise();
        const sampleCheck = risCheck.isValid
            ? undefined
            : await context.app.fileSubmission.validateSecondaryFile(file, MODULE).toPromise();
        if (!risCheck.isValid && !sampleCheck?.isValid)
            return {
                path: filePath,
                problem: "not a RIS or SAMPLE file the app accepts (the app says Incorrect File Format)",
            };

        const fileType: AmrAggFileType = risCheck.isValid ? "RIS" : "SAMPLE";
        const rows =
            fileType === "RIS"
                ? await new RISDataCSVDefaultRepository().get(file).toPromise()
                : await new SampleDataCSVDeafultRepository().get(file).toPromise();
        const key = keyFromRows(rows);
        if (typeof key === "string") return { path: filePath, problem: key };
        return {
            path: filePath,
            fileType,
            ...key,
            rows: risCheck.isValid ? risCheck.rows : sampleCheck?.rows ?? 0,
            specimens: risCheck.isValid ? risCheck.specimens : [],
        };
    } catch (error) {
        return { path: filePath, problem: `could not be read: ${errorText(error)}` };
    }
}

function verifyCommand(context: Context, batch: BatchToLoad): string {
    const instance = context.instanceName ? ` --instance ${context.instanceName}` : "";
    return (
        `yarn amr-agg-orphans verify${instance} --orgUnits ${batch.orgUnitCode} --years ${batch.year} ` +
        `--batchIds ${batch.batchId}`
    );
}

/** The batch's server steps, each one the use case the app runs at that step. */
function batchOperations(context: Context, batch: BatchToLoad): BatchOperations {
    const { api, app, metadata, moduleId, withDataStoreLock } = context;
    const country = context.countries.find(c => c.code === batch.orgUnitCode);
    const orgUnitId = country?.id ?? "";
    const localFile = (fileType: AmrAggFileType) => {
        const file = fileType === "RIS" ? batch.ris : batch.sample;
        if (!file) throw new Error(`No ${fileType} file in this batch`);
        return file;
    };
    const fileOf = (fileType: AmrAggFileType) => toFile(localFile(fileType).path);
    const storedInBatch = async (fileType: AmrAggFileType) =>
        (await readStoredValues(api, fileType, orgUnitId, batch.year)).filter(
            value => metadata.batchCodeByAoc[fileType].get(value.attributeOptionCombo ?? "") === batch.batchId
        );
    const importFile = async (fileType: AmrAggFileType, dryRun: boolean) => {
        const file = await fileOf(fileType);
        const { orgUnitCode, year, batchId } = batch;
        return fileType === "RIS"
            ? app.fileSubmission
                  .primaryFile(
                      MODULE,
                      file,
                      batchId,
                      year,
                      "CREATE_AND_UPDATE",
                      orgUnitId,
                      "",
                      orgUnitCode,
                      dryRun,
                      "",
                      []
                  )
                  .toPromise()
            : app.fileSubmission
                  .secondaryFile(
                      file,
                      batchId,
                      MODULE,
                      year,
                      "CREATE_AND_UPDATE",
                      orgUnitId,
                      "",
                      orgUnitCode,
                      dryRun,
                      ""
                  )
                  .toPromise();
    };
    const refuse = (reason: string) => ({ refusals: [reason], alreadyThere: [], notes: [] });

    return {
        preflight: async () => {
            if (!country) return refuse(`unknown country code ${batch.orgUnitCode} on this instance`);
            // The app shows the module, and so its uploads, only to a country with an ACTIVE enrolment.
            const enrolment = await retryRead(() => app.glassModules.getByName(orgUnitId, MODULE).toPromise()).then(
                () => undefined,
                error => `${batch.orgUnitCode} cannot upload to AMR in the app: ${errorText(error)}`
            );
            if (enrolment) return refuse(enrolment);
            const existing = await retryRead(() =>
                context.submissions.getSpecificDataSubmission(moduleId, orgUnitId, batch.year).toPromise()
            );
            if (existing.length > 1) return refuse(`${existing.length} submissions for ${batch.year}: fix them first`);
            const [uploads, queued] = await Promise.all([
                retryRead(() =>
                    app.glassUploads.getIncludeSharedByModuleOUPeriod(moduleId, orgUnitId, batch.year).toPromise()
                ),
                retryRead(() => app.glassUploads.getAsyncUploads().toPromise()),
            ]);
            const stored = { RIS: 0, SAMPLE: 0 };
            for (const fileType of fileTypesOf(batch)) stored[fileType] = (await storedInBatch(fileType)).length;
            return checkPreflight({
                batch,
                submissionStatus: existing[0]?.status,
                uploads,
                queuedUploadIds: new Set(queued.map(upload => upload.uploadId)),
                storedInBatch: stored,
                verifyCommand: verifyCommand(context, batch),
            });
        },
        dryRun: fileType => retryRead(() => importFile(fileType, true)),
        ensureSubmission: () =>
            withDataStoreLock(async () => {
                const submission = await app.glassDataSubmission
                    .getSpecificDataSubmission(moduleId, MODULE, orgUnitId, batch.year, false)
                    .toPromise();
                return submission.id;
            }),
        upload: async (fileType, submissionId) => {
            const local = localFile(fileType);
            const file = await fileOf(fileType);
            return withDataStoreLock(() =>
                app.glassDocuments
                    .upload({
                        file,
                        data: {
                            batchId: batch.batchId,
                            fileType,
                            dataSubmission: submissionId,
                            moduleId,
                            moduleName: MODULE,
                            period: batch.year,
                            orgUnitId,
                            orgUnitCode: batch.orgUnitCode,
                            rows: local.rows,
                            specimens: local.specimens,
                        },
                    })
                    .toPromise()
            );
        },
        removeUpload: uploadId => withDataStoreLock(() => app.glassDocuments.deleteByUploadId(uploadId).toPromise()),
        linkSampleToRis: (sampleUploadId, risUploadId) =>
            app.glassDocuments.updateSecondaryFileWithPrimaryId(sampleUploadId, risUploadId).toPromise(),
        saveErrors: ({ RIS, SAMPLE }, summaries) =>
            app.glassUploads
                .saveImportSummaryErrorsOfFiles({
                    primaryUploadId: RIS ?? "",
                    primaryImportSummaryErrors: {
                        nonBlockingErrors: summaries.RIS?.nonBlockingErrors ?? [],
                        blockingErrors: summaries.RIS?.blockingErrors ?? [],
                    },
                    ...(SAMPLE
                        ? {
                              secondaryUploadId: SAMPLE,
                              secondaryImportSummaryErrors: {
                                  nonBlockingErrors: summaries.SAMPLE?.nonBlockingErrors ?? [],
                                  blockingErrors: summaries.SAMPLE?.blockingErrors ?? [],
                              },
                          }
                        : {}),
                })
                .toPromise(),
        setStatus: (id, status) => app.glassUploads.setStatus({ id, status }).toPromise(),
        getStatus: async id => (await retryRead(() => app.glassUploads.getById(id).toPromise())).status,
        realImport: fileType => importFile(fileType, false),
        removeImportedValues: async uploadIds => {
            const glassModule = await app.glassModules.getByName(orgUnitId, MODULE).toPromise();
            for (const [fileType, uploadId] of Object.entries(uploadIds) as [AmrAggFileType, string][]) {
                const upload = await app.glassUploads.getById(uploadId).toPromise();
                const arrayBuffer = await (await fileOf(fileType)).arrayBuffer();
                const summary = await (fileType === "RIS"
                    ? app.fileSubmission.deletePrimaryFile(glassModule, upload, arrayBuffer, false)
                    : app.fileSubmission.deleteSecondaryFile(glassModule, upload, arrayBuffer, false)
                ).toPromise();
                if (summary.status === "ERROR") throw new Error(`the ${fileType} values could not be deleted`);
            }
        },
        storedDifference: async () => {
            const differences: string[] = [];
            for (const fileType of fileTypesOf(batch)) {
                const file = await fileOf(fileType);
                const fileValues =
                    fileType === "RIS"
                        ? mapRISDataToDataValues(
                              await new RISDataCSVDefaultRepository().get(file).toPromise(),
                              metadata.fileMetadata.RIS
                          ).dataValues
                        : mapSampleDataToDataValues(
                              await new SampleDataCSVDeafultRepository().get(file).toPromise(),
                              metadata.fileMetadata.SAMPLE
                          ).dataValues;
                const { matched, missing, different, extra } = compareValues(
                    await storedInBatch(fileType),
                    fileValues,
                    metadata.zeroNotStoredDataElements
                );
                if (missing.length + different.length + extra.length > 0)
                    differences.push(
                        `${fileType}: ${matched} equal, ${missing.length} missing, ${different.length} different, ` +
                            `${extra.length} not in the file`
                    );
            }
            return differences.length > 0 ? differences.join("; ") : undefined;
        },
        storedCount: async () => {
            let count = 0;
            for (const fileType of fileTypesOf(batch)) count += (await storedInBatch(fileType)).length;
            return count;
        },
    };
}

/** Wraps each operation to add up the time it takes, so a run shows where its time goes. */
function timed(ops: BatchOperations, seconds: Record<string, number>): BatchOperations {
    return _.mapValues(ops, (operation: (...args: unknown[]) => Promise<unknown>, name) => {
        return async (...args: unknown[]) => {
            const start = Date.now();
            try {
                return await operation(...args);
            } finally {
                seconds[name] = (seconds[name] ?? 0) + (Date.now() - start) / 1000;
            }
        };
    }) as unknown as BatchOperations;
}

/** Sends a loaded country/year for WHO approval with the app's two steps (dry run: says what it would do). */
async function submitYear(
    context: Context,
    orgUnitCode: string,
    year: string,
    commit: boolean
): Promise<Record<string, string>> {
    const row = { orgUnitCode, year, before: "", after: "", note: "" };
    const orgUnitId = context.countries.find(c => c.code === orgUnitCode)?.id ?? "";
    const read = async () => {
        const [submission, ...others] = await retryRead(() =>
            context.submissions.getSpecificDataSubmission(context.moduleId, orgUnitId, year).toPromise()
        );
        if (!submission || others.length > 0) throw new Error(`${others.length + 1} submissions found, expected one`);
        return submission;
    };
    try {
        if (!commit) {
            // A year with no submission yet gets one (NOT_COMPLETED) at its first upload.
            const status = orgUnitId
                ? (
                      await retryRead(() =>
                          context.submissions.getSpecificDataSubmission(context.moduleId, orgUnitId, year).toPromise()
                      )
                  )[0]?.status ?? "NOT_COMPLETED"
                : "NOT_COMPLETED";
            const transitions = submissionTransitions(status);
            return typeof transitions === "string"
                ? { ...row, before: status, after: status, note: transitions }
                : { ...row, before: status, after: _.last(transitions) ?? status, note: "dry run: would be set" };
        }
        return await context.withDataStoreLock(async () => {
            const submission = await read();
            row.before = submission.status;
            const transitions = submissionTransitions(submission.status);
            if (typeof transitions === "string") return { ...row, after: submission.status, note: transitions };
            for (const target of transitions)
                await context.app.glassDataSubmission.setStatus(submission.id, target, context.changedBy).toPromise();
            const after = (await read()).status;
            const expected = transitions.length > 0 ? "PENDING_APPROVAL" : submission.status;
            return { ...row, after, note: after === expected ? "" : `read back as ${after}, expected ${expected}` };
        });
    } catch (error) {
        return { ...row, note: `not changed: ${errorText(error)}` };
    }
}

const cmd = command({
    name: "amr-agg-bulk-upload",
    description:
        "Upload every AMR aggregate RIS/SAMPLE batch in a folder with the app's own upload steps. " +
        "Dry run unless --commit.",
    args: {
        instance: instanceArg,
        folder: option({ type: string, long: "folder", description: "Folder with the files (read recursively)" }),
        commit: flag({
            type: boolean,
            long: "commit",
            description: "Actually upload. Without it: checks and the app's dry run only, nothing written.",
        }),
        confirmInstance: option({
            type: optional(string),
            long: "confirmInstance",
            description: "Required with --commit: the target instance, e.g. portal-uat.who.int/dhis2-indiv",
        }),
        concurrency: option({
            type: number,
            long: "concurrency",
            defaultValue: () => 1,
            description: "Country/years loaded at the same time (default 1)",
        }),
        outDir: option({ type: string, long: "outDir", defaultValue: () => DEFAULT_OUT_DIR }),
    },
    handler: async args => {
        if (!(Number.isInteger(args.concurrency) && args.concurrency >= 1))
            throw new Error("--concurrency must be a whole number, 1 or more");
        const context = await loadContext(args.instance);
        if (args.commit && args.confirmInstance?.toLowerCase() !== context.instanceKey)
            throw new Error(
                `--commit needs --confirmInstance ${context.instanceKey} (the instance this run targets), ` +
                    `got ${args.confirmInstance ?? "nothing"}`
            );

        const runDir = path.join(
            args.outDir,
            `${context.instanceKey.replace(/\W+/g, "-")}_${new Date().toISOString().replace(/[:.]/g, "-")}`
        );
        mkdirSync(runDir, { recursive: true });
        const resultsFile = path.join(runDir, "results.csv");
        const submissionsFile = path.join(runDir, "submissions.csv");
        const problemsFile = path.join(runDir, "file-problems.csv");
        writeFileSync(resultsFile, csvHeader(RESULT_COLUMNS));
        writeFileSync(submissionsFile, csvHeader(SUBMISSION_COLUMNS));

        const paths = filesUnder(args.folder);
        console.log(`Reading ${paths.length} file(s) under ${args.folder}`);
        const read: (LocalFile | FileProblem)[] = [];
        for (const filePath of paths) read.push(await readLocalFile(context, filePath));
        const fileProblems = read.filter((item): item is FileProblem => "problem" in item);
        const { batches, problems: pairProblems } = pairFiles(
            read.filter((item): item is LocalFile => !("problem" in item))
        );
        const problems = [...fileProblems, ...pairProblems];
        writeFileSync(problemsFile, Papa.unparse(problems, { columns: ["path", "problem"] }) + "\n");
        const years = Object.values(_.groupBy(batches, batch => `${batch.orgUnitCode} ${batch.year}`));
        console.log(
            `${batches.length} batch(es) in ${years.length} country/year(s) to load, ${args.concurrency} at a time; ` +
                `${problems.length} file(s) left out (${problemsFile})`
        );
        console.log(
            args.commit
                ? `=== COMMIT: batches that pass every check WILL be uploaded to ${context.instanceKey}. ===`
                : `=== DRY RUN: checks and the app's dry run only. Nothing is written. ===`
        );

        const outcomes: BatchOutcome[] = [];
        const startedAt = Date.now();
        await promiseMapConcurrent(
            years,
            async yearBatches => {
                const results: BatchOutcome["result"][] = [];
                for (const batch of yearBatches) {
                    const stepSeconds: Record<string, number> = {};
                    const batchStart = Date.now();
                    const outcome = await loadBatch(
                        timed(batchOperations(context, batch), stepSeconds),
                        batch,
                        args.commit
                    ).catch(
                        (error): BatchOutcome => ({
                            result: "FAILED",
                            message: `Stopped: ${errorText(error)}`,
                            nextStep: `Check the batch with ${verifyCommand(context, batch)}`,
                            uploadIds: {},
                            dryRunValues: {},
                        })
                    );
                    outcomes.push(outcome);
                    results.push(outcome.result);
                    appendFileSync(
                        resultsFile,
                        csvLine(
                            {
                                orgUnitCode: batch.orgUnitCode,
                                year: batch.year,
                                batchId: batch.batchId,
                                risFile: batch.ris.path,
                                sampleFile: batch.sample?.path ?? "",
                                result: outcome.result,
                                message: outcome.message,
                                nextStep: outcome.nextStep,
                                risUploadId: outcome.uploadIds.RIS ?? "",
                                sampleUploadId: outcome.uploadIds.SAMPLE ?? "",
                                dryRunValuesRIS: outcome.dryRunValues.RIS ?? "",
                                dryRunValuesSAMPLE: outcome.dryRunValues.SAMPLE ?? "",
                                seconds: Math.round((Date.now() - batchStart) / 1000),
                                stepSeconds: Object.entries(stepSeconds)
                                    .map(([step, value]) => `${step} ${value.toFixed(1)}`)
                                    .join("; "),
                            },
                            RESULT_COLUMNS
                        )
                    );
                    const done = outcomes.length;
                    const minutesLeft = Math.ceil(
                        (((Date.now() - startedAt) / done) * (batches.length - done)) / 60000
                    );
                    console.log(
                        `${describeBatch(batch)}: ${outcome.result}. ${outcome.message}` +
                            (outcome.nextStep ? ` NEXT: ${outcome.nextStep}` : "")
                    );
                    console.log(`done ${done} of ${batches.length}, about ${minutesLeft} min left`);
                }
                const [first] = yearBatches;
                const loaded = args.commit
                    ? results
                    : results.map(result => (result === "WOULD_LOAD" ? "LOADED" : result));
                if (first && readyToSubmit(loaded)) {
                    const row = await submitYear(context, first.orgUnitCode, first.year, args.commit);
                    appendFileSync(submissionsFile, csvLine(row, SUBMISSION_COLUMNS));
                    console.log(
                        `${first.orgUnitCode} ${first.year} submission: ${row.before} -> ${row.after}` +
                            (row.note ? ` (${row.note})` : "")
                    );
                }
            },
            args.concurrency
        );

        const counts = _.countBy(outcomes, outcome => outcome.result);
        console.log(
            `\n${
                Object.entries(counts)
                    .map(([result, count]) => `${result}: ${count}`)
                    .join(", ") || "No batches"
            } in ${Math.round((Date.now() - startedAt) / 1000)} s. Results: ${resultsFile}; submissions: ` +
                submissionsFile
        );
        if (outcomes.some(outcome => outcome.result === "FAILED")) process.exitCode = 1;
    },
});

run(cmd, process.argv.slice(2));
