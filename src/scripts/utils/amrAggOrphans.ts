/**
 * Orphaned AMR aggregate data: values stored in the RIS or SAMPLE data set for a country/year/batch that no live
 * upload accounts for. Pure helpers for amr_agg_orphans.ts, kept here so the decisions that gate a delete are tested.
 */
import Papa from "papaparse";

export const AMR_AGG_FILE_TYPES = ["RIS", "SAMPLE"] as const;
export type AmrAggFileType = typeof AMR_AGG_FILE_TYPES[number];

/**
 * The AMR aggregate data set an upload's file is stored in. AMR - Individual's "SAMPLE File" goes into the same SAMPLE
 * data set as AMR's SAMPLE (GNB 2025 on PROD was deleted as an orphan because this was missed); its RIS goes to the
 * tracker, so it has none.
 */
export function toAmrAggFileType(uploadFileType: string): AmrAggFileType | undefined {
    const fileType = uploadFileType.trim().toUpperCase();
    if (fileType === "RIS") return "RIS";
    if (fileType === "SAMPLE" || fileType === "SAMPLE FILE") return "SAMPLE";
    return undefined;
}

export interface UploadRecord {
    id: string;
    orgUnitId: string;
    year: string;
    fileType: string;
    /** Empty on a few old uploads; such an upload is taken to cover every batch. */
    batchId: string;
    status: string;
    deleted: boolean;
    /** The upload date data element: the original date, kept when records were migrated (createdAt was not). */
    uploadDate: string;
    /** When the upload record was created; 2026-02-17 for records the migration made. */
    createdAt: string;
    /** The stored file (document id) the upload imported. */
    fileId: string;
    /** Who asked for the deletion and why, when the upload was deleted through the app since 1.6.45. */
    deletionRequestedBy: string;
    deletionReason: string;
}

export interface StoredBatch {
    orgUnitId: string;
    orgUnitCode: string;
    year: string;
    fileType: AmrAggFileType;
    batchId: string;
    dataValues: number;
    /** Latest lastUpdated among the batch's values: when anything last wrote to it. */
    lastUpdated: string;
}

type BatchKey = Pick<StoredBatch, "orgUnitId" | "year" | "fileType" | "batchId" | "lastUpdated">;

export interface Orphan extends StoredBatch {
    deletedUploadIds: string[];
    /** Live uploads of the batch still at UPLOADED: not imported, so they do not own the values. */
    uploadedUploadIds: string[];
}

export interface DeleteTarget {
    orgUnitCode: string;
    year: string;
    fileType: AmrAggFileType;
    batchId: string;
}

interface CategoryComboWithOptions {
    categories: { code: string; categoryOptions: { id: string; code: string }[] }[];
    categoryOptionCombos: { id: string; categoryOptions: { id: string }[] }[];
}

/**
 * Batch code of every attribute option combo, read from the combo's batch category option rather than matched as
 * text, so DS1 can never pick up a DS10 or any other option whose code merely starts with DS1. A combo with no batch
 * option is left out: it is stale, from before the batch category was added (DEV keeps one from 2022), no import can
 * write to it, and its values are reported as outside every batch rather than guessed into one.
 */
export function getBatchCodeByAoc(combo: CategoryComboWithOptions, batchCategoryCode: string): Map<string, string> {
    const batchCategories = combo.categories.filter(category => category.code === batchCategoryCode);
    const batchCategory = batchCategories[0];
    if (!batchCategory || batchCategories.length > 1)
        throw new Error(`Expected one ${batchCategoryCode} category in the combo, found ${batchCategories.length}`);

    const codeByOptionId = new Map(batchCategory.categoryOptions.map(option => [option.id, option.code]));

    return new Map(
        combo.categoryOptionCombos.flatMap(aoc => {
            const codes = aoc.categoryOptions.flatMap(option => codeByOptionId.get(option.id) ?? []);
            const code = codes[0];
            if (!code) return [];
            if (codes.length > 1)
                throw new Error(`Attribute option combo ${aoc.id} has ${codes.length} ${batchCategoryCode} options`);
            return [[aoc.id, code] as const];
        })
    );
}

/**
 * The attribute option combo with the same pathogen/antibiotic (every non-batch option) as `aoc` but another batch:
 * where a value labelled with one batch would sit under another. Undefined when there is none.
 */
export function getAocTranslator(
    combo: CategoryComboWithOptions,
    batchCategoryCode: string
): (aoc: string, batchCode: string) => string | undefined {
    const batchByAoc = getBatchCodeByAoc(combo, batchCategoryCode);
    const batchOptionIds = new Set(
        combo.categories
            .filter(category => category.code === batchCategoryCode)
            .flatMap(category => category.categoryOptions.map(option => option.id))
    );
    const restByAoc = new Map(
        combo.categoryOptionCombos.map(aoc => [
            aoc.id,
            aoc.categoryOptions
                .map(option => option.id)
                .filter(id => !batchOptionIds.has(id))
                .sort()
                .join(","),
        ])
    );
    const aocByRestAndBatch = new Map(
        combo.categoryOptionCombos.map(aoc => [`${restByAoc.get(aoc.id)}|${batchByAoc.get(aoc.id)}`, aoc.id])
    );
    return (aoc, batchCode) => {
        const rest = restByAoc.get(aoc);
        return rest === undefined ? undefined : aocByRestAndBatch.get(`${rest}|${batchCode}`);
    };
}

/** Where a file row's values are stored: the country, year and batch the row names. */
export interface RowLabel {
    orgUnitId: string;
    year: string;
    batchId: string;
}

/**
 * A file's values grouped by the country/year/batch their rows name, keeping only the groups other than the upload's
 * own (any batch counts as its own for a blank-batch upload). The import stores each value where its row says.
 */
export function findForeignLabels<Value extends { orgUnit: string; period: string }>(
    upload: UploadRecord,
    values: Value[],
    batchOf: (value: Value) => string
): { label: RowLabel; values: Value[] }[] {
    const groups = new Map<string, { label: RowLabel; values: Value[] }>();
    for (const value of values) {
        const label = { orgUnitId: value.orgUnit, year: value.period, batchId: batchOf(value) };
        const isOwn =
            label.orgUnitId === upload.orgUnitId &&
            label.year === upload.year &&
            (upload.batchId === "" || label.batchId === upload.batchId);
        if (isOwn) continue;
        const key = `${label.orgUnitId}|${label.year}|${label.batchId}`;
        const group = groups.get(key) ?? { label, values: [] };
        group.values.push(value);
        groups.set(key, group);
    }
    return [...groups.values()];
}

/** What is stored for one group of a file's rows labelled with another country, year or batch than its upload. */
export interface MislabelFinding {
    fileValues: number;
    /** Values stored under the rows' label, equal to the file. */
    storedThere: number;
    /** Values stored under the rows' label with another value than the file. */
    differentThere: number;
    /** The same values, equal, also stored under the upload's own country/year/batch. */
    copyInOwnPlace: number;
    /** Other imported uploads whose files put values in the same cells under the rows' label. */
    sharedWith: { uploadId: string; cells: number; differentValues: number }[];
}

/**
 * The finding in plain words and the way to fix it; `own` and `there` name the two places, e.g. "GBR 2024 DS2".
 * An upload still at UPLOADED was refused by the app for exactly these rows, so it is normally nothing to fix.
 */
export function explainMislabel(
    finding: MislabelFinding,
    own: string,
    there: string,
    imported: boolean
): { finding: string; fix: string } {
    const { fileValues, storedThere, differentThere, copyInOwnPlace, sharedWith } = finding;
    if (!imported) {
        const unexplained = storedThere > 0 && sharedWith.length === 0;
        return {
            finding:
                "never imported: the app refuses a file whose rows name another batch, year or country than the upload" +
                (unexplained
                    ? `; yet ${storedThere} values equal to its rows are stored under ${there} and no imported ` +
                      "upload's file has them, so this upload probably wrote them with its status left at UPLOADED"
                    : ""),
            fix: unexplained
                ? `verify decides the values under ${there} (no imported upload: deletable after the waiting period)`
                : "nothing in the data; if the country still means to submit it, they upload a corrected file",
        };
    }
    const parts = [
        storedThere === 0
            ? `its ${fileValues} values are not stored under ${there}`
            : copyInOwnPlace >= storedThere
            ? `stored twice: ${storedThere} values under ${own} and the same again under ${there}, so totals over both count them double`
            : copyInOwnPlace > 0
            ? `${storedThere} values stored under ${there}; ${copyInOwnPlace} of them also under ${own}`
            : `${storedThere} values stored only under ${there}, none under ${own}`,
    ];
    if (differentThere > 0) parts.push(`${differentThere} cells under ${there} hold another value than the file`);
    for (const shared of sharedWith)
        parts.push(
            `${shared.cells} of its cells under ${there} are also in upload ${shared.uploadId}'s file` +
                (shared.differentValues > 0
                    ? `, ${shared.differentValues} with another value: one upload overwrote the other`
                    : "")
        );
    parts.push(`deleting this upload in the app would delete values under ${there}, not under ${own}`);

    const overwritten = sharedWith.some(shared => shared.differentValues > 0);
    const fix =
        (overwritten ? "First find out which upload's values are right, as one overwrote the other. " : "") +
        `Ask the country whether ${own} or ${there} is right. Then delete the copy under the wrong label (with a ` +
        "backup), re-import under the right label if the data is not there, and make the upload's record and its " +
        "stored file agree, so that deleting it in the app removes the right values.";
    return { finding: parts.join("; "), fix };
}

function covers(upload: UploadRecord, batch: BatchKey): boolean {
    return (
        upload.orgUnitId === batch.orgUnitId &&
        upload.year === batch.year &&
        upload.fileType === batch.fileType &&
        (upload.batchId === "" || upload.batchId === batch.batchId)
    );
}

const DAY_MS = 24 * 60 * 60 * 1000;
// A day's margin absorbs any time zone difference between the upload date and data value timestamps.
const TIME_ZONE_MARGIN_MS = DAY_MS;
/**
 * Nothing is deleted while an UPLOADED upload of the country/year/file type, or the values in question, are newer
 * than this: an import may still be under way (decision 24 Oct 2026).
 */
export const WAITING_PERIOD_DAYS = 14;

function toTime(timestamp: string): number {
    const time = Date.parse(timestamp);
    if (Number.isNaN(time)) throw new Error(`Unreadable timestamp "${timestamp}"`);
    return time;
}

/** When the upload was made: its upload date, else when its record was created ("" if neither is known). */
export const uploadedAt = (upload: UploadRecord) => upload.uploadDate || upload.createdAt;

const isImported = (upload: UploadRecord) => upload.status !== "UPLOADED";

/**
 * Splits a country's live uploads for a batch. `owners` cover the batch and are past UPLOADED: only they make values
 * belong. `attempts` cover it but are still at UPLOADED: never imported as far as the app shows, so evidence only.
 * `others` are the country's live uploads of the same file type for other batches or years: their files may still
 * label rows with this batch and year.
 */
export function classifyLiveUploads(
    uploads: UploadRecord[],
    batch: BatchKey
): { owners: UploadRecord[]; attempts: UploadRecord[]; others: UploadRecord[] } {
    const live = uploads.filter(
        upload => !upload.deleted && upload.orgUnitId === batch.orgUnitId && upload.fileType === batch.fileType
    );
    const covering = live.filter(upload => covers(upload, batch));
    return {
        owners: covering.filter(isImported),
        attempts: covering.filter(upload => !isImported(upload)),
        others: live.filter(upload => !covers(upload, batch)),
    };
}

/** Batches with stored values but no imported upload: candidates only, as no file is read. */
export function findOrphans(stored: StoredBatch[], uploads: UploadRecord[]): Orphan[] {
    return stored
        .filter(batch => batch.dataValues > 0)
        .flatMap(batch => {
            const { owners, attempts } = classifyLiveUploads(uploads, batch);
            if (owners.length > 0) return [];
            const deleted = uploads.filter(upload => upload.deleted && covers(upload, batch));
            return [{ ...batch, deletedUploadIds: deleted.map(u => u.id), uploadedUploadIds: attempts.map(u => u.id) }];
        })
        .sort(
            (a, b) =>
                a.year.localeCompare(b.year) ||
                a.orgUnitCode.localeCompare(b.orgUnitCode) ||
                a.fileType.localeCompare(b.fileType) ||
                a.batchId.localeCompare(b.batchId)
        );
}

export interface ComparableValue {
    dataElement: string;
    categoryOptionCombo?: string;
    attributeOptionCombo?: string;
    value: string;
}

export interface ValueComparison<Stored extends ComparableValue> {
    matched: number;
    /** Stored, but the file does not put a value there. */
    extra: Stored[];
    /** The file puts a value there, but nothing is stored. */
    missing: ComparableValue[];
    different: { stored: Stored; expected: ComparableValue }[];
}

export const valueKey = (value: ComparableValue) =>
    `${value.dataElement}|${value.categoryOptionCombo ?? ""}|${value.attributeOptionCombo ?? ""}`;

const isNumber = (value: string) => value.trim() !== "" && !Number.isNaN(Number(value));

function sameValue(a: string, b: string): boolean {
    return a === b || (isNumber(a) && isNumber(b) && Number(a) === Number(b));
}

/**
 * Stored values against what importing the file leaves stored: the last value per data element and combos (the
 * import applies rows in order), and nothing for a blank. A 0 on a data element whose zeros DHIS2 does not store
 * today (zeroIsSignificant off, as on the SAMPLE counts) may be stored or not: such zeros were kept when the
 * setting was on, so either way it matches.
 */
export function compareValues<Stored extends ComparableValue>(
    stored: Stored[],
    expected: ComparableValue[],
    zeroNotStoredDataElements: Set<string>
): ValueComparison<Stored> {
    const expectedByKey = new Map(expected.map(value => [valueKey(value), value]));
    for (const [key, value] of expectedByKey) if (value.value === "") expectedByKey.delete(key);
    const mayBeAbsent = (value: ComparableValue) =>
        zeroNotStoredDataElements.has(value.dataElement) && sameValue(value.value, "0");

    const comparison: ValueComparison<Stored> = { matched: 0, extra: [], missing: [], different: [] };
    const storedKeys = new Set<string>();
    for (const value of stored) {
        const key = valueKey(value);
        storedKeys.add(key);
        const expectedValue = expectedByKey.get(key);
        if (!expectedValue) comparison.extra.push(value);
        else if (sameValue(value.value, expectedValue.value)) comparison.matched++;
        else comparison.different.push({ stored: value, expected: expectedValue });
    }
    for (const [key, value] of expectedByKey)
        if (!storedKeys.has(key) && !mayBeAbsent(value)) comparison.missing.push(value);
    return comparison;
}

export const VERDICTS = {
    MATCH: "stored values are exactly the imported upload's file",
    LEFTOVER_VALUES:
        "values in a submitted batch that no imported upload's file has: leftovers (deletable, only those)",
    ORPHAN: "values that no imported upload's file has (deletable, whole batch)",
    OTHER_UPLOAD_VALUES:
        "values another imported upload's file put here, its rows labelled with this batch or year (not its own)",
    UNEXPLAINED_RECENT_VALUES:
        "values the imported upload's file lacks, written on or after that upload (or its date is unknown), so not provably leftovers",
    WAITING: `an UPLOADED upload or the values are less than ${WAITING_PERIOD_DAYS} days old: an import may be under way`,
    MISMATCH: "file values missing from DHIS2 or with a different value",
    DUPLICATE_IMPORTS: "two or more imported uploads for the same batch",
    IMPORTED_WITH_DATA: "values under an upload at IMPORTED (blocking errors)",
    SUBMITTED_WITHOUT_DATA: "the upload says imported, but its file's values are not stored",
    NOT_IMPORTED: "only UPLOADED uploads and nothing stored (as expected)",
    FILE_UNREADABLE: "a file needed for the check could not be read: nothing decided",
    OTHER_STATUS: "the owning upload has an unexpected status",
    READ_FAILED: "the stored values could not be read after several tries: nothing decided",
} as const;

export type Verdict = keyof typeof VERDICTS;

/** The only verdicts under which delete removes anything. */
export const DELETABLE_VERDICTS: Verdict[] = ["ORPHAN", "LEFTOVER_VALUES"];

/** Verdicts with nothing to do: the data is as the uploads say. */
export const QUIET_VERDICTS: Verdict[] = ["MATCH", "NOT_IMPORTED"];

/** What a person should do about each verdict that is neither deletable nor quiet. */
export const NEXT_STEPS: Partial<Record<Verdict, string>> = {
    OTHER_UPLOAD_VALUES: "a file labels its rows with another batch or year: see the label audit (`labels`)",
    UNEXPLAINED_RECENT_VALUES: "ask the country which values are right, then re-import the right file",
    WAITING: `run again after ${WAITING_PERIOD_DAYS} days`,
    MISMATCH: "re-import the upload's file (or ask the country)",
    DUPLICATE_IMPORTS:
        "do not delete either upload in the app (its delete also removes the values the other one holds): " +
        "remove only the surplus upload record, then run verify again",
    IMPORTED_WITH_DATA: "delete the upload in the app (it removes its values with it)",
    SUBMITTED_WITHOUT_DATA: "re-import the upload's file: its data is not stored",
    FILE_UNREADABLE: "run again; if it persists, the stored file is missing on this instance",
    OTHER_STATUS: "check the upload's status in the app",
    READ_FAILED: "run again for this country/year/file type",
};

export interface FileMatch {
    upload: UploadRecord;
    result: "unreadable" | { matched: number; extra: number; missing: number; different: number };
}

export interface BatchJudgement<Stored extends ComparableValue> {
    verdict: Verdict;
    /** The upload whose file the batch was compared with, when there is one. */
    owner?: UploadRecord;
    comparison?: ValueComparison<Stored>;
    /** Every file compared, for the evidence report. */
    fileMatches: FileMatch[];
    /** The only values a delete may remove: none unless the verdict is in DELETABLE_VERDICTS. */
    deletable: Stored[];
}

const IMPORTED_STATUSES = ["IMPORTED", "VALIDATED", "COMPLETED"];

/** An upload of this year whose data may be stored: not deleted, and IMPORTED, VALIDATED or COMPLETED. */
export const isLiveUpload = (upload: UploadRecord, year: string) =>
    !upload.deleted && upload.year === year && IMPORTED_STATUSES.includes(upload.status);

/**
 * The values about to be deleted that a live upload's file maps to. Ownership is decided by the files' rows, not by the
 * batch or module on the upload records: on 24 Oct GNB 2025 SAMPLE DS1 was deleted on PROD as an orphan although it
 * was the data of a COMPLETED AMR - Individual upload whose record named DS2 while its rows said DS1.
 */
export function valuesHeldByLiveFiles<Value extends ComparableValue>(
    values: Value[],
    liveFileValues: ComparableValue[][]
): Value[] {
    const held = new Set(liveFileValues.flat().map(valueKey));
    return values.filter(value => held.has(valueKey(value)));
}

/**
 * The verdict on one country/year/file type/batch. `owners`, `attempts` and `otherUploads` are classifyLiveUploads'
 * lists. `getFile` gives what an upload's file maps to for this batch and year, or "unreadable"; files are read only
 * when the verdict needs them. A value belongs only if an imported upload's file puts it there, under whatever batch
 * or year label; values with no such file are deletable once nothing about them is newer than the waiting period.
 */
export async function judgeBatch<Stored extends ComparableValue & { created?: string; lastUpdated?: string }>(input: {
    year: string;
    stored: Stored[];
    owners: UploadRecord[];
    attempts: UploadRecord[];
    otherUploads: UploadRecord[];
    getFile: (upload: UploadRecord) => Promise<ComparableValue[] | "unreadable">;
    zeroNotStoredDataElements: Set<string>;
    /** Now, in ms: the waiting period counts back from it. */
    now: number;
    /** Days to wait after an UPLOADED upload or a write (default WAITING_PERIOD_DAYS); lowered only by a person's decision. */
    waitingDays?: number;
}): Promise<BatchJudgement<Stored>> {
    const { year, stored, owners, attempts, otherUploads, getFile, zeroNotStoredDataElements, now } = input;
    const waitingDays = input.waitingDays ?? WAITING_PERIOD_DAYS;
    const hasData = stored.length > 0;
    const fileMatches: FileMatch[] = [];

    const compareWith = async (upload: UploadRecord) => {
        const file = await getFile(upload);
        const comparison = file === "unreadable" ? undefined : compareValues(stored, file, zeroNotStoredDataElements);
        fileMatches.push({
            upload,
            result: comparison
                ? {
                      matched: comparison.matched,
                      extra: comparison.extra.length,
                      missing: comparison.missing.length,
                      different: comparison.different.length,
                  }
                : "unreadable",
        });
        return { file, comparison };
    };
    const judged = (verdict: Verdict, extra: Partial<BatchJudgement<Stored>> = {}): BatchJudgement<Stored> => ({
        verdict,
        fileMatches,
        deletable: [],
        ...extra,
    });

    const explains = (values: Stored[], file: ComparableValue[]) => {
        const explained = compareValues(values, file, zeroNotStoredDataElements);
        return explained.matched > 0 || explained.different.length > 0;
    };
    // A file can label its rows with a batch other than its upload's (GBR 2024: the DS2 upload's rows say DS3) or,
    // before the app checked it in March 2023, another year. Values another imported upload's file has, or may
    // have, are never deletable.
    const otherUploadVerdict = async (values: Stored[]): Promise<Verdict | undefined> => {
        for (const other of otherUploads.filter(isImported)) {
            const file = await getFile(other);
            if (file === "unreadable" || explains(values, file)) {
                await compareWith(other);
                return file === "unreadable" ? "FILE_UNREADABLE" : "OTHER_UPLOAD_VALUES";
            }
        }
        return undefined;
    };
    // An upload being imported sits at UPLOADED while its values are written, so recent ones hold off any delete.
    const waitingSince = now - waitingDays * DAY_MS;
    const isRecent = (timestamp: string | undefined) => !timestamp || toTime(timestamp) > waitingSince;
    const isWaiting = (values: Stored[]) =>
        [...attempts, ...otherUploads.filter(u => !isImported(u) && u.year === year)].some(u =>
            isRecent(uploadedAt(u))
        ) || values.some(value => isRecent(value.lastUpdated));
    // Documented only: which not-imported uploads hold the same data (the country can import them again), the
    // batch's own attempts and any other batch's or year's whose rows name this one (STP 2023: DS2 upload, rows DS1).
    const compareAttempts = async (values: Stored[]) => {
        for (const attempt of attempts) await compareWith(attempt);
        for (const other of otherUploads.filter(u => !isImported(u))) {
            const file = await getFile(other);
            if (file !== "unreadable" && explains(values, file)) await compareWith(other);
        }
    };

    if (owners.length === 0) {
        if (!hasData) return judged("NOT_IMPORTED");
        const otherVerdict = await otherUploadVerdict(stored);
        if (otherVerdict) return judged(otherVerdict);
        if (isWaiting(stored)) return judged("WAITING");
        await compareAttempts(stored);
        return judged("ORPHAN", { deletable: stored });
    }
    if (owners.length > 1) {
        for (const upload of owners) await compareWith(upload);
        return judged("DUPLICATE_IMPORTS");
    }

    const owner = owners[0] as UploadRecord;
    const { comparison } = await compareWith(owner);
    if (!comparison) return judged("FILE_UNREADABLE", { owner });
    const flagged = (verdict: Verdict) => judged(verdict, { owner, comparison });

    if (!IMPORTED_STATUSES.includes(owner.status)) return flagged("OTHER_STATUS");
    if (owner.status === "IMPORTED") return flagged(hasData ? "IMPORTED_WITH_DATA" : "SUBMITTED_WITHOUT_DATA");
    if (!hasData) return flagged(comparison.missing.length > 0 ? "SUBMITTED_WITHOUT_DATA" : "MATCH");
    // Values missing or changed mean the file may not be what wrote this batch, so nothing is called extra.
    if (comparison.missing.length > 0 || comparison.different.length > 0) return flagged("MISMATCH");
    if (comparison.extra.length === 0) return flagged("MATCH");

    const otherVerdict = await otherUploadVerdict(comparison.extra);
    if (otherVerdict) return flagged(otherVerdict);
    // An earlier import can only have written values before the owner was uploaded; anything later may be the
    // owner's own import stored differently from how its file reads now, so it is never called a leftover.
    const ownerUploaded = owner.uploadDate ? toTime(owner.uploadDate) - TIME_ZONE_MARGIN_MS : undefined;
    const writtenBeforeOwner = (value: Stored) =>
        ownerUploaded !== undefined && Boolean(value.created) && toTime(value.created as string) < ownerUploaded;
    if (!comparison.extra.every(writtenBeforeOwner)) return flagged("UNEXPLAINED_RECENT_VALUES");
    if (isWaiting(comparison.extra)) return flagged("WAITING");
    await compareAttempts(comparison.extra);
    return judged("LEFTOVER_VALUES", { owner, comparison, deletable: comparison.extra });
}

/**
 * What changed between the check and the delete: an upload record of the country and file type added, removed or
 * changed, or a value to delete rewritten or gone. Any change means the verdict may no longer hold.
 */
export function findChangesBeforeDelete<Stored extends ComparableValue & { lastUpdated?: string }>(
    checked: { uploads: UploadRecord[]; deletable: Stored[] },
    now: { uploads: UploadRecord[]; stored: Stored[] }
): string[] {
    const signature = (u: UploadRecord) =>
        [u.id, u.year, u.batchId, u.status, u.deleted ? "deleted" : "live"].join(" ");
    const checkedUploads = new Set(checked.uploads.map(signature));
    const nowUploads = new Set(now.uploads.map(signature));
    const changes = [
        ...[...nowUploads].filter(upload => !checkedUploads.has(upload)).map(upload => `upload now ${upload}`),
        ...[...checkedUploads].filter(upload => !nowUploads.has(upload)).map(upload => `upload was ${upload}`),
    ];
    const storedNow = new Map(now.stored.map(value => [valueKey(value), value]));
    for (const value of checked.deletable) {
        const current = storedNow.get(valueKey(value));
        if (!current) changes.push(`value ${valueKey(value)} gone`);
        else if (current.value !== value.value || current.lastUpdated !== value.lastUpdated)
            changes.push(`value ${valueKey(value)} rewritten`);
    }
    return changes;
}

/** Who stored the values and when, most common first, for the evidence report. */
export function describeWrites(values: { storedBy?: string; created?: string }[]): string {
    const counts = new Map<string, number>();
    for (const value of values) {
        const key = `${(value.created ?? "").slice(0, 10) || "date unknown"} by ${value.storedBy || "unknown"}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const groups = [...counts].sort((a, b) => b[1] - a[1]);
    const shown = groups.slice(0, 3).map(([key, count]) => `${count} written ${key}`);
    if (groups.length > 3) shown.push(`${groups.length - 3} more date/user groups`);
    return shown.join("; ");
}

/**
 * The upload record (live or deleted) most likely to have written values first created at `created`: the latest
 * one for the batch uploaded no later than a day after it. Evidence only, never a delete condition, since most
 * deleted uploads no longer have their file to prove it.
 */
export function findProbableSource(
    uploads: UploadRecord[],
    batch: Pick<StoredBatch, "orgUnitId" | "year" | "fileType" | "batchId">,
    created: string
): UploadRecord | undefined {
    if (!created) return undefined;
    const limit = toTime(created) + TIME_ZONE_MARGIN_MS;
    return uploads
        .filter(upload => covers(upload, { ...batch, lastUpdated: "" }) && upload.uploadDate !== "")
        .filter(upload => toTime(upload.uploadDate) <= limit)
        .sort((a, b) => toTime(b.uploadDate) - toTime(a.uploadDate))[0];
}

const BOM_AT_START = new RegExp(`^${String.fromCharCode(0xfeff)}`);

export const ORPHAN_CSV_COLUMNS = [
    "orgUnitCode",
    "year",
    "fileType",
    "batchId",
    "dataValues",
    "lastUpdated",
    "deletedUploadIds",
    "uploadedUploadIds",
];

/**
 * Reads the (possibly edited) CSV written by find or verify. A verify CSV has a verdict column: only its rows with a
 * deletable verdict are targets, so the whole verify output can be passed as is. Any bad target row fails the whole
 * file: nothing is half-run.
 */
export function parseOrphanCsv(text: string, validBatchCodes: string[]): { targets: DeleteTarget[]; skipped: number } {
    const parsed = Papa.parse<Record<string, string>>(text.replace(BOM_AT_START, ""), {
        header: true,
        skipEmptyLines: true,
        transformHeader: header => header.trim(),
    });
    if (parsed.errors.length > 0)
        throw new Error(`CSV could not be read: ${parsed.errors.map(error => error.message).join("; ")}`);

    const required = ["orgUnitCode", "year", "fileType", "batchId"];
    const missing = required.filter(column => !(parsed.meta.fields ?? []).includes(column));
    if (missing.length > 0) throw new Error(`CSV is missing column(s): ${missing.join(", ")}`);
    if (parsed.data.length === 0) throw new Error("CSV has no rows");

    const hasVerdicts = (parsed.meta.fields ?? []).includes("verdict");
    const rows = parsed.data
        .map((row, index) => ({ row, line: index + 2 }))
        .filter(({ row }) => !hasVerdicts || DELETABLE_VERDICTS.includes((row.verdict ?? "").trim() as Verdict));

    const errors: string[] = [];
    const targets = rows.map(({ row, line }) => {
        const target = {
            orgUnitCode: (row.orgUnitCode ?? "").trim(),
            year: (row.year ?? "").trim(),
            fileType: (row.fileType ?? "").trim() as AmrAggFileType,
            batchId: (row.batchId ?? "").trim(),
        };
        const problem = validateTarget(target, validBatchCodes);
        if (problem) errors.push(`row ${line}: ${problem}`);
        return target;
    });
    if (errors.length > 0) throw new Error(`CSV has invalid rows:\n${errors.join("\n")}`);
    return { targets, skipped: parsed.data.length - targets.length };
}

/** "2016-2025" or "2022,2024" (or both mixed) into a sorted list of distinct years. */
export function parseYears(values: string[]): string[] {
    const years = values.flatMap(value => {
        const range = value.match(/^(\d{4})-(\d{4})$/);
        if (range) {
            const [from, to] = [Number(range[1]), Number(range[2])];
            if (from > to) throw new Error(`Year range ${value} runs backwards`);
            return Array.from({ length: to - from + 1 }, (_, index) => String(from + index));
        }
        if (!/^\d{4}$/.test(value)) throw new Error(`Years must be YYYY or YYYY-YYYY, got "${value}"`);
        return [value];
    });
    return [...new Set(years)].sort();
}

export function validateTarget(target: DeleteTarget, validBatchCodes: string[]): string | undefined {
    if (!target.orgUnitCode) return "orgUnitCode is empty";
    if (!/^\d{4}$/.test(target.year)) return `year must be 4 digits, got "${target.year}"`;
    if (!AMR_AGG_FILE_TYPES.includes(target.fileType))
        return `fileType must be ${AMR_AGG_FILE_TYPES.join(" or ")}, got "${target.fileType}"`;
    if (!validBatchCodes.includes(target.batchId))
        return `batchId must be one of ${validBatchCodes.join(", ")}, got "${target.batchId}"`;
    return undefined;
}

/** Two batches of one country, year and file type that hold the same rows. */
export interface BatchOverlap {
    batchA: string;
    batchB: string;
    rowsA: number;
    rowsB: number;
    shared: number;
    /** IDENTICAL, A_INSIDE_B (every row of A is also in B), B_INSIDE_A, or PARTIAL. */
    kind: "IDENTICAL" | "A_INSIDE_B" | "B_INSIDE_A" | "PARTIAL";
}

/**
 * Batches holding the same rows (a cell whose every data element has the same value): one upload stored twice
 * (IND 2024 RIS DS2 = DS1), one file stored under two batches (GBR 2024 RIS DS2 inside DS3), or a smaller data set a
 * country sent as a subset of a larger one (FRA 2020, SWE 2016 and 2020). Rows, not single values: the same cell
 * often holds 0 in unrelated batches. `cellOf` gives an attribute option combo's cell without its batch; values on
 * other combos are left out. A pair is reported from `minShared` shared rows that are at least `minShare` of the
 * smaller batch.
 */
export function findBatchOverlaps(
    storedByBatch: Record<string, ComparableValue[]>,
    cellOf: (aoc: string) => string | undefined,
    minShared = 10,
    minShare = 0.5
): BatchOverlap[] {
    const rowsOf = (values: ComparableValue[]) => {
        const cells = new Map<string, string[]>();
        for (const value of values) {
            const cell = cellOf(value.attributeOptionCombo ?? "");
            if (cell === undefined) continue;
            const key = `${value.categoryOptionCombo ?? ""}|${cell}`;
            cells.set(key, [...(cells.get(key) ?? []), `${value.dataElement}=${value.value}`]);
        }
        return new Set([...cells].map(([cell, entries]) => `${cell}#${entries.sort().join(",")}`));
    };
    const rowsByBatch = new Map(Object.entries(storedByBatch).map(([batch, values]) => [batch, rowsOf(values)]));
    const batches = [...rowsByBatch.keys()].sort();
    return batches.flatMap((batchA, index) =>
        batches.slice(index + 1).flatMap(batchB => {
            const rowsA = rowsByBatch.get(batchA) ?? new Set<string>();
            const rowsB = rowsByBatch.get(batchB) ?? new Set<string>();
            const shared = [...rowsA].filter(row => rowsB.has(row)).length;
            if (shared < minShared || shared < minShare * Math.min(rowsA.size, rowsB.size)) return [];
            const kind =
                shared === rowsA.size && shared === rowsB.size
                    ? "IDENTICAL"
                    : shared === rowsA.size
                    ? "A_INSIDE_B"
                    : shared === rowsB.size
                    ? "B_INSIDE_A"
                    : "PARTIAL";
            return [{ batchA, batchB, rowsA: rowsA.size, rowsB: rowsB.size, shared, kind }];
        })
    );
}

export function describeOverlap(overlap: BatchOverlap): string {
    const { batchA, batchB, rowsA, rowsB, shared, kind } = overlap;
    const how = {
        IDENTICAL: `${batchA} and ${batchB} are identical`,
        A_INSIDE_B: `every row of ${batchA} is also in ${batchB}`,
        B_INSIDE_A: `every row of ${batchB} is also in ${batchA}`,
        PARTIAL: `${batchA} and ${batchB} share rows`,
    }[kind];
    return `${how} (${shared} shared rows; ${batchA} ${rowsA}, ${batchB} ${rowsB})`;
}
