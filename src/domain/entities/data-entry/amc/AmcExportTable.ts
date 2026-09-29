/*
================================================================
AMC full-data export — table contract
================================================================
The five tables a complete AMC export produces, and the column contract each one follows. This file
is PURE: no DHIS2 client, no filesystem, no Node built-ins. It is the shared vocabulary between the
Node bulk-export script and any future in-app ("download my country's data") caller, so neither can
drift from the other's column layout.

THE AMC PIPELINE (why there are five tables and not three)
---------------------------------------------------------
A country reports by one of two routes, and both converge on the same calculated program:

    PRODUCT ROUTE (83 countries)                    SUBSTANCE ROUTE (16 countries)
      (1) Product Register           G6ChA5zMW9n
          the catalogue: what each product IS
          (ATC, strength, pack size, salt, route)
              |                                             |
      (2) Raw Product Consumption    GmElQHKXLIE     (4) Raw Substance Consumption  q8aSKr17J5S
          "N packs of product X in 2023"                    "N DDDs of substance Y in 2023"
              |                                             |
      (3) Raw Product Consumption Calculated                |
          q8cl5qllyjd — packs converted to substance        |
          terms, still ONE ROW PER PRODUCT                  |
              |                                             |
              +---------------> (5) <----------------------+

          (5) Substance Consumption Calculated  eUmWZeKZNrg
              97 countries — the comparable, analysis-ready dataset

(5) is the endpoint every country lands in regardless of route, which is why its country count (97)
is the UNION of the two routes (83 product + 16 substance, 2 reporting both) rather than either one.
Its DHIS2 name says "Substance Consumption Calculated", which reads as "calculated FROM substance
submissions" and is the single most common misreading of this model — hence the deliberately neutral
table id `consumption_calculated` here. See also PROGRAM_LABELS in domain/utils/DownloadTemplate.ts.

(1)-(4) are the provenance trail: they let a number in (5) be traced back to the packs a country
actually reported. Most analysis only needs (5).
*/

import { Id } from "../../Ref";
import {
    AMC_CALCULATED_CONSUMPTION_DATA_PROGRAM_ID as AMC_SUBSTANCE_CALCULATED_CONSUMPTION_PROGRAM_ID,
    AMC_PRODUCT_REGISTER_PROGRAM_ID,
    AMC_RAW_PRODUCT_CONSUMPTION_STAGE_ID,
    AMC_RAW_SUBSTANCE_CONSUMPTION_CALCULATED_STAGE_ID as AMC_RAW_PRODUCT_CONSUMPTION_CALCULATED_STAGE_ID,
    AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID,
} from "./amcProgramIds";

// Re-exported for existing importers; the values live in amcProgramIds.
export {
    AMC_PRODUCT_REGISTER_PROGRAM_ID,
    AMC_RAW_PRODUCT_CONSUMPTION_CALCULATED_STAGE_ID,
    AMC_RAW_PRODUCT_CONSUMPTION_STAGE_ID,
    AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID,
    AMC_SUBSTANCE_CALCULATED_CONSUMPTION_PROGRAM_ID,
};

export type AmcExportTableId =
    | "consumption_calculated"
    | "product_register"
    | "product_consumption_raw"
    | "product_consumption_calculated"
    | "substance_consumption_raw";

/*
================================================================
substanceKey — the product <-> substance join key
================================================================
The substance programs hold no tracked entity, so nothing links them to products by uid. The only
real link is the substance dimension both sides describe, so every substance-bearing table carries a
`substanceKey` built identically from values already present in the row:

    orgUnitCode | year | atc | route_admin | salt | combination | health_sector | health_level

The source data element differs per table (`*_manual` on the country-submitted table, `*_autocalculated`
on the two calculated ones) — including one asymmetry the key exists to absorb, `combination_manual`
vs `combination_code_autocalculated`. Normalising that away is the whole point.
*/

const SUBSTANCE_DIMENSIONS = ["atc", "route_admin", "salt", "combination", "health_sector", "health_level"] as const;
type SubstanceDimension = typeof SUBSTANCE_DIMENSIONS[number];

export type SubstanceKeySource = "manual" | "autocalculated";

const SUBSTANCE_KEY_CODES: Record<SubstanceKeySource, Record<SubstanceDimension, string>> = {
    manual: {
        atc: "atc_manual",
        route_admin: "route_admin_manual",
        salt: "salt_manual",
        combination: "combination_manual",
        health_sector: "health_sector_manual",
        health_level: "health_level_manual",
    },
    autocalculated: {
        atc: "atc_autocalculated",
        route_admin: "route_admin_autocalculated",
        salt: "salt_autocalculated",
        combination: "combination_code_autocalculated",
        health_sector: "health_sector_autocalculated",
        health_level: "health_level_autocalculated",
    },
};

export function buildSubstanceKey(
    orgUnitCode: string,
    period: string,
    valueByCode: Map<string, string>,
    source: SubstanceKeySource
): string {
    const parts = SUBSTANCE_DIMENSIONS.map(dimension => valueByCode.get(SUBSTANCE_KEY_CODES[source][dimension]) ?? "");
    return [orgUnitCode, period.slice(0, 4), ...parts].join("|");
}

/** Key data elements declared by the naming convention but absent from the program. The key is still
 *  emitted (with those parts empty) so an export never fails over it — but a silently degraded join
 *  key is far worse than a loud one, so the caller reports these. */
export function missingSubstanceKeyCodes(source: SubstanceKeySource, presentCodes: string[]): string[] {
    const present = new Set(presentCodes);
    return SUBSTANCE_DIMENSIONS.map(dimension => SUBSTANCE_KEY_CODES[source][dimension]).filter(
        code => !present.has(code)
    );
}

/*
================================================================
Table definitions
================================================================
*/

/** The tracked entity attribute holding the country's own product identifier (see
 *  AMCProductDataDefaultRepository.AMR_GLASS_AMC_TEA_PRODUCT_ID). It lives on the REGISTER, not on
 *  the consumption events — which is why the two product event tables can only carry it once the
 *  register has been read. */
export const PRODUCT_ID_ATTRIBUTE_CODE = "AMR_GLASS_AMC_TEA_PRODUCT_ID";

export interface AmcExportTable {
    id: AmcExportTableId;
    fileName: string;
    kind: "trackedEntities" | "events";
    programId: Id;
    /** Events are fetched with a server-side programStage filter, so a row can never land in the
     *  wrong table's file. Only the product program has more than one stage. */
    programStageId?: Id;
    substanceKeySource?: SubstanceKeySource;
    /** True when the table's events hang off a product tracked entity, so their rows can carry the
     *  register's product id denormalised. Requires the register to have been exported first. */
    joinsProductRegister: boolean;
    description: string;
}

export const AMC_EXPORT_TABLES: AmcExportTable[] = [
    {
        id: "consumption_calculated",
        fileName: "AMC_consumption_calculated.csv",
        kind: "events",
        programId: AMC_SUBSTANCE_CALCULATED_CONSUMPTION_PROGRAM_ID,
        substanceKeySource: "autocalculated",
        joinsProductRegister: false,
        description:
            "(5) Substance Consumption Calculated — every reporting country, both routes. THE analysis dataset.",
    },
    {
        id: "product_register",
        fileName: "AMC_product_register.csv",
        kind: "trackedEntities",
        programId: AMC_PRODUCT_REGISTER_PROGRAM_ID,
        joinsProductRegister: false,
        description: "(1) Product Register — the product catalogue. Reference data; holds no consumption figures.",
    },
    {
        id: "product_consumption_raw",
        fileName: "AMC_product_consumption_raw.csv",
        kind: "events",
        programId: AMC_PRODUCT_REGISTER_PROGRAM_ID,
        programStageId: AMC_RAW_PRODUCT_CONSUMPTION_STAGE_ID,
        joinsProductRegister: true,
        description: "(2) Raw Product Consumption — as submitted, per product per year.",
    },
    {
        id: "product_consumption_calculated",
        fileName: "AMC_product_consumption_calculated.csv",
        kind: "events",
        programId: AMC_PRODUCT_REGISTER_PROGRAM_ID,
        programStageId: AMC_RAW_PRODUCT_CONSUMPTION_CALCULATED_STAGE_ID,
        substanceKeySource: "autocalculated",
        joinsProductRegister: true,
        description: "(3) Raw Product Consumption Calculated — per-product intermediate, not the final answer.",
    },
    {
        id: "substance_consumption_raw",
        fileName: "AMC_substance_consumption_raw.csv",
        kind: "events",
        programId: AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID,
        substanceKeySource: "manual",
        joinsProductRegister: false,
        description: "(4) Raw Substance Consumption — as submitted by countries reporting at substance level.",
    },
];

/*
================================================================
Export units — what gets fetched in ONE pass
================================================================
A tracker program's tracked entities and ALL of its stages' events come back from a single
trackedEntities request, because the events are nested inside each entity's enrollments. So the three
product tables are not three independent fetches — they are three different projections of one
response, and grouping them that way is both faster and simpler:

  * Speed: on extranet.who.int/dhis2-indiv the events endpoint costs roughly 60x per row what the
    trackedEntities endpoint does for the same program (measured: 818,166 rows in 49 MINUTES via
    events, versus 835,463 rows in 49 SECONDS via trackedEntities). One nested sweep of Burkina Faso
    returned the register plus both stages in 6.4s; the events endpoint took 28.7s for one stage
    alone.
  * Simplicity: an event and its product arrive together, so productId needs no cross-table index
    and no ordering dependency between tables.

Standalone event programs (the two substance tables) have no tracked entity, so each remains its own
single-table unit fetched from the events endpoint — which is fine there, as those programs are small
and lack the tracker join that makes the product program's events expensive.
*/

export type AmcExportUnit =
    | { kind: "trackerProgram"; programId: Id; registerTable: AmcExportTable; stageTables: AmcExportTable[] }
    | { kind: "eventProgram"; programId: Id; table: AmcExportTable };

/** Groups the selected tables into the passes that will actually be fetched. A tracker program's
 *  tables collapse into one unit; every standalone event program stays its own. */
export function planExportUnits(tables: AmcExportTable[]): AmcExportUnit[] {
    const units: AmcExportUnit[] = [];
    const trackerTables = tables.filter(table => table.programId === AMC_PRODUCT_REGISTER_PROGRAM_ID);

    if (trackerTables.length > 0) {
        const registerTable = trackerTables.find(table => table.kind === "trackedEntities");
        const stageTables = trackerTables.filter(table => table.kind === "events");
        if (!registerTable) {
            // Stage tables without the register would still export correctly (the nested sweep reads
            // the entities regardless) — they simply produce no register file. Rather than special-
            // case that, each stage table falls back to its own event-program pass.
            for (const table of stageTables) units.push({ kind: "eventProgram", programId: table.programId, table });
        } else {
            units.push({
                kind: "trackerProgram",
                programId: AMC_PRODUCT_REGISTER_PROGRAM_ID,
                registerTable,
                stageTables,
            });
        }
    }

    for (const table of tables) {
        if (table.programId !== AMC_PRODUCT_REGISTER_PROGRAM_ID) {
            units.push({ kind: "eventProgram", programId: table.programId, table });
        }
    }

    return units;
}

/** Every table an export unit writes, in file order. */
export function tablesOfUnit(unit: AmcExportUnit): AmcExportTable[] {
    return unit.kind === "trackerProgram" ? [unit.registerTable, ...unit.stageTables] : [unit.table];
}

/*
================================================================
Column contract
================================================================
Headers are deliberately IDENTICAL to those the previous CSV mode of bulkDownloadAMUFiles.ts emitted,
so old and new output can be diffed row-for-row during changeover. Only the file NAMES changed.
*/

export interface AmcTableColumns {
    /** Attribute (register) or data element (events) CODES, in program order — the same names the
     *  upload templates use. A metadata object with no code falls back to its uid, so a column always
     *  exists and is always populated. */
    valueCodes: string[];
    codeById: Map<Id, string>;
}

export function buildHeaders(table: AmcExportTable, columns: AmcTableColumns): string[] {
    if (table.kind === "trackedEntities") {
        return [
            "trackedEntity",
            "enrollment",
            "orgUnitCode",
            "orgUnit",
            "enrollmentDate",
            "incidentDate",
            ...columns.valueCodes,
        ];
    }

    return [
        "event",
        ...(table.joinsProductRegister ? ["trackedEntity", "productId"] : []),
        "orgUnitCode",
        "orgUnit",
        "period",
        ...(table.joinsProductRegister ? ["programStage"] : []),
        ...columns.valueCodes,
        ...(table.substanceKeySource ? ["substanceKey"] : []),
    ];
}

/* A former `productRegisterColumnIndexes` helper lived here, to locate trackedEntity/productId by
   POSITION in an already-built register row so a separate pass could index them. The nested tracker
   fetch removed the need: an event now arrives inside its own product, so the product id is read
   straight off the entity's attributes (see readProductId in AmcExportDefaultRepository) and no
   position-based coupling to the row layout exists any more. */
