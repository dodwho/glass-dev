import { boolean, command, flag, option, run } from "cmd-ts";
import dotenv from "dotenv";
import _ from "lodash";
import { D2Api } from "@eyeseetea/d2-api/2.34";
import { describeAuth, getEnvVars, getInstance, StringsSeparatedByCommas, warmUpSession } from "./common";
import { getD2APiFromInstance } from "../utils/d2-api";
import { Id } from "../domain/entities/Ref";
import {
    AMC_CALCULATED_CONSUMPTION_DATA_PROGRAM_ID as AMC_SUBSTANCE_CALCULATED_CONSUMPTION_PROGRAM_ID,
    AMC_PRODUCT_REGISTER_PROGRAM_ID,
    AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID,
} from "../domain/entities/data-entry/amc/amcProgramIds";

dotenv.config();

/*
================================================================
AMC: delete all Tracker data for a given org unit + period.

Use this to clean up partially-imported / orphaned AMC data so a
country+year can be re-uploaded cleanly.

For each (orgUnit, period) it clears every program in TARGET_PROGRAM_IDS below:
the product register (a tracker program — deleting a TEI cascades to its enrollment,
raw-product-consumption events and calculated stage events), the raw and calculated
substance consumption event programs, and the APVD copies of those programs.

Whether a program is deleted as tracked entities or as events is read from the
instance's own metadata (programType), not assumed here — so adding a program id to
the list is all that is needed, and a wrong assumption cannot silently delete nothing.
Program ids that do not exist on the target instance are reported and skipped.

SAFETY: dry-run by default — it only reports what it *would* delete.
Pass --commit to actually delete.

Run (dry run):   yarn amc-delete-data --orgUnits ARM --periods 2014
Run (delete):    yarn amc-delete-data --orgUnits ARM --periods 2014 --commit

Several countries / years at once (cross product of the two lists):
                 yarn amc-delete-data --orgUnits ARM,ESP --periods 2014,2015

(set DOTENV_CONFIG_PATH=.env.local the same way you run the bulk upload script)
================================================================
*/

/**
 * Every AMC program a country+year's data can live in.
 *
 * The three APVD copies are cleaned as a precaution: a country+year is only truly re-uploadable
 * if no stale rows survive in them either. They are expected to be empty on most instances, and
 * are skipped with a warning wherever they do not exist.
 */
const TARGET_PROGRAM_IDS: Id[] = [
    AMC_PRODUCT_REGISTER_PROGRAM_ID,
    AMC_SUBSTANCE_CALCULATED_CONSUMPTION_PROGRAM_ID,
    AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID,
    // APVD copies of the above.
    "zMD4VltVy3v",
    "x6AC7eEnOHS",
    "s6WqZFyx88P",
];

const PAGE_SIZE = 250;
const DELETE_CHUNK = 100;

type TargetProgram = { id: Id; name: string; kind: "trackedEntities" | "events" };

/**
 * Resolve name and type for each target program. A tracker program (WITH_REGISTRATION) is cleared by
 * deleting its tracked entities; an event program by deleting its events.
 */
async function resolveTargetPrograms(api: D2Api, programIds: Id[]): Promise<TargetProgram[]> {
    const response = await api.models.programs
        .get({ fields: { id: true, name: true, programType: true }, filter: { id: { in: programIds } }, paging: false })
        .getData();

    const programsById = _.keyBy(response.objects, program => program.id);

    return _.compact(
        programIds.map(id => {
            const program = programsById[id];
            if (!program) {
                console.warn(`  [skip] program ${id} does not exist on this instance`);
                return undefined;
            }
            return {
                id,
                name: program.name,
                kind: program.programType === "WITH_REGISTRATION" ? ("trackedEntities" as const) : ("events" as const),
            };
        })
    );
}

async function resolveOrgUnitsByCode(api: D2Api): Promise<{ [code: string]: string }> {
    const response = await api.models.organisationUnits
        .get({ fields: { id: true, code: true }, filter: { level: { eq: "3" } }, paging: false })
        .getData();

    const map: { [code: string]: string } = {};
    response.objects.forEach(ou => {
        if (ou.code) map[ou.code] = ou.id;
    });
    // Kosovo (special-cased in the bulk upload script)
    map["601624"] = "I8AMbKhxlj9";
    return map;
}

async function getTrackedEntityIds(api: D2Api, orgUnitId: string, period: string, programId: Id): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
        const response = await api.tracker.trackedEntities
            .get({
                program: programId,
                orgUnit: orgUnitId,
                ouMode: "SELECTED",
                enrollmentEnrolledAfter: `${period}-01-01`,
                enrollmentEnrolledBefore: `${period}-12-31`,
                fields: { trackedEntity: true, orgUnit: true },
                page,
                pageSize: PAGE_SIZE,
            })
            .getData();

        const instances = (response.instances ?? []) as { trackedEntity?: string }[];
        ids.push(..._.compact(instances.map(i => i.trackedEntity)));
        if (instances.length < PAGE_SIZE) break;
    }
    return ids;
}

async function getEventIds(api: D2Api, orgUnitId: string, period: string, programId: Id): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
        const response = await api.tracker.events
            .get({
                program: programId,
                orgUnit: orgUnitId,
                ouMode: "SELECTED",
                occurredAfter: `${period}-01-01`,
                occurredBefore: `${period}-12-31`,
                fields: { event: true },
                page,
                pageSize: PAGE_SIZE,
            })
            .getData();

        const instances = (response.instances ?? []) as { event?: string }[];
        ids.push(..._.compact(instances.map(i => i.event)));
        if (instances.length < PAGE_SIZE) break;
    }
    return ids;
}

async function trackerDelete(api: D2Api, payload: unknown, label: string): Promise<number> {
    const postResponse = await api.tracker
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .postAsync({ importStrategy: "DELETE", skipRuleEngine: true }, payload as any)
        .getData();

    const result = await api.system.waitFor("TRACKER_IMPORT_JOB", postResponse.response.id).getData();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyResult = result as any;
    if (anyResult?.status === "ERROR") {
        console.error(`  ${label}: delete returned ERROR:`, JSON.stringify(anyResult?.validationReport?.errorReports));
    }
    return anyResult?.stats?.deleted ?? 0;
}

async function deleteTrackedEntities(api: D2Api, orgUnitId: string, teiIds: string[]): Promise<number> {
    let deleted = 0;
    for (const chunk of _.chunk(teiIds, DELETE_CHUNK)) {
        const payload = { trackedEntities: chunk.map(id => ({ trackedEntity: id, orgUnit: orgUnitId })) };
        deleted += await trackerDelete(api, payload, "trackedEntities");
    }
    return deleted;
}

async function deleteEvents(api: D2Api, eventIds: string[]): Promise<number> {
    let deleted = 0;
    for (const chunk of _.chunk(eventIds, DELETE_CHUNK)) {
        const payload = { events: chunk.map(id => ({ event: id })) };
        deleted += await trackerDelete(api, payload, "events");
    }
    return deleted;
}

async function deleteForOrgUnitAndPeriod(
    api: D2Api,
    programs: TargetProgram[],
    orgUnitId: string,
    period: string,
    dryRun: boolean
): Promise<void> {
    const teiIds: string[] = [];
    const eventIds: string[] = [];

    for (const program of programs) {
        const ids =
            program.kind === "trackedEntities"
                ? await getTrackedEntityIds(api, orgUnitId, period, program.id)
                : await getEventIds(api, orgUnitId, period, program.id);

        console.log(`  ${program.name} (${program.id}) — ${program.kind}: ${ids.length}`);
        (program.kind === "trackedEntities" ? teiIds : eventIds).push(...ids);
    }

    // A tracked entity can be enrolled in more than one of these programs, and deleting it removes it
    // outright — so the same id can come back from two queries. Deduplicate to avoid a second DELETE
    // that would only report an error for an id that is already gone.
    const uniqueTeiIds = _.uniq(teiIds);
    const uniqueEventIds = _.uniq(eventIds);

    if (dryRun) return;

    if (uniqueTeiIds.length)
        console.log(`  Deleted tracked entities: ${await deleteTrackedEntities(api, orgUnitId, uniqueTeiIds)}`);
    if (uniqueEventIds.length) console.log(`  Deleted events: ${await deleteEvents(api, uniqueEventIds)}`);
}

function main() {
    const cmd = command({
        name: "amc_delete_data_for_period_ou",
        description:
            "Delete all AMC tracker data (product register, raw/calculated substance consumption, and their APVD copies) for the given org units and periods. Dry-run unless --commit is passed.",
        args: {
            orgUnits: option({
                type: StringsSeparatedByCommas,
                long: "orgUnits",
                description: "Comma-separated org unit CODES, e.g. ARM,ESP (601624 for Kosovo)",
            }),
            periods: option({
                type: StringsSeparatedByCommas,
                long: "periods",
                description: "Comma-separated periods (years), e.g. 2014,2015",
            }),
            commit: flag({
                type: boolean,
                long: "commit",
                description: "Actually delete. Without it the script only reports what it would delete.",
            }),
        },
        handler: async args => {
            const dryRun = !args.commit;

            const invalidPeriods = args.periods.filter(period => !/^\d{4}$/.test(period));
            if (invalidPeriods.length)
                throw new Error(`Periods must be 4-digit years, got: ${invalidPeriods.join(", ")}`);

            const envVars = getEnvVars();
            console.log(`Target instance: ${envVars.url} (auth: ${describeAuth(envVars)})`);

            const api = getD2APiFromInstance(getInstance(envVars));
            await warmUpSession(api);

            console.log(
                dryRun
                    ? "=== DRY RUN — reporting only, nothing will be deleted. Re-run with --commit to delete. ==="
                    : "=== COMMIT MODE — data WILL be permanently deleted. ==="
            );

            const programs = await resolveTargetPrograms(api, TARGET_PROGRAM_IDS);
            console.log(`Programs to clear: ${programs.length} of ${TARGET_PROGRAM_IDS.length}`);

            const orgUnitsByCode = await resolveOrgUnitsByCode(api);

            const unknownCodes = args.orgUnits.filter(code => !orgUnitsByCode[code]);
            if (unknownCodes.length) throw new Error(`Unknown org unit code(s): ${unknownCodes.join(", ")}`);

            for (const orgUnitCode of _.uniq(args.orgUnits)) {
                const orgUnitId = orgUnitsByCode[orgUnitCode] as string;

                for (const period of _.uniq(args.periods)) {
                    console.log(`\n--- ${orgUnitCode} (${orgUnitId}) — period ${period} ---`);
                    await deleteForOrgUnitAndPeriod(api, programs, orgUnitId, period, dryRun);
                }
            }

            console.log(`\nDone.${dryRun ? " (dry run — nothing was deleted)" : ""}`);
        },
    });

    run(cmd, process.argv.slice(2)).catch(err => {
        console.error("Fatal error:", err);
        process.exit(1);
    });
}

main();
