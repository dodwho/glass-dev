import _ from "lodash";

import { Future } from "../../domain/entities/Future";
import { DataSubmissionStatusTypes } from "../../domain/entities/GlassDataSubmission";
import { canCompleteUpload, GlassUploads, GlassUploadsStatus } from "../../domain/entities/GlassUploads";
import { ImportSummary } from "../../domain/entities/data-entry/ImportSummary";
import { Id } from "../../domain/entities/Ref";
import { importWithImportedStatusFirst } from "../../domain/usecases/data-entry/amr/importWithImportedStatusFirst";
import { AmrAggFileType, toAmrAggFileType } from "./amrAggOrphans";

/*
 * Decisions of the AMR aggregate bulk loader (amr_agg_bulk_upload.ts), kept free of I/O so they can be tested.
 * A batch is loaded with the app's own upload steps, in the app's order: upload records, dry run, IMPORTED first,
 * real import, VALIDATED, COMPLETED; then the year is sent for approval. The loader adds what a person does by eye
 * in the app: it skips a batch that already has data, and completes an upload only once the stored values equal
 * its file.
 */

/** A RIS or SAMPLE file in the folder, with the country, year and batch its rows give. */
export interface LocalFile {
    path: string;
    fileType: AmrAggFileType;
    orgUnitCode: string;
    year: string;
    batchId: string;
    rows: number;
    specimens: string[];
}

export interface BatchToLoad {
    orgUnitCode: string;
    year: string;
    batchId: string;
    ris: LocalFile;
    sample?: LocalFile;
}

export interface FileProblem {
    path: string;
    problem: string;
}

export const describeBatch = (batch: { orgUnitCode: string; year: string; batchId: string }) =>
    `${batch.orgUnitCode} ${batch.year} ${batch.batchId}`;

/**
 * Country, year and batch of a file, read from its rows rather than its name (names on the server vary, e.g.
 * "GLASS-ZAF-2023-DS1-Sample.txt"), so the upload is always labelled as its data is. Every row must agree.
 */
export function keyFromRows(
    rows: { COUNTRY: string; YEAR: number | string; BATCHIDDS: string }[]
): { orgUnitCode: string; year: string; batchId: string } | string {
    if (rows.length === 0) return "the file has no rows";
    const distinct = (values: string[]) => _.uniq(values.map(value => value.trim()));
    const countries = distinct(rows.map(row => row.COUNTRY ?? ""));
    const years = distinct(rows.map(row => String(row.YEAR ?? "")));
    const batches = distinct(rows.map(row => row.BATCHIDDS ?? ""));
    const problems = _.compact([
        countries.length > 1 && `${countries.length} countries (${countries.join(", ")})`,
        years.length > 1 && `${years.length} years (${years.join(", ")})`,
        batches.length > 1 && `${batches.length} batches (${batches.join(", ")})`,
    ]);
    if (problems.length > 0) return `the rows name ${problems.join(", ")}: one file must hold one batch`;

    const [orgUnitCode = "", year = "", batchId = ""] = [countries[0], years[0], batches[0]];
    if (!orgUnitCode || !batchId || !/^\d{4}$/.test(year))
        return `the rows give country "${orgUnitCode}", year "${year}", batch "${batchId}"`;
    return { orgUnitCode, year, batchId };
}

/**
 * One batch per country/year/batch: its RIS file and, if there is one, its SAMPLE file (the app also takes RIS
 * alone). A group that is not exactly one RIS and at most one SAMPLE is left out whole, so nothing is guessed.
 */
export function pairFiles(files: LocalFile[]): { batches: BatchToLoad[]; problems: FileProblem[] } {
    const batches: BatchToLoad[] = [];
    const problems: FileProblem[] = [];
    const groups = _.groupBy(files, file => describeBatch(file));

    for (const label of Object.keys(groups).sort()) {
        const group = groups[label] ?? [];
        const ris = group.filter(file => file.fileType === "RIS");
        const samples = group.filter(file => file.fileType === "SAMPLE");
        const problem =
            ris.length === 0
                ? `SAMPLE file with no RIS file for ${label}: the app uploads a SAMPLE file only with its RIS file`
                : ris.length > 1
                ? `${ris.length} RIS files for ${label}: keep only the right one in the folder`
                : samples.length > 1
                ? `${samples.length} SAMPLE files for ${label}: keep only the right one in the folder`
                : undefined;
        const [risFile] = ris;
        if (problem || !risFile) problems.push(...group.map(file => ({ path: file.path, problem: problem ?? "" })));
        else
            batches.push({
                orgUnitCode: risFile.orgUnitCode,
                year: risFile.year,
                batchId: risFile.batchId,
                ris: risFile,
                sample: samples[0],
            });
    }
    return { batches, problems };
}

/** Submission statuses in which the app lets a user upload (isEditModeStatus). */
export const UPLOAD_ALLOWED_SUBMISSION_STATUSES: DataSubmissionStatusTypes[] = [
    "NOT_COMPLETED",
    "COMPLETE",
    "REJECTED",
    "UPDATE_REQUEST_ACCEPTED",
];

/** Upload statuses at which the app has imported the file: its values may be stored, so it owns them. */
const IMPORTED_STATUSES: GlassUploadsStatus[] = ["IMPORTED", "VALIDATED", "COMPLETED"];

export const fileTypesOf = (batch: BatchToLoad): AmrAggFileType[] => (batch.sample ? ["RIS", "SAMPLE"] : ["RIS"]);

export interface Preflight {
    /** The batch cannot be loaded here (the app would not allow it). */
    refusals: string[];
    /** The batch already has data, or an import of it is queued: nothing is loaded. */
    alreadyThere: string[];
    /** Worth knowing, not blocking. */
    notes: string[];
}

const describeUploads = (uploads: GlassUploads[]) =>
    uploads.map(upload => `${upload.id} ${upload.status} "${upload.fileName}" batch "${upload.batchId}"`).join("; ");

/**
 * What the server says about a batch before anything is written. It is loaded only when the submission is open for
 * uploads and the batch is empty: no value stored under it, and no upload of it beyond UPLOADED in AMR or AMR -
 * Individual (an Individual "SAMPLE File" stores into the same SAMPLE data set), counting uploads with a blank batch,
 * whose file may cover it, and UPLOADED uploads queued for the async import, which will import later. An UPLOADED
 * upload that is not queued was never imported and holds nothing: it stays as it is, as in the app.
 */
export function checkPreflight(params: {
    batch: BatchToLoad;
    /** undefined: no submission yet; the app creates it at the first upload. */
    submissionStatus: DataSubmissionStatusTypes | undefined;
    /** Live uploads of the country and year in AMR and AMR - Individual. */
    uploads: GlassUploads[];
    queuedUploadIds: Set<Id>;
    storedInBatch: Record<AmrAggFileType, number>;
    verifyCommand: string;
}): Preflight {
    const { batch, submissionStatus, uploads, queuedUploadIds, storedInBatch, verifyCommand } = params;
    const preflight: Preflight = { refusals: [], alreadyThere: [], notes: [] };

    if (submissionStatus && !UPLOAD_ALLOWED_SUBMISSION_STATUSES.includes(submissionStatus))
        preflight.refusals.push(
            `the ${batch.year} submission is ${submissionStatus}: the app allows uploads only when it is ` +
                UPLOAD_ALLOWED_SUBMISSION_STATUSES.join(", ")
        );

    for (const fileType of fileTypesOf(batch)) {
        const ofBatch = uploads.filter(
            upload =>
                !upload.deleted &&
                toAmrAggFileType(upload.fileType) === fileType &&
                (upload.batchId === batch.batchId || upload.batchId.trim() === "")
        );
        const owning = ofBatch.filter(
            upload => IMPORTED_STATUSES.includes(upload.status) || queuedUploadIds.has(upload.id)
        );
        const neverImported = ofBatch.filter(upload => !owning.includes(upload));
        if (owning.length > 0)
            preflight.alreadyThere.push(
                `${fileType}: ${owning.length} imported or queued upload(s) (${describeUploads(owning)}): ` +
                    `delete them in the app first if this file replaces them`
            );
        if (storedInBatch[fileType] > 0)
            preflight.alreadyThere.push(
                `${fileType}: ${storedInBatch[fileType]} value(s) already stored under ${batch.batchId}: ` +
                    `check them with ${verifyCommand}`
            );
        if (neverImported.length > 0)
            preflight.notes.push(
                `${fileType}: ${neverImported.length} earlier upload(s) never imported, left as they are ` +
                    `(${describeUploads(neverImported)})`
            );
    }
    return preflight;
}

export type SubmissionTransition = "COMPLETE" | "PENDING_APPROVAL";

/**
 * The app's steps from a submission's status to "waiting for WHO approval" once its data is loaded: COMPLETE (data
 * complete for the country), then "Send submission" (offered from COMPLETE and UPDATE_REQUEST_ACCEPTED). A REJECTED
 * or PENDING_UPDATE_APPROVAL year carries a WHO decision, so a person moves it on (as the AMU loader does).
 */
export function submissionTransitions(status: DataSubmissionStatusTypes): SubmissionTransition[] | string {
    switch (status) {
        case "NOT_COMPLETED":
            return ["COMPLETE", "PENDING_APPROVAL"];
        case "COMPLETE":
        case "UPDATE_REQUEST_ACCEPTED":
            return ["PENDING_APPROVAL"];
        case "PENDING_APPROVAL":
        case "APPROVED":
            return [];
        default:
            return `the submission is ${status}, a WHO decision: a person sends it on`;
    }
}

export type BatchResult = "REFUSED" | "SKIPPED" | "WOULD_LOAD" | "LOADED" | "FAILED";

/**
 * A country/year is sent for WHO approval once at least one of its batches was loaded and none failed or was refused.
 * A skipped batch already had its data, so it does not hold the year back: a re-run after a fix completes the year.
 */
export const readyToSubmit = (results: BatchResult[]) =>
    results.includes("LOADED") && !results.some(result => result === "FAILED" || result === "REFUSED");

export interface BatchOutcome {
    result: BatchResult;
    message: string;
    /** What a person must do now; empty when nothing. */
    nextStep: string;
    uploadIds: Partial<Record<AmrAggFileType, Id>>;
    /** Values the dry run would import or update, per file type. */
    dryRunValues: Partial<Record<AmrAggFileType, number>>;
}

export type FileSummaries = Partial<Record<AmrAggFileType, ImportSummary>>;

/** The server steps of one batch, implemented by the script with the app's own use cases. */
export interface BatchOperations {
    preflight(): Promise<Preflight>;
    dryRun(fileType: AmrAggFileType): Promise<ImportSummary>;
    /** The submission's id; created as the app does if there is none. */
    ensureSubmission(): Promise<Id>;
    upload(fileType: AmrAggFileType, submissionId: Id): Promise<Id>;
    /** Deletes an upload record and its document; only for uploads that hold no values. */
    removeUpload(uploadId: Id): Promise<void>;
    linkSampleToRis(sampleUploadId: Id, risUploadId: Id): Promise<void>;
    saveErrors(uploadIds: Partial<Record<AmrAggFileType, Id>>, summaries: FileSummaries): Promise<void>;
    setStatus(uploadId: Id, status: GlassUploadsStatus): Promise<void>;
    getStatus(uploadId: Id): Promise<GlassUploadsStatus>;
    realImport(fileType: AmrAggFileType): Promise<ImportSummary>;
    /** The app's delete of these uploads' values (only the values their files map to). */
    removeImportedValues(uploadIds: Partial<Record<AmrAggFileType, Id>>): Promise<void>;
    /** How the stored values of the batch differ from the files, or undefined when they are equal. */
    storedDifference(): Promise<string | undefined>;
    /** Values stored under the batch in the data sets of its files. */
    storedCount(): Promise<number>;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function describeErrors(summary: ImportSummary): string {
    const errors = summary.blockingErrors;
    const shown = errors.slice(0, 5).map(error => `${error.error} (${error.count})`);
    return shown.join("; ") + (errors.length > 5 ? `; and ${errors.length - 5} more` : "");
}

const importedOrUpdated = (summary: ImportSummary) => summary.importCount.imported + summary.importCount.updated;

/**
 * Loads one batch, RIS and SAMPLE together: if either file has an error the app blocks, nothing of the batch stays.
 * Without commit it stops after the dry run and writes nothing. An import that finished with errors, or whose stored
 * values differ from the files, is rolled back (the app's delete, then the upload records) once a read-back shows
 * nothing left. Only an import that stopped part-way keeps its uploads IMPORTED, because DHIS2 may still be writing
 * it (decision 25 Oct): the app's delete of an IMPORTED upload removes those values later.
 */
export async function loadBatch(ops: BatchOperations, batch: BatchToLoad, commit: boolean): Promise<BatchOutcome> {
    const outcome: BatchOutcome = { result: "FAILED", message: "", nextStep: "", uploadIds: {}, dryRunValues: {} };
    const finish = (result: BatchResult, message: string, nextStep = "") =>
        Object.assign(outcome, { result, message, nextStep });
    const fileTypes = fileTypesOf(batch);

    const preflight = await ops.preflight();
    const noteText = preflight.notes.length > 0 ? ` Note: ${preflight.notes.join(" | ")}.` : "";
    // A batch already there is skipped even in a year now closed (a re-run after the year was sent on).
    if (preflight.alreadyThere.length > 0)
        return finish("SKIPPED", [...preflight.alreadyThere, ...preflight.refusals].join(" | "));
    if (preflight.refusals.length > 0) return finish("REFUSED", preflight.refusals.join(" | "));

    // The dry runs write nothing, so both files are checked at once, as in the app.
    const dryRunList = await Promise.all(fileTypes.map(fileType => ops.dryRun(fileType)));
    const dryRuns: FileSummaries = _.zipObject(fileTypes, dryRunList);
    fileTypes.forEach((fileType, index) => {
        const summary = dryRunList[index];
        if (summary) outcome.dryRunValues[fileType] = importedOrUpdated(summary);
    });
    const invalid = fileTypes.filter(fileType => (dryRuns[fileType]?.blockingErrors.length ?? 0) > 0);
    if (invalid.length > 0)
        return finish(
            "REFUSED",
            "Errors the app blocks, so the batch is not loaded: " +
                invalid
                    .map(fileType => `${fileType}: ${describeErrors(dryRuns[fileType] as ImportSummary)}`)
                    .join(" | ")
        );
    const warnings = fileTypes.flatMap(fileType => dryRuns[fileType]?.nonBlockingErrors ?? []);
    const warningText = warnings.length > 0 ? ` ${warnings.length} warning(s) the app also allows.` : "";
    if (!commit) return finish("WOULD_LOAD", `Dry run clean.${warningText}${noteText}`);

    const removeUploads = async (reason: string) => {
        const left: string[] = [];
        for (const uploadId of Object.values(outcome.uploadIds))
            await ops.removeUpload(uploadId).catch(error => left.push(`${uploadId} (${errorText(error)})`));
        return left.length === 0
            ? finish("FAILED", `${reason} The upload records were removed; nothing of the batch is left.`)
            : finish(
                  "FAILED",
                  `${reason} These upload records could not be removed: ${left.join("; ")}.`,
                  "Delete those uploads in the app (Data File History), then load the batch again."
              );
    };
    const leftImported = "Delete these uploads in the app (Data File History): that removes their values.";
    const rollBack = async (reason: string) => {
        const problem = await ops
            .removeImportedValues(outcome.uploadIds)
            .then(() => ops.storedCount())
            .then(
                left => (left === 0 ? "" : `${left} value(s) are still stored after the delete`),
                error => `the values could not be deleted (${errorText(error)})`
            );
        return problem === ""
            ? removeUploads(`${reason} The values were deleted again.`)
            : finish("FAILED", `${reason} ${problem}; the uploads stay IMPORTED.`, leftImported);
    };

    // Upload records first, as in the app: values are never written without an upload that owns them.
    try {
        const submissionId = await ops.ensureSubmission();
        for (const fileType of fileTypes) outcome.uploadIds[fileType] = await ops.upload(fileType, submissionId);
        const { RIS: risUploadId, SAMPLE: sampleUploadId } = outcome.uploadIds;
        if (sampleUploadId && risUploadId) await ops.linkSampleToRis(sampleUploadId, risUploadId);
    } catch (error) {
        return removeUploads(`Saving the upload records failed: ${errorText(error)}. Nothing was imported.`);
    }
    // The app saves the dry-run errors too; a failure there is only reported, as in the app.
    const notSaved: string[] = [];
    await ops.saveErrors(outcome.uploadIds, dryRuns).catch(error => notSaved.push(errorText(error)));

    const uploadIds = Object.values(outcome.uploadIds);
    const imported = await importWithImportedStatusFirst<FileSummaries>({
        uploadIds,
        // Deferred: fromPromise starts at once, and the status writes must run one after the other.
        setStatus: (id, status) =>
            Future.success<void, string>(undefined).flatMap(() => Future.fromPromise(ops.setStatus(id, status))),
        // One file after the other: if RIS fails, SAMPLE is never sent.
        runImport: () =>
            Future.fromPromise(
                (async () => {
                    const summaries: FileSummaries = {};
                    for (const fileType of fileTypes) summaries[fileType] = await ops.realImport(fileType);
                    return summaries;
                })()
            ),
        removeImportedValues: () => Future.fromPromise(ops.removeImportedValues(outcome.uploadIds)),
    })
        .toPromise()
        .then(summaries => ({ ok: true as const, summaries }))
        .catch((failure: { error: string; dataMayRemain: boolean }) => ({ ok: false as const, failure }));

    if (!imported.ok) {
        const { error, dataMayRemain } = imported.failure;
        if (!dataMayRemain) return removeUploads(`The import could not start: ${error}. Nothing was imported.`);
        return finish(
            "FAILED",
            `The import stopped: ${error}. The values written were deleted again, and the uploads stay IMPORTED in ` +
                `case DHIS2 went on writing.`,
            leftImported
        );
    }

    const { summaries } = imported;
    await ops.saveErrors(outcome.uploadIds, summaries).catch(error => notSaved.push(errorText(error)));
    const notSavedText = notSaved.length > 0 ? ` The error list could not be saved: ${notSaved.join("; ")}.` : "";

    const withErrors = fileTypes.filter(fileType => (summaries[fileType]?.blockingErrors.length ?? 0) > 0);
    if (withErrors.length > 0)
        return rollBack(
            "The import reported errors the app blocks (e.g. DHIS2 validation rules): " +
                withErrors
                    .map(fileType => `${fileType}: ${describeErrors(summaries[fileType] as ImportSummary)}`)
                    .join(" | ") +
                "."
        );

    const difference = await ops.storedDifference().catch(error => `could not be read back (${errorText(error)})`);
    if (difference) return rollBack(`Stored values are not the files' values: ${difference}.`);

    try {
        for (const uploadId of uploadIds) await ops.setStatus(uploadId, "VALIDATED");
        // The app completes an upload only from VALIDATED (canCompleteUpload), read back from the server.
        for (const uploadId of uploadIds) {
            const status = await ops.getStatus(uploadId);
            if (!canCompleteUpload(status)) throw new Error(`upload ${uploadId} is ${status}, not VALIDATED`);
            await ops.setStatus(uploadId, "COMPLETED");
        }
    } catch (error) {
        return finish(
            "FAILED",
            `The data is stored and equals the files, but the status could not be set: ${errorText(error)}.`,
            `${leftImported} Then load the batch again.`
        );
    }
    const values = fileTypes.map(fileType => `${fileType} ${importedOrUpdated(summaries[fileType] as ImportSummary)}`);
    return finish(
        "LOADED",
        `Imported and checked (${values.join(", ")} values); uploads COMPLETED.${warningText}${notSavedText}${noteText}`
    );
}
