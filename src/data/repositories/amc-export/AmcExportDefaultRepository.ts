/*
================================================================
AMC full-data export — DHIS2 reader
================================================================
Streams one AMC export table (see domain/entities/data-entry/amc/AmcExportTable.ts) out of DHIS2 a
page at a time, handing each page to the caller as ready-to-write CSV rows and then discarding it.
Peak memory is one page, not one dataset, whatever the table's size.

This class uses only D2Api, so it runs unchanged in Node (the bulk export script) and in the browser
(a future in-app "download my country's data" button). Nothing here touches the filesystem — the
caller supplies the sink.

Deliberately NOT built on DownloadTemplateRepository / DownloadTemplate / the SheetBuilder stack:
that path exists to fill an Excel workbook, so it materialises the whole selection in memory, splits
runs by year to stay under a sheet's ~1,048,576-row cap, and translates option codes into option
uids for a named-range lookup. All three are wrong for a CSV dump, and none can be removed from it
without rewriting it.

FETCH SHAPE — and why each choice is what it is
-----------------------------------------------
* One request per (table x org unit). No year/period dimension at all: the previous export sliced
  every fetch by year purely to bound memory and respect the Excel row cap, which multiplied the
  request count ~10x for no benefit here, and made a date-boundary bug possible (`occurredBefore`
  formatted YYYY-MM-DD excludes same-day events with a time component).
* Server-side `programStage` filtering, so an event physically cannot land in the wrong table's file.
  The product program is the only multi-stage one; getting this wrong in a previous bulk script is
  the reason bulkDownloadAMRIndividualFiles.ts filters server-side too.
* `totalPages` on page 1 ONLY. DHIS2 runs a COUNT for every request that asks for a total, so asking
  on every page (as the old path did) roughly doubles the server work. Page 1's total is kept as the
  EXPECTED row count and reconciled against rows actually written — turning a per-page cost into a
  once-per-unit integrity check.
* Empty org units cost exactly one fast request. That is what makes it affordable to sweep every
  org unit the programs are assigned to instead of guessing the country list from upload records.
* Only the fields the CSV writes are requested. In particular tracked entities are fetched WITHOUT
  `relationships` — an AMC product relates to each of its consumption events, so that field is
  potentially the largest part of the response, and no exported column uses it.
*/

import { D2Api, SelectedPick } from "@eyeseetea/d2-api/2.34";
import { D2TrackerEventSchema } from "@eyeseetea/d2-api/api/trackerEvents";
import { D2TrackerTrackedEntitySchema } from "@eyeseetea/d2-api/api/trackerTrackedEntities";
import moment from "moment";

import {
    AmcExportTable,
    AmcTableColumns,
    buildSubstanceKey,
    missingSubstanceKeyCodes,
    PRODUCT_ID_ATTRIBUTE_CODE,
} from "../../../domain/entities/data-entry/amc/AmcExportTable";
import { Id } from "../../../domain/entities/Ref";
import { retryAsync } from "../../../utils/promises";

/** Tracker page size. 1000 is the value already proven against this instance by the existing
 *  download path; it is the cheapest performance lever to re-tune (see PAGE_SIZE in the script). */
export const DEFAULT_PAGE_SIZE = 1000;

/*
NO EXPLICIT `order` — deliberately, and it was measured rather than assumed.

The textbook concern is real in general: LIMIT/OFFSET paging without an ORDER BY lets a row move
between pages, appearing twice while another never appears — a failure the row-count reconciliation
cannot see, because one duplicate plus one omission nets to zero.

An explicit `order: "event:asc"` was therefore added, and turned out to be a serious mistake HERE:
the uid column is not usefully indexed for this filter combination, so Postgres sorted the whole
filtered set on every page. Measured on one country's product stage, page by page:

    page 1:  234ms unordered  ->   2,468ms ordered
    page 3:  271ms unordered  ->  12,971ms ordered
    page 5:  457ms unordered  ->  12,265ms ordered

It was then tested whether the risk it guarded against actually occurs on this API. It does not —
three full sweeps of the same unit, ordered and unordered twice:

    WITH order      rows=7830  distinct=7830  duplicates=0
    WITHOUT (run 1) rows=7830  distinct=7830  duplicates=0
    WITHOUT (run 2) rows=7830  distinct=7830  duplicates=0
    ordered vs unordered: identical sets.  run 1 vs run 2: reproducible.

DHIS2's tracker exporter applies its own stable order, so paging is already deterministic. Adding one
bought nothing and cost 10x. If a future instance ever DOES show duplicates, re-add the order for
that instance only — do not re-add it as a precaution here.
*/

export interface AmcRowContext {
    /** org unit uid -> country code, so every row is readable without a second lookup. */
    codeByOrgUnitId: Record<Id, string>;
    /** tracked entity uid -> the country's own product id, from the register. Only consulted by
     *  tables with `joinsProductRegister`; empty for every other table. */
    productIdByTrackedEntity: Map<Id, string>;
}

export interface AmcStreamResult {
    /** DHIS2's own count for this unit, read once from page 1. */
    expected: number;
    written: number;
    /** Data element / attribute uids that carried a value but are not in the program's metadata, so
     *  they had no column and their values are NOT in the file. Should always be empty. */
    unmappedIds: Set<Id>;
}

/*
Page retry: sized for SERVER LOAD, not for a network blip.

retryAsync's defaults (3 attempts, 2s base, full jitter) give up after roughly 6 seconds. A whole-
system run makes that too short: a real run lost 4 countries to HTTP 500s that all landed while
several very large countries were being swept concurrently — transient overload, retried three times
inside six seconds, and abandoned.

The cost of a longer window is paid only when a request actually fails, so it is close to free on a
healthy run, while turning "lost the rest of this country" into "waited and carried on". 5 attempts
at a 5s base gives delays of up to 5s, 10s, 20s and 40s.

This matters more than it looks: a page that fails for good ends the whole org unit's sweep, so every
page AFTER it is lost too — which is exactly how 4 failed requests cost 2,286 rows.
*/
export const DEFAULT_PAGE_RETRY = { attempts: 5, baseDelayMs: 5000 };

export class AmcExportDefaultRepository {
    constructor(
        private api: D2Api,
        private pageRetry: { attempts: number; baseDelayMs: number } = DEFAULT_PAGE_RETRY
    ) {}

    /** Every DHIS2 read in this class goes through here, so retry behaviour is set in one place. */
    private retry<T>(operation: () => Promise<T>): Promise<T> {
        return retryAsync(operation, this.pageRetry);
    }

    /*
    ================================================================
    Metadata — the column contract
    ================================================================
    A tracker record identifies its values by uid; the AMC column contract everyone works with is by
    CODE. One metadata read per table gives both the uid -> code map and the column ORDER.
    */

    public async getColumns(table: AmcExportTable): Promise<AmcTableColumns> {
        const { objects } = await this.api.models.programs
            .get({
                fields: {
                    id: true,
                    programStages: {
                        id: true,
                        name: true,
                        programStageDataElements: { dataElement: { id: true, code: true } },
                    },
                    programTrackedEntityAttributes: { trackedEntityAttribute: { id: true, code: true } },
                },
                filter: { id: { eq: table.programId } },
            })
            .getData();

        const program = objects[0];
        if (!program) throw new Error(`Program ${table.programId} not found on this DHIS2 instance.`);

        const entries =
            table.kind === "trackedEntities"
                ? program.programTrackedEntityAttributes.map(a => a.trackedEntityAttribute)
                : this.requireStage(program, table).programStageDataElements.map(psde => psde.dataElement);

        const codeById = new Map<Id, string>(
            entries.map(entry => {
                // A data element / attribute with no code cannot be named by the AMC column contract,
                // but dropping it would silently lose data. Fall back to the uid so the column still
                // exists and is still populated.
                if (!entry.code) {
                    console.warn(`[amc-export] ${table.id}: ${entry.id} has no code — using its uid as the header.`);
                }
                return [entry.id, entry.code || entry.id];
            })
        );

        const columns: AmcTableColumns = {
            valueCodes: entries.map(entry => codeById.get(entry.id) as string),
            codeById,
        };

        if (table.substanceKeySource) {
            const missing = missingSubstanceKeyCodes(table.substanceKeySource, columns.valueCodes);
            if (missing.length > 0) {
                console.warn(
                    `[amc-export] ${table.id}: substanceKey data element(s) not found in the program: ` +
                        `${missing.join(", ")}. Those parts of the key will be empty, so joins against the other ` +
                        `substance tables may not match.`
                );
            }
        }

        return columns;
    }

    private requireStage(
        program: { id: Id; programStages: { id: Id; name: string; programStageDataElements: any[] }[] },
        table: AmcExportTable
    ) {
        // A single-stage event program is taken as-is rather than by hardcoded uid, so the export
        // stays correct if a stage uid ever differs between instances.
        if (!table.programStageId) {
            const stage = program.programStages[0];
            if (!stage || program.programStages.length !== 1) {
                throw new Error(
                    `Expected program ${table.programId} to have exactly one stage for the ${table.id} export, ` +
                        `found ${program.programStages.length}. Refusing to guess which stage the columns describe.`
                );
            }
            return stage;
        }

        const stage = program.programStages.find(s => s.id === table.programStageId);
        if (!stage) {
            throw new Error(
                `Program stage ${table.programStageId} was not found among program ${table.programId}'s stages ` +
                    `(${program.programStages.map(s => `"${s.name}" (${s.id})`).join(", ")}) — refusing to export, ` +
                    `as this would silently produce an empty or wrong-stage table.`
            );
        }
        return stage;
    }

    /*
    ================================================================
    Counting — used for the whole-system completeness cross-check
    ================================================================
    Count-only: pageSize 1 with totalPages, so DHIS2 returns the total without sending record bodies.
    Omitting `orgUnitId` means ouMode=ALL — every org unit, including any the export's org-unit sweep
    does not cover. Comparing the two is what turns "we think this is complete" into "this is
    provably complete".
    */

    public async countRecords(table: AmcExportTable, orgUnitId?: Id): Promise<number> {
        const result = await this.retry(() => this.getPage(table, orgUnitId, 1, 1, true));
        if (result.total == null) {
            throw new Error(
                `${table.id}: response had no pagination total (org unit ${orgUnitId ?? "ALL"}) — cannot count.`
            );
        }
        return result.total;
    }

    /*
    ================================================================
    Streaming
    ================================================================
    */

    public async streamTable(params: {
        table: AmcExportTable;
        orgUnitId: Id;
        columns: AmcTableColumns;
        context: AmcRowContext;
        pageSize?: number;
        onRows: (rows: string[][]) => Promise<void>;
    }): Promise<AmcStreamResult> {
        const { table, orgUnitId, columns, context, pageSize = DEFAULT_PAGE_SIZE, onRows } = params;
        const unmappedIds = new Set<Id>();
        let expected = 0;
        let written = 0;
        let page = 1;

        for (;;) {
            const isFirstPage = page === 1;
            // Retry the individual page, not the whole org unit, so one transient/proxy-blocked
            // request does not force refetching every page already streamed for this unit. A page
            // that fails for good still ends the unit — and every page after it is lost — so the
            // error names exactly where the sweep stopped rather than just what went wrong.
            const result = await this.retry(() => this.getPage(table, orgUnitId, page, pageSize, isFirstPage)).catch(
                error => {
                    throw new Error(
                        `${table.id}: page ${page} failed for org unit ${orgUnitId} after ` +
                            `${
                                this.pageRetry.attempts
                            } attempts (${written.toLocaleString()} row(s) already written, ` +
                            `so rows from page ${page} onward are missing): ` +
                            (error instanceof Error ? error.message : String(error))
                    );
                }
            );

            if (isFirstPage) {
                // total === 0 is a legitimate "no data for this org unit". total missing means the
                // response carried no pagination info at all (a malformed response, e.g. a proxy
                // intercepting the request) — that must propagate as a real error rather than being
                // silently treated as "no data", or a country's data could vanish from the output
                // while the run reports success.
                if (result.total == null) {
                    throw new Error(
                        `${table.id}: response had no pagination total (org unit ${orgUnitId}, page 1) — ` +
                            `refusing to treat this as an empty result.`
                    );
                }
                expected = result.total;
                if (expected === 0) return { expected: 0, written: 0, unmappedIds };
            }

            // getPage returns whichever record type the table's `kind` selected; the cast pairs the
            // two halves of that single decision and is checked by nothing else in between.
            const rows =
                table.kind === "trackedEntities"
                    ? (result.instances as D2Entity[]).map(entity =>
                          this.buildRegisterRow(entity, table, columns, context, unmappedIds)
                      )
                    : (result.instances as D2Event[]).map(event =>
                          this.buildEventRow(event, table, columns, context, unmappedIds)
                      );

            await onRows(rows);
            written += rows.length;

            // Stop on a short page rather than on `written >= expected`: if rows were added between
            // page 1's count and now, trusting the stale total would truncate the export.
            if (result.instances.length < pageSize) return { expected, written, unmappedIds };
            page++;
        }
    }

    /**
     * Streams a whole tracker program — the register and every one of its stages — from ONE paginated
     * pass over its tracked entities. Rows are emitted per table via `onRows`.
     *
     * This exists because the events endpoint is drastically more expensive than the trackedEntities
     * endpoint for the same program on this instance (see the comment on trackerProgramFields, and
     * planExportUnits in AmcExportTable.ts). It also removes the ordering dependency the separate
     * approach needed: an event arrives inside its product, so productId is known immediately and no
     * cross-table index has to be built by an earlier pass.
     *
     * `expected` is the SERVER's tracked-entity count, so it reconciles the register only. Stage row
     * counts have no per-org-unit server count here — they are covered by the whole-system
     * ouMode=ALL reconciliation at the end of a run instead.
     */
    public async streamTrackerProgram(params: {
        programId: Id;
        registerTable: AmcExportTable;
        stageTables: AmcExportTable[];
        orgUnitId: Id;
        columnsByTableId: Map<string, AmcTableColumns>;
        codeByOrgUnitId: Record<Id, string>;
        pageSize?: number;
        onRows: (tableId: string, rows: string[][]) => Promise<void>;
        /** Populated with every tracked entity actually emitted, INCLUDING when this throws part-way.
         *  streamTrackerProgramFallback uses it to recover only what is missing, so a partial sweep
         *  followed by a recovery cannot double-write a row. */
        writtenTrackedEntities?: Set<Id>;
    }): Promise<{ registerExpected: number; writtenByTableId: Map<string, number>; unmappedIds: Set<Id> }> {
        const { programId, registerTable, stageTables, orgUnitId, columnsByTableId, codeByOrgUnitId } = params;
        const { pageSize = DEFAULT_PAGE_SIZE, onRows, writtenTrackedEntities } = params;

        const unmappedIds = new Set<Id>();
        const writtenByTableId = new Map<string, number>();
        const tableByStageId = new Map<Id, AmcExportTable>();
        for (const table of stageTables) {
            if (table.programStageId) tableByStageId.set(table.programStageId, table);
        }

        const registerColumns = columnsByTableId.get(registerTable.id);
        if (!registerColumns) throw new Error(`No columns resolved for ${registerTable.id}.`);

        let registerExpected = 0;
        let page = 1;

        for (;;) {
            const isFirstPage = page === 1;
            const result = await this.retry(async () => {
                const response = await this.api.tracker.trackedEntities
                    .get({
                        program: programId,
                        orgUnit: orgUnitId,
                        ouMode: "SELECTED",
                        fields: trackerProgramFields,
                        totalPages: isFirstPage,
                        page,
                        pageSize,
                    } as never)
                    .getData();
                return response as unknown as { total?: number; instances: NestedEntity[] };
            }).catch(error => {
                // As in streamTable: a permanently failed page ends the sweep, so every page after it
                // is lost too. Name where it stopped, not just what failed.
                const writtenSoFar = [...writtenByTableId.values()].reduce((sum, count) => sum + count, 0);
                throw new Error(
                    `${registerTable.id}: page ${page} failed for org unit ${orgUnitId} after ` +
                        `${this.pageRetry.attempts} attempts (${writtenSoFar.toLocaleString()} row(s) already ` +
                        `written across this program's tables, so rows from page ${page} onward are missing): ` +
                        (error instanceof Error ? error.message : String(error))
                );
            });

            if (isFirstPage) {
                if (result.total == null) {
                    throw new Error(
                        `${registerTable.id}: response had no pagination total (org unit ${orgUnitId}, page 1) — ` +
                            `refusing to treat this as an empty result.`
                    );
                }
                registerExpected = result.total;
                if (registerExpected === 0) return { registerExpected: 0, writtenByTableId, unmappedIds };
            }

            const rowsByTableId = new Map<string, string[][]>();
            const push = (tableId: string, row: string[]) => {
                const existing = rowsByTableId.get(tableId);
                if (existing) existing.push(row);
                else rowsByTableId.set(tableId, [row]);
            };

            for (const entity of result.instances) {
                const registerRow = this.buildRegisterRow(
                    entity as unknown as D2Entity,
                    registerTable,
                    registerColumns,
                    { codeByOrgUnitId, productIdByTrackedEntity: new Map() },
                    unmappedIds
                );
                push(registerTable.id, registerRow);
                // Recorded BEFORE the page is handed to onRows, so a later failure still leaves an
                // accurate record of what was emitted — that set is what makes recovery exact.
                writtenTrackedEntities?.add(entity.trackedEntity);

                // The product id sits on the entity, and its events are right here in the same
                // object — so it is read once and applied directly, with no index to build.
                const productId = this.readProductId(entity, registerColumns);

                for (const enrollment of entity.enrollments ?? []) {
                    // A tracked entity can in principle be enrolled in other programs; their events
                    // are not this export's rows.
                    if (enrollment.program !== programId) continue;
                    for (const event of enrollment.events ?? []) {
                        const table = event.programStage ? tableByStageId.get(event.programStage) : undefined;
                        // A stage the caller did not ask for (or does not know about) is skipped
                        // rather than guessed into some other table's file.
                        if (!table) continue;
                        const columns = columnsByTableId.get(table.id);
                        if (!columns) continue;
                        push(
                            table.id,
                            this.buildEventRowFrom({
                                event,
                                table,
                                columns,
                                codeByOrgUnitId,
                                trackedEntity: entity.trackedEntity,
                                productId,
                                unmappedIds,
                            })
                        );
                    }
                }
            }

            for (const [tableId, rows] of rowsByTableId) {
                await onRows(tableId, rows);
                writtenByTableId.set(tableId, (writtenByTableId.get(tableId) ?? 0) + rows.length);
            }

            // Stop on a short page rather than on a running total: if entities were added between
            // page 1's count and now, trusting the stale total would truncate the sweep.
            if (result.instances.length < pageSize) return { registerExpected, writtenByTableId, unmappedIds };
            page++;
        }
    }

    /**
     * Recovers one org unit that the nested sweep could not finish, using the two request shapes that
     * DO work for it: the register WITHOUT nested events, and the events endpoint per stage.
     *
     * WHY THIS EXISTS — a DHIS2 defect, not a design flaw
     * ---------------------------------------------------
     * Some tracked entities cannot be serialised with their events nested. Verified on one of them:
     * its events read back perfectly normally from the events endpoint (two events, one per stage,
     * status COMPLETED, sensible dates); the entity itself reads fine without events; but asking for
     * that entity WITH events fails with HTTP 500 — for any nested field (even just `event`), at any
     * page size down to 1, and when fetched by id rather than by page. It is deterministic: the same
     * countries fail on the same pages on every run, so retrying cannot help.
     *
     * The nested sweep is still the right default — it is roughly an order of magnitude faster and
     * covers ~98% of countries. This just catches the ones the server cannot serve that way.
     *
     * NO DOUBLE-WRITING
     * -----------------
     * The failed sweep has already emitted whole pages before dying, so recovery is filtered by
     * IDENTITY, never by position: entities already in `alreadyWritten` are skipped, and only their
     * complement's events are emitted. That holds even if the two field sets happen to page
     * differently, which position-based resumption would silently get wrong.
     */
    public async streamTrackerProgramFallback(params: {
        programId: Id;
        registerTable: AmcExportTable;
        stageTables: AmcExportTable[];
        orgUnitId: Id;
        columnsByTableId: Map<string, AmcTableColumns>;
        codeByOrgUnitId: Record<Id, string>;
        pageSize?: number;
        alreadyWritten: Set<Id>;
        onRows: (tableId: string, rows: string[][]) => Promise<void>;
    }): Promise<{ writtenByTableId: Map<string, number>; unmappedIds: Set<Id> }> {
        const { programId, registerTable, stageTables, orgUnitId, columnsByTableId, codeByOrgUnitId } = params;
        const { pageSize = DEFAULT_PAGE_SIZE, alreadyWritten, onRows } = params;

        const unmappedIds = new Set<Id>();
        const writtenByTableId = new Map<string, number>();
        const registerColumns = columnsByTableId.get(registerTable.id);
        if (!registerColumns) throw new Error(`No columns resolved for ${registerTable.id}.`);

        const bump = (tableId: string, count: number) =>
            writtenByTableId.set(tableId, (writtenByTableId.get(tableId) ?? 0) + count);

        // Pass 1 — the register, without nested events. Only entities the failed sweep never reached.
        const recovered = new Map<Id, string>(); // trackedEntity -> productId, for pass 2's rows
        let page = 1;
        for (;;) {
            const result = await this.retry(() =>
                this.api.tracker.trackedEntities
                    .get({
                        program: programId,
                        orgUnit: orgUnitId,
                        ouMode: "SELECTED",
                        fields: entityFields,
                        page,
                        pageSize,
                    })
                    .getData()
            );

            const rows: string[][] = [];
            for (const entity of result.instances as D2Entity[]) {
                const id = entity.trackedEntity ?? "";
                if (!id || alreadyWritten.has(id)) continue;
                rows.push(
                    this.buildRegisterRow(
                        entity,
                        registerTable,
                        registerColumns,
                        { codeByOrgUnitId, productIdByTrackedEntity: new Map() },
                        unmappedIds
                    )
                );
                recovered.set(id, this.readProductId(entity as unknown as NestedEntity, registerColumns));
            }
            if (rows.length > 0) {
                await onRows(registerTable.id, rows);
                bump(registerTable.id, rows.length);
            }

            if (result.instances.length < pageSize) break;
            page++;
        }

        // Pass 2 — each stage's events, keeping only those belonging to entities recovered above.
        // The whole org unit's events are fetched because the endpoint cannot be filtered to a set of
        // entities; the filtering is done here, which is exact and costs only bandwidth.
        for (const table of stageTables) {
            const columns = columnsByTableId.get(table.id);
            if (!columns) continue;

            let eventPage = 1;
            for (;;) {
                const result = await this.retry(() => this.getPage(table, orgUnitId, eventPage, pageSize, false));

                const rows: string[][] = [];
                for (const event of result.instances as D2Event[]) {
                    const trackedEntity = event.trackedEntity ?? "";
                    const productId = recovered.get(trackedEntity);
                    if (productId === undefined) continue; // already emitted by the nested sweep
                    rows.push(
                        this.buildEventRowFrom({
                            event,
                            table,
                            columns,
                            codeByOrgUnitId,
                            trackedEntity,
                            productId,
                            unmappedIds,
                        })
                    );
                }
                if (rows.length > 0) {
                    await onRows(table.id, rows);
                    bump(table.id, rows.length);
                }

                if (result.instances.length < pageSize) break;
                eventPage++;
            }
        }

        return { writtenByTableId, unmappedIds };
    }

    private readProductId(entity: NestedEntity, registerColumns: AmcTableColumns): string {
        for (const attribute of entity.attributes ?? []) {
            if (registerColumns.codeById.get(attribute.attribute) === PRODUCT_ID_ATTRIBUTE_CODE) {
                return attribute.value ?? "";
            }
        }
        return "";
    }

    /** Narrowed to the two properties this class reads. d2-api re-exports its tracker response types
     *  from more than one module path, so letting the two branches' full response types form a union
     *  makes TypeScript treat them as unrelated duplicates. */
    private async getPage(
        table: AmcExportTable,
        orgUnitId: Id | undefined,
        page: number,
        pageSize: number,
        totalPages: boolean
    ): Promise<{ total?: number; instances: (D2Event | D2Entity)[] }> {
        // ouMode SELECTED with an explicit org unit is exactly the shape the existing, working
        // download path and the coverage audit both use against this instance — so exported counts
        // are directly comparable with the audit's baselines. No org unit means ouMode ALL.
        const scope = orgUnitId ? ({ orgUnit: orgUnitId, ouMode: "SELECTED" } as const) : ({ ouMode: "ALL" } as const);

        if (table.kind === "trackedEntities") {
            const response = await this.api.tracker.trackedEntities
                .get({ program: table.programId, ...scope, fields: entityFields, totalPages, page, pageSize })
                .getData();
            return { total: response.total, instances: response.instances };
        }

        const response = await this.api.tracker.events
            .get({
                program: table.programId,
                // Only send programStage when the table names one: passing undefined can serialise
                // into the query string as an empty value and be rejected.
                ...(table.programStageId ? { programStage: table.programStageId } : {}),
                ...scope,
                fields: eventFields,
                totalPages,
                page,
                pageSize,
            })
            .getData();
        return { total: response.total, instances: response.instances };
    }

    /*
    ================================================================
    Row building
    ================================================================
    Values are the codes DHIS2 actually stores, so an option-set column reads e.g. "ORAL", never an
    option uid. (The workbook path converts codes to option uids because a generated sheet resolves
    the label through a named range; a CSV wants the stored code.)
    */

    private buildEventRow(
        event: D2Event,
        table: AmcExportTable,
        columns: AmcTableColumns,
        context: AmcRowContext,
        unmappedIds: Set<Id>
    ): string[] {
        // Standalone events carry their own trackedEntity and rely on the register index built by an
        // earlier pass; nested events get both handed to them directly (see buildNestedEventRow).
        const trackedEntity = event.trackedEntity ?? "";
        return this.buildEventRowFrom({
            event,
            table,
            columns,
            codeByOrgUnitId: context.codeByOrgUnitId,
            trackedEntity,
            productId: context.productIdByTrackedEntity.get(trackedEntity) ?? "",
            unmappedIds,
        });
    }

    /** The one row-building implementation both fetch shapes use. Kept parameterised on
     *  trackedEntity/productId rather than reading them off the event, because a nested event has no
     *  trackedEntity of its own — it is implied by the entity it arrived inside. */
    private buildEventRowFrom(params: {
        event: EventLike;
        table: AmcExportTable;
        columns: AmcTableColumns;
        codeByOrgUnitId: Record<Id, string>;
        trackedEntity: string;
        productId: string;
        unmappedIds: Set<Id>;
    }): string[] {
        const { event, table, columns, codeByOrgUnitId, trackedEntity, productId, unmappedIds } = params;
        const orgUnitCode = codeByOrgUnitId[event.orgUnit] ?? "";
        // moment.utc, NOT moment: an AMC event date is a reporting CALENDAR DATE, not an instant, so
        // it must not be re-interpreted through whatever timezone the exporting machine happens to
        // sit in. Plain moment().format() renders in local time, which shifts a midnight-UTC date
        // across a day boundary — and since substanceKey takes its year from this string, a shifted
        // row silently stops joining to its counterparts. Parsing as UTC makes the output identical
        // on every machine, which is the property that actually matters.
        const period = moment.utc(event.occurredAt).format("YYYY-MM-DD");
        const valueByCode = new Map<string, string>();

        for (const dataValue of event.dataValues ?? []) {
            const code = columns.codeById.get(dataValue.dataElement);
            if (code === undefined) unmappedIds.add(dataValue.dataElement);
            else valueByCode.set(code, String(dataValue.value ?? ""));
        }

        return [
            event.event ?? "",
            ...(table.joinsProductRegister ? [trackedEntity, productId] : []),
            orgUnitCode,
            event.orgUnit,
            period,
            ...(table.joinsProductRegister ? [event.programStage ?? ""] : []),
            ...columns.valueCodes.map(code => valueByCode.get(code) ?? ""),
            ...(table.substanceKeySource
                ? [buildSubstanceKey(orgUnitCode, period, valueByCode, table.substanceKeySource)]
                : []),
        ];
    }

    private buildRegisterRow(
        entity: D2Entity,
        table: AmcExportTable,
        columns: AmcTableColumns,
        context: AmcRowContext,
        unmappedIds: Set<Id>
    ): string[] {
        const valueByCode = new Map<string, string>();
        for (const attribute of entity.attributes ?? []) {
            const code = columns.codeById.get(attribute.attribute);
            if (code === undefined) unmappedIds.add(attribute.attribute);
            else valueByCode.set(code, String(attribute.value ?? ""));
        }

        // The enrollment into THIS program at THIS org unit — a tracked entity can in principle carry
        // enrollments into others, and mixing them would misdate the row.
        const enrollment = (entity.enrollments ?? []).find(
            candidate => candidate.program === table.programId && candidate.orgUnit === entity.orgUnit
        );

        return [
            entity.trackedEntity ?? "",
            enrollment?.enrollment ?? "",
            context.codeByOrgUnitId[entity.orgUnit] ?? "",
            entity.orgUnit,
            enrollment?.enrolledAt ?? "",
            enrollment?.occurredAt ?? "",
            ...columns.valueCodes.map(code => valueByCode.get(code) ?? ""),
        ];
    }
}

/*
================================================================
Requested fields — scoped to exactly what the CSV writes
================================================================
*/

const eventFields = {
    event: true,
    orgUnit: true,
    occurredAt: true,
    programStage: true,
    trackedEntity: true,
    dataValues: { dataElement: true, value: true },
} as const;

// No `relationships`, `geometry` or `featureType`: an AMC product relates to every one of its
// consumption events, so relationships alone can dominate the response, and no column uses them.
const entityFields = {
    trackedEntity: true,
    orgUnit: true,
    attributes: { attribute: true, value: true },
    enrollments: { enrollment: true, program: true, orgUnit: true, enrolledAt: true, occurredAt: true },
} as const;

type D2Event = SelectedPick<D2TrackerEventSchema, typeof eventFields>;
type D2Entity = SelectedPick<D2TrackerTrackedEntitySchema, typeof entityFields>;

/** The event shape row-building actually reads. Satisfied both by a top-level event from the events
 *  endpoint and by one nested inside an enrollment, which is why it is structural rather than either
 *  concrete d2-api type. */
interface EventLike {
    event?: string;
    orgUnit: string;
    occurredAt: string;
    programStage?: string;
    dataValues?: { dataElement: Id; value?: string }[];
    trackedEntity?: string;
}

/*
================================================================
Nested tracker fetch — the register and every stage in ONE pass
================================================================
A tracker program's events come back inside their tracked entity's enrollments, so this single
request yields the register rows AND both stages' event rows. See planExportUnits in
AmcExportTable.ts for the measurements that make this the default for the product program.

`enrollments.events` is not separately paginated by DHIS2 — an entity carries all of its events — so
paging over entities is enough to page over everything. Verified against a known-truth country:
one sweep returned TEIs=7861 raw=7830 calc=7778, matching the per-endpoint counts exactly.
*/
const trackerProgramFields = {
    trackedEntity: true,
    orgUnit: true,
    attributes: { attribute: true, value: true },
    enrollments: {
        enrollment: true,
        program: true,
        orgUnit: true,
        enrolledAt: true,
        occurredAt: true,
        events: {
            event: true,
            programStage: true,
            occurredAt: true,
            orgUnit: true,
            dataValues: { dataElement: true, value: true },
        },
    },
} as const;

/** Structural shape of the nested response. Declared locally rather than derived via SelectedPick:
 *  d2-api's tracked-entity schema does not model `enrollments.events` deeply enough to pick from. */
interface NestedEntity {
    trackedEntity: string;
    orgUnit: string;
    attributes?: { attribute: Id; value?: string }[];
    enrollments?: {
        enrollment: string;
        program: Id;
        orgUnit: string;
        enrolledAt?: string;
        occurredAt?: string;
        events?: EventLike[];
    }[];
}
