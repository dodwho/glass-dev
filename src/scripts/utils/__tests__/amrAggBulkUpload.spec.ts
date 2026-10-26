import { describe, expect, it } from "vitest";
import { GlassUploads, GlassUploadsStatus } from "../../../domain/entities/GlassUploads";
import { ImportSummary } from "../../../domain/entities/data-entry/ImportSummary";
import {
    BatchOperations,
    BatchToLoad,
    checkPreflight,
    keyFromRows,
    loadBatch,
    LocalFile,
    pairFiles,
    Preflight,
    readyToSubmit,
    submissionTransitions,
} from "../amrAggBulkUpload";
import { AmrAggFileType } from "../amrAggOrphans";

function file(fileType: AmrAggFileType, overrides: Partial<LocalFile> = {}): LocalFile {
    return {
        path: `${fileType}_NOR_2024_DS1.csv`,
        fileType,
        orgUnitCode: "NOR",
        year: "2024",
        batchId: "DS1",
        rows: 10,
        specimens: ["BLOOD"],
        ...overrides,
    };
}

const batch = (withSample = true): BatchToLoad => ({
    orgUnitCode: "NOR",
    year: "2024",
    batchId: "DS1",
    ris: file("RIS"),
    sample: withSample ? file("SAMPLE") : undefined,
});

function upload(overrides: Partial<GlassUploads> = {}): GlassUploads {
    return {
        id: "up-1",
        batchId: "DS1",
        countryCode: "NOR",
        fileType: "RIS",
        fileId: "file-1",
        fileName: "old.csv",
        inputLineNb: 0,
        outputLineNb: 0,
        period: "2024",
        specimens: [],
        status: "COMPLETED",
        uploadDate: "2024-01-01T00:00:00.000Z",
        dataSubmission: "ds-1",
        module: "AVnpk4xiXGG",
        orgUnit: "ou-nor",
        correspondingRisUploadId: "",
        ...overrides,
    };
}

describe("keyFromRows", () => {
    it("takes country, year and batch from the rows", () => {
        expect(keyFromRows([{ COUNTRY: "NOR", YEAR: 2024, BATCHIDDS: "DS1" }])).toEqual({
            orgUnitCode: "NOR",
            year: "2024",
            batchId: "DS1",
        });
    });

    it("refuses a file whose rows name more than one batch, year or country", () => {
        const problem = keyFromRows([
            { COUNTRY: "NOR", YEAR: 2024, BATCHIDDS: "DS1" },
            { COUNTRY: "NOR", YEAR: 2023, BATCHIDDS: "DS2" },
        ]);
        expect(problem).toContain("2 years");
        expect(problem).toContain("2 batches");
    });

    it("refuses an empty file and a blank batch", () => {
        expect(keyFromRows([])).toBe("the file has no rows");
        expect(typeof keyFromRows([{ COUNTRY: "NOR", YEAR: 2024, BATCHIDDS: " " }])).toBe("string");
    });
});

describe("pairFiles", () => {
    it("pairs RIS and SAMPLE by country, year and batch from the rows, and takes RIS alone", () => {
        const { batches, problems } = pairFiles([
            file("SAMPLE", { path: "GLASS-NOR-2024-Sample.txt" }),
            file("RIS", { path: "anything.csv" }),
            file("RIS", { path: "ris-ds2.csv", batchId: "DS2" }),
        ]);
        expect(problems).toEqual([]);
        expect(batches.map(b => [b.batchId, b.ris.path, b.sample?.path])).toEqual([
            ["DS1", "anything.csv", "GLASS-NOR-2024-Sample.txt"],
            ["DS2", "ris-ds2.csv", undefined],
        ]);
    });

    it("leaves out a SAMPLE without its RIS, and a batch with two files of one type", () => {
        const { batches, problems } = pairFiles([
            file("SAMPLE", { batchId: "DS3" }),
            file("RIS", { path: "a.csv" }),
            file("RIS", { path: "b.csv" }),
            file("SAMPLE", { path: "s.csv" }),
        ]);
        expect(batches).toEqual([]);
        expect(problems.map(p => p.path).sort()).toEqual(["SAMPLE_NOR_2024_DS1.csv", "a.csv", "b.csv", "s.csv"]);
        expect(problems.find(p => p.path === "a.csv")?.problem).toContain("2 RIS files");
        expect(problems.find(p => p.path === "SAMPLE_NOR_2024_DS1.csv")?.problem).toContain("no RIS file");
    });
});

describe("checkPreflight", () => {
    const base = {
        batch: batch(),
        submissionStatus: "NOT_COMPLETED" as const,
        uploads: [] as GlassUploads[],
        queuedUploadIds: new Set<string>(),
        storedInBatch: { RIS: 0, SAMPLE: 0 },
        verifyCommand: "VERIFY",
    };
    const nothing: Preflight = { refusals: [], alreadyThere: [], notes: [] };

    it("passes a batch with nothing on the server, or no submission yet", () => {
        expect(checkPreflight(base)).toEqual(nothing);
        expect(checkPreflight({ ...base, submissionStatus: undefined })).toEqual(nothing);
    });

    it("refuses a year whose submission the app keeps closed for uploads", () => {
        for (const status of ["APPROVED", "PENDING_APPROVAL", "PENDING_UPDATE_APPROVAL"] as const)
            expect(checkPreflight({ ...base, submissionStatus: status }).refusals[0]).toContain(status);
    });

    it("skips a batch with an upload beyond UPLOADED, including a blank-batch one", () => {
        for (const status of ["IMPORTED", "VALIDATED", "COMPLETED"] as GlassUploadsStatus[])
            expect(checkPreflight({ ...base, uploads: [upload({ status })] }).alreadyThere).toHaveLength(1);
        expect(checkPreflight({ ...base, uploads: [upload({ batchId: "" })] }).alreadyThere).toHaveLength(1);
    });

    it("loads over an UPLOADED upload that was never imported, and says so", () => {
        const preflight = checkPreflight({ ...base, uploads: [upload({ status: "UPLOADED" })] });
        expect(preflight.refusals).toEqual([]);
        expect(preflight.alreadyThere).toEqual([]);
        expect(preflight.notes[0]).toContain("never imported");
    });

    it("skips a batch whose UPLOADED upload is queued for the async import (it will import later)", () => {
        const uploads = [upload({ status: "UPLOADED", fileType: "SAMPLE File", id: "queued" })];
        const preflight = checkPreflight({ ...base, uploads, queuedUploadIds: new Set(["queued"]) });
        expect(preflight.alreadyThere).toEqual([expect.stringMatching(/^SAMPLE: 1 imported or queued/)]);
    });

    it("counts an AMR - Individual SAMPLE File upload of the batch (same data set)", () => {
        const preflight = checkPreflight({ ...base, uploads: [upload({ fileType: "SAMPLE File", module: "ind" })] });
        expect(preflight.alreadyThere).toEqual([expect.stringMatching(/^SAMPLE/)]);
    });

    it("ignores uploads of other batches, deleted uploads, and a SAMPLE upload when only RIS is loaded", () => {
        const uploads = [
            upload({ batchId: "DS2" }),
            upload({ deleted: true }),
            upload({ fileType: "SAMPLE", id: "s" }),
        ];
        expect(checkPreflight({ ...base, batch: batch(false), uploads })).toEqual(nothing);
    });

    it("skips a batch with values already stored and points to verify", () => {
        const { alreadyThere } = checkPreflight({ ...base, storedInBatch: { RIS: 0, SAMPLE: 91 } });
        expect(alreadyThere).toEqual([expect.stringContaining("91 value(s) already stored under DS1")]);
        expect(alreadyThere[0]).toContain("VERIFY");
    });
});

describe("submissionTransitions and readyToSubmit", () => {
    it("takes the app's steps to PENDING_APPROVAL", () => {
        expect(submissionTransitions("NOT_COMPLETED")).toEqual(["COMPLETE", "PENDING_APPROVAL"]);
        expect(submissionTransitions("COMPLETE")).toEqual(["PENDING_APPROVAL"]);
        expect(submissionTransitions("UPDATE_REQUEST_ACCEPTED")).toEqual(["PENDING_APPROVAL"]);
        expect(submissionTransitions("APPROVED")).toEqual([]);
    });

    it("leaves a year carrying a WHO decision to a person", () => {
        expect(typeof submissionTransitions("REJECTED")).toBe("string");
        expect(typeof submissionTransitions("PENDING_UPDATE_APPROVAL")).toBe("string");
    });

    it("sends a year only when a batch was loaded and none failed or was refused", () => {
        expect(readyToSubmit(["LOADED", "SKIPPED"])).toBe(true);
        expect(readyToSubmit(["SKIPPED"])).toBe(false);
        expect(readyToSubmit(["LOADED", "FAILED"])).toBe(false);
        expect(readyToSubmit(["LOADED", "REFUSED"])).toBe(false);
    });
});

const summary = (overrides: Partial<ImportSummary> = {}): ImportSummary => ({
    status: "SUCCESS",
    importCount: { imported: 5, updated: 0, ignored: 0, deleted: 0, total: 5 },
    nonBlockingErrors: [],
    blockingErrors: [],
    ...overrides,
});
const blocked = summary({ status: "ERROR", blockingErrors: [{ error: "Batchid is different", count: 3 }] });

type Step = keyof BatchOperations;

/** Operations that log every call; `fail` makes that step throw (or return the given value). */
function fakeOperations(fail: Partial<Record<Step, unknown>> = {}) {
    const calls: string[] = [];
    const statuses = new Map<string, GlassUploadsStatus>();
    let nextId = 1;
    const step = async <T>(name: Step, label: string, value: () => T): Promise<T> => {
        calls.push(label);
        if (name in fail) {
            const failure = fail[name];
            if (failure instanceof Error) throw failure;
            if (typeof failure === "function") return failure(label) as T;
            return failure as T;
        }
        return value();
    };
    const ops: BatchOperations = {
        preflight: () =>
            step("preflight", "preflight", (): Preflight => ({ refusals: [], alreadyThere: [], notes: [] })),
        dryRun: fileType => step("dryRun", `dryRun ${fileType}`, () => summary()),
        ensureSubmission: () => step("ensureSubmission", "submission", () => "ds-1"),
        upload: fileType =>
            step("upload", `upload ${fileType}`, () => {
                const id = `${fileType}-${nextId++}`;
                statuses.set(id, "UPLOADED");
                return id;
            }),
        removeUpload: id => step("removeUpload", `remove ${id}`, () => void statuses.delete(id)),
        linkSampleToRis: (sample, ris) => step("linkSampleToRis", `link ${sample}->${ris}`, () => undefined),
        saveErrors: () => step("saveErrors", "saveErrors", () => undefined),
        setStatus: (id, status) => step("setStatus", `${id}:${status}`, () => void statuses.set(id, status)),
        getStatus: id => step("getStatus", `get ${id}`, () => statuses.get(id) ?? "UPLOADED"),
        realImport: fileType => step("realImport", `import ${fileType}`, () => summary()),
        removeImportedValues: () => step("removeImportedValues", "removeValues", () => undefined),
        storedDifference: () => step("storedDifference", "readBack", () => undefined),
        storedCount: () => step("storedCount", "count", () => 0),
    };
    return { ops, calls, statuses };
}

const completed = (statuses: Map<string, GlassUploadsStatus>) =>
    [...statuses.values()].filter(status => status === "COMPLETED");

describe("loadBatch", () => {
    it("runs the app's steps in the app's order and completes only after the read-back", async () => {
        const { ops, calls, statuses } = fakeOperations();
        const outcome = await loadBatch(ops, batch(), true);
        expect(outcome.result).toBe("LOADED");
        expect(calls).toEqual([
            "preflight",
            "dryRun RIS",
            "dryRun SAMPLE",
            "submission",
            "upload RIS",
            "upload SAMPLE",
            "link SAMPLE-2->RIS-1",
            "saveErrors",
            "RIS-1:IMPORTED",
            "SAMPLE-2:IMPORTED",
            "import RIS",
            "import SAMPLE",
            "saveErrors",
            "readBack",
            "RIS-1:VALIDATED",
            "SAMPLE-2:VALIDATED",
            "get RIS-1",
            "RIS-1:COMPLETED",
            "get SAMPLE-2",
            "SAMPLE-2:COMPLETED",
        ]);
        expect(completed(statuses)).toHaveLength(2);
    });

    it("writes nothing without commit", async () => {
        const { ops, calls } = fakeOperations();
        const outcome = await loadBatch(ops, batch(), false);
        expect(outcome.result).toBe("WOULD_LOAD");
        expect(outcome.dryRunValues).toEqual({ RIS: 5, SAMPLE: 5 });
        expect(calls).toEqual(["preflight", "dryRun RIS", "dryRun SAMPLE"]);
    });

    it("stops at a pre-flight refusal, or skips a batch already there, before any write", async () => {
        const refused = fakeOperations({ preflight: { refusals: ["closed"], alreadyThere: [], notes: [] } });
        expect((await loadBatch(refused.ops, batch(), true)).result).toBe("REFUSED");
        expect(refused.calls).toEqual(["preflight"]);

        const there = fakeOperations({ preflight: { refusals: [], alreadyThere: ["RIS: stored"], notes: [] } });
        expect((await loadBatch(there.ops, batch(), true)).result).toBe("SKIPPED");
        expect(there.calls).toEqual(["preflight"]);

        const rerun = fakeOperations({ preflight: { refusals: ["closed"], alreadyThere: ["RIS: stored"], notes: [] } });
        expect((await loadBatch(rerun.ops, batch(), true)).result).toBe("SKIPPED");
    });

    it("refuses the whole batch when either file has errors in the dry run, before any write", async () => {
        for (const bad of ["dryRun RIS", "dryRun SAMPLE"]) {
            const { ops, calls } = fakeOperations({ dryRun: (label: string) => (label === bad ? blocked : summary()) });
            const outcome = await loadBatch(ops, batch(), true);
            expect(outcome.result).toBe("REFUSED");
            expect(outcome.message).toContain(`${bad.split(" ")[1]}: Batchid is different`);
            expect(calls).toEqual(["preflight", "dryRun RIS", "dryRun SAMPLE"]);
        }
    });

    it("removes the upload records again when saving them fails, so a re-run is not blocked", async () => {
        const { ops, calls, statuses } = fakeOperations({ linkSampleToRis: new Error("link failed") });
        const outcome = await loadBatch(ops, batch(), true);
        expect(outcome.result).toBe("FAILED");
        expect(outcome.message).toContain("upload records were removed");
        expect(calls).toContain("remove RIS-1");
        expect(calls).toContain("remove SAMPLE-2");
        expect(calls.some(call => call.startsWith("import"))).toBe(false);
        expect(statuses.size).toBe(0);
    });

    it("says which records are left when they cannot be removed", async () => {
        const { ops } = fakeOperations({ linkSampleToRis: new Error("link failed"), removeUpload: new Error("no") });
        const outcome = await loadBatch(ops, batch(), true);
        expect(outcome.result).toBe("FAILED");
        expect(outcome.message).toContain("could not be removed: RIS-1 (no); SAMPLE-2 (no)");
        expect(outcome.nextStep).toContain("Delete those uploads in the app");
    });

    it("keeps the uploads IMPORTED and removes the values when the import stops part-way", async () => {
        const { ops, calls, statuses } = fakeOperations({ realImport: new Error("socket hang up") });
        const outcome = await loadBatch(ops, batch(), true);
        expect(outcome.result).toBe("FAILED");
        expect(outcome.nextStep).toContain("Delete these uploads in the app");
        expect(calls).toContain("removeValues");
        expect([...statuses.values()]).toEqual(["IMPORTED", "IMPORTED"]);
    });

    it("removes the never-imported uploads when the IMPORTED status cannot be set", async () => {
        const { ops, calls } = fakeOperations({ setStatus: new Error("status not saved") });
        const outcome = await loadBatch(ops, batch(), true);
        expect(outcome.result).toBe("FAILED");
        expect(outcome.message).toContain("could not start");
        expect(calls.some(call => call.startsWith("import"))).toBe(false);
        expect(calls).toContain("remove RIS-1");
    });

    it("rolls the whole batch back when the SAMPLE import reports errors (e.g. validation rules)", async () => {
        const { ops, calls, statuses } = fakeOperations({
            realImport: (label: string) => (label === "import SAMPLE" ? blocked : summary()),
        });
        const outcome = await loadBatch(ops, batch(), true);
        expect(outcome.result).toBe("FAILED");
        expect(outcome.message).toContain("SAMPLE: Batchid is different");
        expect(outcome.message).toContain("values were deleted again");
        expect(calls.slice(calls.indexOf("removeValues"))).toEqual([
            "removeValues",
            "count",
            "remove RIS-1",
            "remove SAMPLE-2",
        ]);
        expect(statuses.size).toBe(0);
    });

    it("rolls back when the stored values differ from the files, or cannot be read back", async () => {
        for (const fail of [{ storedDifference: "3 missing" }, { storedDifference: new Error("timeout") }]) {
            const { ops, calls, statuses } = fakeOperations(fail);
            const outcome = await loadBatch(ops, batch(), true);
            expect(outcome.result).toBe("FAILED");
            expect(outcome.message).toContain("Stored values are not the files' values");
            expect(calls.some(call => call.endsWith(":VALIDATED"))).toBe(false);
            expect(calls).toContain("removeValues");
            expect(statuses.size).toBe(0);
        }
    });

    it("keeps the uploads IMPORTED when the rollback leaves values behind or fails", async () => {
        for (const fail of [{ storedCount: 12 }, { removeImportedValues: new Error("timeout") }]) {
            const { ops, calls, statuses } = fakeOperations({ realImport: blocked, ...fail });
            const outcome = await loadBatch(ops, batch(), true);
            expect(outcome.result).toBe("FAILED");
            expect(outcome.message).toContain("the uploads stay IMPORTED");
            expect(outcome.nextStep).toContain("Delete these uploads in the app");
            expect(calls.some(call => call.startsWith("remove RIS"))).toBe(false);
            expect([...statuses.values()]).toEqual(["IMPORTED", "IMPORTED"]);
        }
    });

    it("completes only an upload the server says is VALIDATED", async () => {
        const { ops, statuses } = fakeOperations({ getStatus: "IMPORTED" });
        const outcome = await loadBatch(ops, batch(), true);
        expect(outcome.result).toBe("FAILED");
        expect(outcome.message).toContain("not VALIDATED");
        expect(completed(statuses)).toHaveLength(0);
    });

    it("loads a RIS file alone", async () => {
        const { ops, calls } = fakeOperations();
        expect((await loadBatch(ops, batch(false), true)).result).toBe("LOADED");
        expect(calls.some(call => call.includes("SAMPLE"))).toBe(false);
    });
});
