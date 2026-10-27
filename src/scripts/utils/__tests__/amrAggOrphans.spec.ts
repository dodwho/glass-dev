import { describe, expect, it } from "vitest";
import {
    classifyLiveUploads,
    compareValues,
    describeOverlap,
    describeWrites,
    explainMislabel,
    findBatchOverlaps,
    findChangesBeforeDelete,
    findForeignLabels,
    findProbableSource,
    findOrphans,
    judgeBatch,
    MislabelFinding,
    NEXT_STEPS,
    getAocTranslator,
    getBatchCodeByAoc,
    parseOrphanCsv,
    parseYears,
    StoredBatch,
    toAmrAggFileType,
    isLiveUpload,
    valuesHeldByLiveFiles,
    UploadRecord,
} from "../amrAggOrphans";

const BATCH_CODES = ["DS1", "DS2", "DS10"];

function stored(overrides: Partial<StoredBatch> = {}): StoredBatch {
    return {
        orgUnitId: "ou-irq",
        orgUnitCode: "IRQ",
        year: "2024",
        fileType: "RIS",
        batchId: "DS1",
        dataValues: 100,
        lastUpdated: "2025-06-24T07:41:50.000+0000",
        ...overrides,
    };
}

function upload(overrides: Partial<UploadRecord> = {}): UploadRecord {
    return {
        id: "up-1",
        orgUnitId: "ou-irq",
        year: "2024",
        fileType: "RIS",
        batchId: "DS1",
        status: "COMPLETED",
        deleted: false,
        fileId: "file-1",
        deletionRequestedBy: "",
        deletionReason: "",
        uploadDate: "2024-06-01T10:00:00.000Z",
        createdAt: "2026-02-17T13:49:32.000Z",
        ...overrides,
    };
}

describe("findOrphans", () => {
    it("reports stored data with no upload, with the deleted uploads that once covered it", () => {
        const orphans = findOrphans([stored()], [upload({ id: "gone", deleted: true })]);
        expect(orphans).toEqual([{ ...stored(), deletedUploadIds: ["gone"], uploadedUploadIds: [] }]);
    });

    it("treats a live upload past UPLOADED as owning the batch, whenever it was created", () => {
        for (const status of ["IMPORTED", "VALIDATED", "COMPLETED", "DATA_TO_BE_APPROVED_BY_COUNTRY"])
            expect(findOrphans([stored()], [upload({ status, uploadDate: "2026-10-08T10:31:33.484Z" })])).toEqual([]);
    });

    it("lists a batch whose only uploads are at UPLOADED, naming them (Iraq 2024)", () => {
        const notImported = upload({ id: "qPWa6ZPvCAq", status: "UPLOADED", uploadDate: "2026-10-08T10:31:33.484Z" });
        expect(findOrphans([stored()], [notImported])).toEqual([
            { ...stored(), deletedUploadIds: [], uploadedUploadIds: ["qPWa6ZPvCAq"] },
        ]);
    });

    it("does not list a batch with an imported upload beside an UPLOADED one", () => {
        const uploads = [
            upload({ id: "new", status: "UPLOADED", uploadDate: "2026-10-08T10:31:33.484Z" }),
            upload({ id: "live", status: "VALIDATED" }),
        ];
        expect(findOrphans([stored()], uploads)).toEqual([]);
    });

    it("treats a live upload with no batch id as covering every batch", () => {
        expect(findOrphans([stored({ batchId: "DS2" })], [upload({ batchId: "" })])).toEqual([]);
    });

    it("does not let an upload for another batch, file type, year or country cover the data", () => {
        const uploads = [
            upload({ batchId: "DS2" }),
            upload({ fileType: "SAMPLE" }),
            upload({ year: "2023" }),
            upload({ orgUnitId: "ou-jor" }),
        ];
        expect(findOrphans([stored()], uploads)).toHaveLength(1);
    });

    it("splits the country's live uploads of the file type into owners, attempts and others", () => {
        const uploads = [
            upload({ id: "owner" }),
            upload({ id: "attempt", status: "UPLOADED" }),
            upload({ id: "other-batch", batchId: "DS2" }),
            upload({ id: "other-year", year: "2023" }),
            upload({ id: "deleted", batchId: "DS2", deleted: true }),
            upload({ id: "other-country", orgUnitId: "ou-gbr", batchId: "DS2" }),
            upload({ id: "other-type", fileType: "SAMPLE", batchId: "DS2" }),
        ];
        const { owners, attempts, others } = classifyLiveUploads(uploads, stored());
        expect(owners.map(u => u.id)).toEqual(["owner"]);
        expect(attempts.map(u => u.id)).toEqual(["attempt"]);
        expect(others.map(u => u.id)).toEqual(["other-batch", "other-year"]);
    });

    it("ignores batches with no stored values", () => {
        expect(findOrphans([stored({ dataValues: 0 })], [])).toEqual([]);
    });
});

describe("getBatchCodeByAoc", () => {
    const combo = {
        categories: [
            { code: "PATHOGEN", categoryOptions: [{ id: "p1", code: "DS1" }] },
            {
                code: "BATCHIDDS",
                categoryOptions: [
                    { id: "b1", code: "DS1" },
                    { id: "b10", code: "DS10" },
                ],
            },
        ],
        categoryOptionCombos: [
            { id: "aoc-1", categoryOptions: [{ id: "p1" }, { id: "b1" }] },
            { id: "aoc-10", categoryOptions: [{ id: "p1" }, { id: "b10" }] },
        ],
    };

    it("maps each combo by its batch option only, so DS1 never matches DS10 or a look-alike code elsewhere", () => {
        const byAoc = getBatchCodeByAoc(combo, "BATCHIDDS");
        expect(byAoc.get("aoc-1")).toBe("DS1");
        expect(byAoc.get("aoc-10")).toBe("DS10");
    });

    it("leaves out a stale combo with no batch option rather than guess its batch", () => {
        const stale = { id: "stale", categoryOptions: [{ id: "p1" }] };
        const byAoc = getBatchCodeByAoc(
            { ...combo, categoryOptionCombos: [...combo.categoryOptionCombos, stale] },
            "BATCHIDDS"
        );
        expect(byAoc.has("stale")).toBe(false);
        expect(byAoc.size).toBe(2);
    });

    it("fails rather than guess when a combo has two batch options", () => {
        const broken = {
            ...combo,
            categoryOptionCombos: [{ id: "x", categoryOptions: [{ id: "b1" }, { id: "b10" }] }],
        };
        expect(() => getBatchCodeByAoc(broken, "BATCHIDDS")).toThrow(/2 BATCHIDDS/);
    });

    it("fails when the batch category is missing", () => {
        expect(() => getBatchCodeByAoc(combo, "NOPE")).toThrow(/found 0/);
    });
});

describe("parseOrphanCsv", () => {
    it("reads the find output, ignoring extra columns and a BOM", () => {
        const csv =
            String.fromCharCode(0xfeff) + "orgUnitCode,year,fileType,batchId,dataValues\nIRQ,2024,RIS,DS1,51163\n";
        expect(parseOrphanCsv(csv, BATCH_CODES)).toEqual({
            targets: [{ orgUnitCode: "IRQ", year: "2024", fileType: "RIS", batchId: "DS1" }],
            skipped: 0,
        });
    });

    it("takes only the deletable rows of a verify CSV, so the whole verify output can be passed as is", () => {
        const csv = [
            "orgUnitCode,year,fileType,batchId,verdict",
            "IRQ,2024,RIS,DS1,ORPHAN",
            "HKG,2022,RIS,DS2,LEFTOVER_VALUES",
            "GBR,2024,RIS,DS3,OTHER_UPLOAD_VALUES",
            "ZAF,2023,RIS,(all),READ_FAILED",
        ].join("\n");
        const { targets, skipped } = parseOrphanCsv(csv, BATCH_CODES);
        expect(targets.map(target => target.orgUnitCode)).toEqual(["IRQ", "HKG"]);
        expect(skipped).toBe(2);
    });

    it("rejects a file missing a required column", () => {
        expect(() => parseOrphanCsv("orgUnitCode,year,fileType\nIRQ,2024,RIS\n", BATCH_CODES)).toThrow(/batchId/);
    });

    it("rejects the whole file when any row is invalid", () => {
        const csv =
            "orgUnitCode,year,fileType,batchId\nIRQ,2024,RIS,DS1\nIRQ,24,RIS,DS1\nIRQ,2024,AMC,DS1\nIRQ,2024,RIS,DS7\n";
        expect(() => parseOrphanCsv(csv, BATCH_CODES)).toThrow(/row 3.*\n.*row 4.*\n.*row 5/);
    });

    it("rejects an empty file", () => {
        expect(() => parseOrphanCsv("orgUnitCode,year,fileType,batchId\n", BATCH_CODES)).toThrow(/no rows/);
    });
});

describe("parseYears", () => {
    it("expands ranges, merges lists and drops duplicates", () => {
        expect(parseYears(["2022-2024", "2023", "2016"])).toEqual(["2016", "2022", "2023", "2024"]);
    });

    it("rejects a backwards range and a malformed year", () => {
        expect(() => parseYears(["2024-2022"])).toThrow(/backwards/);
        expect(() => parseYears(["24"])).toThrow(/YYYY/);
    });
});

// Written well before the default upload fixture (uploaded 2024-06-01), unless a test says otherwise.
const dv = (dataElement: string, value: string, categoryOptionCombo = "coc", attributeOptionCombo = "aoc") => ({
    dataElement,
    categoryOptionCombo,
    attributeOptionCombo,
    value,
    created: "2020-01-01T00:00:00.000+0000",
    lastUpdated: "2020-01-01T00:00:00.000+0000",
});

describe("compareValues", () => {
    it("sorts stored values into matched, extra, missing and different", () => {
        const stored = [dv("res", "3"), dv("sus", "10"), dv("int", "1")];
        const expected = [dv("res", "3"), dv("sus", "9"), dv("non", "4")];
        const result = compareValues(stored, expected, new Set());
        expect(result.matched).toBe(1);
        expect(result.extra).toEqual([dv("int", "1")]);
        expect(result.missing).toEqual([dv("non", "4")]);
        expect(result.different).toEqual([{ stored: dv("sus", "10"), expected: dv("sus", "9") }]);
    });

    it("compares numbers by value, and keys on both combos", () => {
        const result = compareValues([dv("res", "3"), dv("res", "1", "coc-2")], [dv("res", "3.0")], new Set());
        expect(result.matched).toBe(1);
        expect(result.extra).toEqual([dv("res", "1", "coc-2")]);
    });

    it("expects nothing stored for a blank, and a 0 that is significant to be stored", () => {
        const expected = [dv("abclass", ""), dv("res", "0")];
        const result = compareValues([dv("abclass", "x")], expected, new Set(["numsampled"]));
        expect(result.extra).toEqual([dv("abclass", "x")]);
        expect(result.missing).toEqual([dv("res", "0")]);
    });

    it("accepts a 0 stored or not where DHIS2 no longer stores zeros, so old stored zeros are never extra (SGP 2023)", () => {
        const zeros = new Set(["numsampled"]);
        const expected = [dv("numsampled", "0", "c1"), dv("numsampled", "0", "c2")];
        const result = compareValues([dv("numsampled", "0", "c1")], expected, zeros);
        expect(result).toEqual({ matched: 1, extra: [], missing: [], different: [] });
    });

    it("takes the last of duplicate file rows, as the import does", () => {
        expect(compareValues([dv("res", "5")], [dv("res", "2"), dv("res", "5")], new Set()).matched).toBe(1);
    });
});

describe("judgeBatch", () => {
    const zeros = new Set<string>();
    type Value = ReturnType<typeof dv>;
    const NOW = Date.parse("2026-10-24T00:00:00.000Z");
    const judge = (
        stored: Value[],
        covering: UploadRecord[],
        files: Record<string, Value[] | "unreadable"> = {},
        otherUploads: UploadRecord[] = []
    ) =>
        judgeBatch({
            year: "2024",
            stored,
            owners: covering.filter(u => u.status !== "UPLOADED"),
            attempts: covering.filter(u => u.status === "UPLOADED"),
            otherUploads,
            getFile: async upload => files[upload.id] ?? "unreadable",
            zeroNotStoredDataElements: zeros,
            now: NOW,
        });
    const owner = upload({ id: "done", status: "COMPLETED" });
    const attempt = (id: string, uploadDate = "2024-06-01T10:00:00.000Z") =>
        upload({ id, status: "UPLOADED", uploadDate });
    const recentDay = "2026-10-20T10:00:00.000Z";

    it("makes the whole batch deletable when no upload of any kind owns it", async () => {
        const result = await judge([dv("res", "1")], []);
        expect(result.verdict).toBe("ORPHAN");
        expect(result.deletable).toEqual([dv("res", "1")]);
    });

    it("deletes values only an UPLOADED upload's file holds, and records that the file holds them (Iraq 2024, decision 24 Oct)", async () => {
        const reUpload = attempt("re-upload", "2026-10-08T10:00:00.000Z");
        const result = await judge([dv("res", "1")], [reUpload], { "re-upload": [dv("res", "1")] });
        expect(result.verdict).toBe("ORPHAN");
        expect(result.deletable).toEqual([dv("res", "1")]);
        expect(result.fileMatches).toEqual([
            { upload: reUpload, result: { matched: 1, extra: 0, missing: 0, different: 0 } },
        ]);
    });

    it("waits 14 days after an UPLOADED upload of the year, which may still be importing", async () => {
        const covering = await judge([dv("res", "1")], [attempt("new", recentDay)]);
        const otherBatch = await judge([dv("res", "1")], [], {}, [
            upload({ id: "new-ds2", status: "UPLOADED", batchId: "DS2", uploadDate: recentDay }),
        ]);
        const otherYear = await judge([dv("res", "1")], [], {}, [
            upload({ id: "new-2025", status: "UPLOADED", year: "2025", uploadDate: recentDay }),
        ]);
        expect([covering.verdict, otherBatch.verdict, otherYear.verdict]).toEqual(["WAITING", "WAITING", "ORPHAN"]);
        expect([...covering.deletable, ...otherBatch.deletable]).toEqual([]);
    });

    it("deletes sooner only when the waiting period is lowered on purpose, and keeps the other guards (Norway 2024 DS4)", async () => {
        const recentAttempt = attempt("new", recentDay);
        const judgeWith = (waitingDays: number, otherUploads: UploadRecord[] = [], files = {}) =>
            judgeBatch({
                year: "2024",
                stored: [{ ...dv("res", "1"), lastUpdated: recentDay }],
                owners: [],
                attempts: [recentAttempt],
                otherUploads,
                getFile: async upload => (files as Record<string, Value[]>)[upload.id] ?? "unreadable",
                zeroNotStoredDataElements: zeros,
                now: NOW,
                waitingDays,
            });
        expect((await judgeWith(14)).verdict).toBe("WAITING");
        expect((await judgeWith(0)).verdict).toBe("ORPHAN");
        // An imported upload's file that holds the values still protects them.
        const imported = upload({ id: "ds2-upload", batchId: "DS2" });
        const protectedValues = await judgeWith(0, [imported], { "ds2-upload": [dv("res", "1")] });
        expect([protectedValues.verdict, protectedValues.deletable]).toEqual(["OTHER_UPLOAD_VALUES", []]);
    });

    it("waits 14 days after the values were written, and treats an unknown date as recent", async () => {
        const written = await judge([{ ...dv("res", "1"), lastUpdated: recentDay }], []);
        const unknown = await judge([{ ...dv("res", "1"), lastUpdated: "" }], []);
        const noDates = await judge(
            [dv("res", "1")],
            [upload({ id: "x", status: "UPLOADED", uploadDate: "", createdAt: "" })]
        );
        expect([written.verdict, unknown.verdict, noDates.verdict]).toEqual(["WAITING", "WAITING", "WAITING"]);
    });

    it("uses the record's creation date when an UPLOADED upload has no upload date", async () => {
        const migrated = upload({ id: "m", status: "UPLOADED", uploadDate: "", createdAt: "2026-02-17T13:49:32.000Z" });
        expect((await judge([dv("res", "1")], [migrated])).verdict).toBe("ORPHAN");
    });

    it("never deletes values another imported upload's file put here (GBR 2024 without a DS3 upload)", async () => {
        const ds2Upload = upload({ id: "ds2-upload", batchId: "DS2" });
        const explained = await judge([dv("res", "1")], [], { "ds2-upload": [dv("res", "1")] }, [ds2Upload]);
        const unreadable = await judge([dv("res", "1")], [], {}, [ds2Upload]);
        const unrelated = await judge([dv("res", "1")], [], { "ds2-upload": [dv("int", "4")] }, [ds2Upload]);
        expect([explained.verdict, unreadable.verdict, unrelated.verdict]).toEqual([
            "OTHER_UPLOAD_VALUES",
            "FILE_UNREADABLE",
            "ORPHAN",
        ]);
        expect([...explained.deletable, ...unreadable.deletable]).toEqual([]);
    });

    it("does not let another batch's UPLOADED upload make values belong, as it was never imported", async () => {
        const notImported = upload({ id: "ds2-try", batchId: "DS2", status: "UPLOADED" });
        const result = await judge([dv("res", "1")], [], { "ds2-try": [dv("res", "1")] }, [notImported]);
        expect(result.verdict).toBe("ORPHAN");
    });

    it("calls a batch equal to its VALIDATED or COMPLETED upload's file a MATCH", async () => {
        for (const status of ["VALIDATED", "COMPLETED"]) {
            const result = await judge([dv("res", "1")], [upload({ id: "u", status })], { u: [dv("res", "1")] });
            expect(result.verdict).toBe("MATCH");
            expect(result.deletable).toEqual([]);
        }
    });

    it("lets only values no imported upload's file has be deleted, as LEFTOVER_VALUES (HKG 2022)", async () => {
        const result = await judge([dv("res", "1"), dv("int", "2")], [owner], { done: [dv("res", "1")] });
        expect(result.verdict).toBe("LEFTOVER_VALUES");
        expect(result.deletable).toEqual([dv("int", "2")]);
    });

    it("compares with the one imported upload when UPLOADED attempts sit beside it (SGP 2024)", async () => {
        const result = await judge([dv("res", "1")], [attempt("try"), owner], { done: [dv("res", "1")] });
        expect(result.verdict).toBe("MATCH");
        expect(result.owner?.id).toBe("done");
    });

    it("deletes leftovers an old UPLOADED attempt's file holds, and records the comparison", async () => {
        const files = { done: [dv("res", "1")], try: [dv("int", "2")] };
        const result = await judge([dv("res", "1"), dv("int", "2")], [attempt("try"), owner], files);
        expect(result.verdict).toBe("LEFTOVER_VALUES");
        expect(result.deletable).toEqual([dv("int", "2")]);
        expect(result.fileMatches.map(match => match.upload.id)).toEqual(["done", "try"]);
    });

    it("waits on leftovers while an UPLOADED attempt is recent", async () => {
        const files = { done: [dv("res", "1")], try: [dv("int", "2")] };
        const result = await judge([dv("res", "1"), dv("int", "2")], [attempt("try", recentDay), owner], files);
        expect(result.verdict).toBe("WAITING");
        expect(result.deletable).toEqual([]);
    });

    it("flags extras another imported upload's file has under this batch label (GBR 2024: DS2 upload, rows say DS3)", async () => {
        const otherBatch = upload({ id: "ds2-upload", batchId: "DS2" });
        const files = { done: [dv("res", "1")], "ds2-upload": [dv("int", "2")] };
        const result = await judge([dv("res", "1"), dv("int", "2")], [owner], files, [otherBatch]);
        expect(result.verdict).toBe("OTHER_UPLOAD_VALUES");
        expect(result.deletable).toEqual([]);
    });

    it("never calls values written on or after the owner's upload leftovers (GBR 2024 DS2)", async () => {
        const recent = { ...dv("int", "2"), created: "2024-06-01T12:00:00.000+0000" };
        const result = await judge([dv("res", "1"), recent], [owner], { done: [dv("res", "1")] });
        expect(result.verdict).toBe("UNEXPLAINED_RECENT_VALUES");
        expect(result.deletable).toEqual([]);
    });

    it("needs the owner's upload date and each value's write date to call anything a leftover", async () => {
        const undated = upload({ id: "done", status: "COMPLETED", uploadDate: "" });
        const noDate = await judge([dv("res", "1"), dv("int", "2")], [undated], { done: [dv("res", "1")] });
        const noCreated = await judge([dv("res", "1"), { ...dv("int", "2"), created: "" }], [owner], {
            done: [dv("res", "1")],
        });
        expect([noDate.verdict, noCreated.verdict]).toEqual(["UNEXPLAINED_RECENT_VALUES", "UNEXPLAINED_RECENT_VALUES"]);
    });

    it("deletes nothing when values are missing or different from the file", async () => {
        const differs = await judge([dv("res", "2"), dv("int", "2")], [owner], { done: [dv("res", "1")] });
        const lacks = await judge([dv("int", "2")], [owner], { done: [dv("res", "1")] });
        expect([differs.verdict, lacks.verdict]).toEqual(["MISMATCH", "MISMATCH"]);
        expect([...differs.deletable, ...lacks.deletable]).toEqual([]);
    });

    it("flags two imported uploads for one batch, and values under an IMPORTED upload", async () => {
        const duplicate = await judge([dv("res", "1")], [owner, upload({ id: "other", status: "VALIDATED" })]);
        const imported = await judge([dv("res", "1")], [upload({ id: "i", status: "IMPORTED" })], {
            i: [dv("res", "1")],
        });
        expect([duplicate.verdict, imported.verdict]).toEqual(["DUPLICATE_IMPORTS", "IMPORTED_WITH_DATA"]);
        expect([...duplicate.deletable, ...imported.deletable]).toEqual([]);
        // The app's delete of either duplicate would also remove the values the other one holds (MDG/USA 2016 on prod).
        expect(NEXT_STEPS.DUPLICATE_IMPORTS).toMatch(/^do not delete either upload in the app/);
    });

    it("reports a submitted upload with nothing stored, and UPLOADED with nothing as normal", async () => {
        expect((await judge([], [owner], { done: [dv("res", "1")] })).verdict).toBe("SUBMITTED_WITHOUT_DATA");
        expect((await judge([], [attempt("a")])).verdict).toBe("NOT_IMPORTED");
    });

    it("never deletes with an unreadable owner file or an unknown status", async () => {
        const unreadable = await judge([dv("res", "1")], [owner]);
        const other = await judge([dv("res", "1")], [upload({ id: "x", status: "SOMETHING" })], { x: [] });
        expect([unreadable.verdict, other.verdict]).toEqual(["FILE_UNREADABLE", "OTHER_STATUS"]);
        expect([...unreadable.deletable, ...other.deletable]).toEqual([]);
    });
});

describe("label audit helpers", () => {
    const combo = {
        categories: [
            {
                code: "PATHOGEN",
                categoryOptions: [
                    { id: "eco", code: "ECOLI" },
                    { id: "kpn", code: "KLEPNE" },
                ],
            },
            {
                code: "BATCHIDDS",
                categoryOptions: [
                    { id: "b2", code: "DS2" },
                    { id: "b3", code: "DS3" },
                ],
            },
        ],
        categoryOptionCombos: [
            { id: "eco-2", categoryOptions: [{ id: "eco" }, { id: "b2" }] },
            { id: "eco-3", categoryOptions: [{ id: "b3" }, { id: "eco" }] },
            { id: "kpn-2", categoryOptions: [{ id: "kpn" }, { id: "b2" }] },
        ],
    };

    it("finds the same pathogen/antibiotic combo under another batch, whatever the option order", () => {
        const translate = getAocTranslator(combo, "BATCHIDDS");
        expect(translate("eco-3", "DS2")).toBe("eco-2");
        expect(translate("eco-2", "DS3")).toBe("eco-3");
        expect(translate("kpn-2", "DS3")).toBeUndefined();
        expect(translate("unknown", "DS2")).toBeUndefined();
    });

    const row = (orgUnit: string, period: string, batch: string) => ({ orgUnit, period, batch });
    const batchOfRow = (value: { batch: string }) => value.batch;

    it("groups only the rows that name another country, year or batch than the upload (GBR 2024)", () => {
        const ds2Upload = upload({ orgUnitId: "ou-gbr", batchId: "DS2" });
        const rows = [
            row("ou-gbr", "2024", "DS2"),
            row("ou-gbr", "2024", "DS3"),
            row("ou-gbr", "2024", "DS3"),
            row("ou-gbr", "2023", "DS2"),
            row("ou-irl", "2024", "DS2"),
        ];
        const groups = findForeignLabels(ds2Upload, rows, batchOfRow);
        expect(groups.map(group => [group.label, group.values.length])).toEqual([
            [{ orgUnitId: "ou-gbr", year: "2024", batchId: "DS3" }, 2],
            [{ orgUnitId: "ou-gbr", year: "2023", batchId: "DS2" }, 1],
            [{ orgUnitId: "ou-irl", year: "2024", batchId: "DS2" }, 1],
        ]);
    });

    it("accepts any batch for an upload with a blank batch, but not another year", () => {
        const blank = upload({ orgUnitId: "ou-gbr", batchId: "" });
        const groups = findForeignLabels(
            blank,
            [row("ou-gbr", "2024", "DS4"), row("ou-gbr", "2025", "DS4")],
            batchOfRow
        );
        expect(groups.map(group => group.label.year)).toEqual(["2025"]);
    });

    const finding = (overrides: Partial<MislabelFinding> = {}): MislabelFinding => ({
        fileValues: 14868,
        storedThere: 14868,
        differentThere: 0,
        copyInOwnPlace: 14868,
        sharedWith: [],
        ...overrides,
    });

    it("explains data stored twice, and that the app's delete would remove the wrong copy (GBR 2024)", () => {
        const { finding: text, fix } = explainMislabel(finding(), "GBR 2024 DS2", "GBR 2024 DS3", true);
        expect(text).toMatch(/stored twice: 14868 values under GBR 2024 DS2 and the same again under GBR 2024 DS3/);
        expect(text).toMatch(/deleting this upload in the app would delete values under GBR 2024 DS3/);
        expect(fix).toMatch(/Ask the country whether GBR 2024 DS2 or GBR 2024 DS3 is right/);
    });

    it("explains data stored only under the wrong label, or not at all", () => {
        expect(explainMislabel(finding({ copyInOwnPlace: 0 }), "A", "B", true).finding).toMatch(
            /stored only under B, none under A/
        );
        expect(explainMislabel(finding({ storedThere: 0 }), "A", "B", true).finding).toMatch(/not stored under B/);
    });

    it("calls a never-imported upload a refused file, unless values like its rows are stored with no imported file holding them (STP 2023)", () => {
        const refused = explainMislabel(
            finding({ sharedWith: [{ uploadId: "cMpu6LHfB3k", cells: 10276, differentValues: 0 }] }),
            "GAB 2017 DS2",
            "GAB 2018 DS1",
            false
        );
        expect(refused.finding).toMatch(/^never imported: the app refuses/);
        expect(refused.fix).toMatch(/^nothing in the data/);
        const wroteAnyway = explainMislabel(
            finding({ storedThere: 24, copyInOwnPlace: 0 }),
            "STP 2023 DS2",
            "STP 2023 DS1",
            false
        );
        expect(wroteAnyway.finding).toMatch(/24 values equal to its rows are stored under STP 2023 DS1/);
        expect(wroteAnyway.fix).toMatch(/^verify decides/);
    });

    it("warns first when another upload's values were overwritten", () => {
        const overwritten = finding({ sharedWith: [{ uploadId: "Cn62PM57bW1", cells: 10, differentValues: 4 }] });
        const { finding: text, fix } = explainMislabel(overwritten, "A", "B", true);
        expect(text).toMatch(/10 of its cells under B are also in upload Cn62PM57bW1's file, 4 with another value/);
        expect(fix).toMatch(/^First find out which upload's values are right/);
    });
});

describe("findChangesBeforeDelete", () => {
    const value = (dataElement: string, val: string, lastUpdated = "2025-06-24T07:41:50.000+0000") => ({
        ...dv(dataElement, val),
        lastUpdated,
    });
    const uploads = [upload({ id: "old", deleted: true }), upload({ id: "new", status: "UPLOADED" })];

    it("finds nothing when the uploads and the values to delete are as checked", () => {
        const deletable = [value("res", "1")];
        const now = { uploads: [...uploads], stored: [value("res", "1"), value("int", "2")] };
        expect(findChangesBeforeDelete({ uploads, deletable }, now)).toEqual([]);
    });

    it("reports an upload added or changed, and a value rewritten or gone", () => {
        const deletable = [value("res", "1"), value("int", "2")];
        const now = {
            uploads: [uploads[0] as UploadRecord, upload({ id: "new", status: "VALIDATED" })],
            stored: [value("res", "1", "2026-10-24T09:00:00.000+0000")],
        };
        expect(findChangesBeforeDelete({ uploads, deletable }, now)).toEqual([
            "upload now new 2024 DS1 VALIDATED live",
            "upload was new 2024 DS1 UPLOADED live",
            "value res|coc|aoc rewritten",
            "value int|coc|aoc gone",
        ]);
    });
});

describe("evidence helpers", () => {
    it("summarises who stored the values and when", () => {
        const values = [
            { storedBy: "iraq2", created: "2025-06-24T07:41:50.000+0000" },
            { storedBy: "iraq2", created: "2025-06-24T08:00:00.000+0000" },
            { storedBy: "emro1", created: "2026-10-08T10:00:00.000+0000" },
        ];
        expect(describeWrites(values)).toBe("2 written 2025-06-24 by iraq2; 1 written 2026-10-08 by emro1");
    });

    it("names the latest upload record made no later than a day after the values, deleted ones included", () => {
        const uploads = [
            upload({ id: "old", deleted: true, uploadDate: "2025-01-01T00:00:00.000Z" }),
            upload({ id: "source", deleted: true, uploadDate: "2025-06-24T07:30:00.000Z" }),
            upload({ id: "later", status: "UPLOADED", uploadDate: "2026-10-08T10:31:33.484Z" }),
            upload({ id: "no-date", uploadDate: "" }),
        ];
        const batch = { orgUnitId: "ou-irq", year: "2024", fileType: "RIS" as const, batchId: "DS1" };
        expect(findProbableSource(uploads, batch, "2025-06-24T07:41:50.000+0000")?.id).toBe("source");
        expect(findProbableSource(uploads, batch, "2020-01-01T00:00:00.000+0000")).toBeUndefined();
    });
});

describe("toAmrAggFileType", () => {
    // GNB 2025 on PROD: an AMR - Individual "SAMPLE File" upload held the SAMPLE values deleted as an orphan
    it("puts AMR - Individual SAMPLE files in the SAMPLE data set, and leaves out files stored elsewhere", () => {
        expect(["RIS", "SAMPLE", "SAMPLE File", "RIS Individual", "RIS Fungal", "EGASP"].map(toAmrAggFileType)).toEqual(
            ["RIS", "SAMPLE", "SAMPLE", undefined, undefined, undefined]
        );
    });
});

describe("valuesHeldByLiveFiles", () => {
    const value = (dataElement: string, aoc: string, v = "1") => ({
        dataElement,
        categoryOptionCombo: "coc-1",
        attributeOptionCombo: aoc,
        value: v,
    });

    // GNB 2025 SAMPLE DS1 on PROD: the Individual upload's record said DS2, its rows (so its values) said DS1
    it("finds the values a live upload's file maps to, whatever their value, and only those", () => {
        const toDelete = [value("de-1", "aoc-ds1"), value("de-2", "aoc-ds1"), value("de-1", "aoc-ds2")];
        const individualFile = [value("de-1", "aoc-ds1", "7"), value("de-2", "aoc-ds1")];

        expect(valuesHeldByLiveFiles(toDelete, [individualFile])).toEqual([toDelete[0], toDelete[1]]);
        expect(valuesHeldByLiveFiles(toDelete, [])).toEqual([]);
    });

    it("counts only uploads of the year that are not deleted and IMPORTED, VALIDATED or COMPLETED", () => {
        const statuses = ["UPLOADED", "IMPORTED", "VALIDATED", "COMPLETED"];

        expect(statuses.filter(status => isLiveUpload(upload({ status, year: "2025" }), "2025"))).toEqual([
            "IMPORTED",
            "VALIDATED",
            "COMPLETED",
        ]);
        expect(isLiveUpload(upload({ status: "COMPLETED", year: "2024" }), "2025")).toBe(false);
        expect(isLiveUpload(upload({ status: "COMPLETED", year: "2025", deleted: true }), "2025")).toBe(false);
    });
});

describe("findBatchOverlaps", () => {
    // Cells: categoryOptionCombo "coc-<n>", attribute option combo "<cell>-<batch>" (cellOf strips the batch).
    const cellOf = (aoc: string) => (aoc.startsWith("other") ? undefined : aoc.split("-")[0]);
    const row = (n: number, batch: string, resistant = "1") => [
        { dataElement: "res", categoryOptionCombo: `coc-${n}`, attributeOptionCombo: `amp-${batch}`, value: resistant },
        { dataElement: "sus", categoryOptionCombo: `coc-${n}`, attributeOptionCombo: `amp-${batch}`, value: "0" },
    ];
    const rows = (from: number, to: number, batch: string) =>
        Array.from({ length: to - from }, (_v, i) => row(from + i, batch)).flat();

    it("finds an upload stored twice (IND 2024 RIS: DS2 = DS1)", () => {
        const overlaps = findBatchOverlaps({ DS1: rows(0, 12, "DS1"), DS2: rows(0, 12, "DS2") }, cellOf);
        expect(overlaps).toEqual([
            { batchA: "DS1", batchB: "DS2", rowsA: 12, rowsB: 12, shared: 12, kind: "IDENTICAL" },
        ]);
        expect(describeOverlap(overlaps[0]!)).toBe("DS1 and DS2 are identical (12 shared rows; DS1 12, DS2 12)");
    });

    it("finds a file stored inside another batch (GBR 2024 RIS: DS2 inside DS3)", () => {
        const overlaps = findBatchOverlaps({ DS2: rows(0, 12, "DS2"), DS3: rows(0, 20, "DS3") }, cellOf);
        expect(overlaps.map(o => o.kind)).toEqual(["A_INSIDE_B"]);
    });

    it("ignores rows equal in only some data elements, small overlaps and combos outside the batches", () => {
        const differentResistant = Array.from({ length: 12 }, (_v, i) => row(i, "DS2", "5")).flat();
        const outside = rows(0, 12, "DS1").map(value => ({ ...value, attributeOptionCombo: "other-DS9" }));
        expect(findBatchOverlaps({ DS1: rows(0, 12, "DS1"), DS2: differentResistant }, cellOf)).toEqual([]);
        expect(findBatchOverlaps({ DS1: rows(0, 9, "DS1"), DS2: rows(0, 9, "DS2") }, cellOf)).toEqual([]);
        expect(findBatchOverlaps({ DS1: rows(0, 12, "DS1"), DS9: outside }, cellOf)).toEqual([]);
    });
});
