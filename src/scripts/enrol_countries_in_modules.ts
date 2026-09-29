import fs from "fs";
import { boolean, command, flag, option, optional, run, string } from "cmd-ts";
import dotenv from "dotenv";
import _ from "lodash";
import { D2TrackedEntityInstanceToPost } from "@eyeseetea/d2-api/api/trackerTrackedEntities";
import { D2TrackerEnrollmentToPost } from "@eyeseetea/d2-api/api/trackerEnrollments";
import { TrackerPostRequest } from "@eyeseetea/d2-api/api/tracker";
import { D2Api } from "../types/d2-api";
import { describeAuth, getEnvVars, getInstance, StringsSeparatedByCommas, warmUpSession } from "./common";
import { getD2APiFromInstance } from "../utils/d2-api";
import { generateUid } from "../utils/uid";
import { Id } from "../domain/entities/Ref";
import { GlassGeneralInfo } from "../domain/entities/GlassGeneralInfo";
import { GlassModuleName, MODULE_NAMES } from "../domain/entities/GlassModule";
import {
    ENROLMENT_MODULE_ATTRIBUTE_ID,
    ENROLMENT_PROGRAM_ID,
    MODULE_ENROLMENT_CODES,
} from "../domain/entities/CountryInformation";

dotenv.config();

/*
================================================================
Enrol countries into GLASS modules (or un-enrol them).

A module (AMR, AMC, EGASP, AMR - Individual, AMR - Fungal, EAR) is only shown for a country while an
ACTIVE enrolment exists for that (country, module) pair in the enrolment program — see
GetGlassModulesUseCase. This script creates and retires exactly those, in bulk.

Only an ACTIVE enrolment counts. Un-enrolling therefore CANCELS the enrolment rather than deleting
the tracked entity: the national focal point contacts recorded against it survive, the country can
be re-enrolled with its history intact, and the enrolment reads as a period rather than a fact.
Re-enrolling a cancelled pair revives it instead of registering a second tracked entity.

Enrolment does NOT grant anyone access: a user still needs to be in the module's readAccess user
group (datastore key glass/modules) and to have the country in their org units. Those are per-user
settings and are deliberately out of scope here.

SAFETY: dry-run by default — it reports what it would do and asks the server to VALIDATE the very
same payload, which persists nothing. Pass --commit to actually write.

Run (dry run):   yarn enrol-countries --countries ESP,FRA --modules AMC
Run (write):     yarn enrol-countries --countries ESP,FRA --modules AMC --commit

A whole region:  yarn enrol-countries --regions EUR --modules AMR-Individual,AMC
Every country:   yarn enrol-countries --regions ALL --modules AMR
Every module:    yarn enrol-countries --countries ESP --modules ALL
Follow a module: yarn enrol-countries --enrolledIn AMR --modules EAR,AMR-Individual
Mixed pairs:     yarn enrol-countries --file pairs.csv --commit
Undo:            yarn enrol-countries --countries ESP --modules AMC --unenrol --commit
Revive:          yarn enrol-countries --countries ESP --modules AMC --reactivate --commit
Really remove:   yarn enrol-countries --countries ESP --modules AMC --delete --commit

--countries takes ISO3 codes or org unit ids, interchangeably. --regions takes WHO region codes
(AFR, AMR, EMR, EUR, SEAR, WPR, NA) or ALL. --enrolledIn takes module names and selects every
country already enrolled in them, so "give everything already doing AMR the EAR module" needs no
pasted country list and stays correct as enrolments change. The three combine into one set.

--modules takes AMR, AMR-Individual, AMR-Fungal, AMC, EGASP, EAR, or ALL. Write the multi-word
names WITHOUT spaces: list values are split on whitespace as well as commas (yarn on Windows hands
the script "a b c" where "a,b,c" was typed), so "AMR - Individual" would be read as three values.
AMR-Individual, AMR_INDIVIDUAL and AMRIndividual all work. The --file CSV is parsed separately and
does accept the spaced display name.

--file is a CSV of country,module pairs (one per line, header optional, blank and # lines skipped)
for runs where different countries need different modules.

(set DOTENV_CONFIG_PATH=.env.local the same way you run the bulk upload script)
================================================================
*/

const CHUNK_SIZE = 100;
const PAGE_SIZE = 250;

/** Mistyped scope is user error, not a fault: report it plainly instead of throwing a stack trace. */
function fail(message: string): void {
    console.error(message);
    process.exitCode = 1;
}

/** Only an ACTIVE enrolment makes a module visible to the country — see GetGlassModulesUseCase. */
const isActive = (enrolment: Enrolment): boolean => enrolment.status === "ACTIVE";

function modeLabel(args: { unenrol: boolean; reactivate: boolean; delete: boolean }): string {
    if (args.delete) return "DELETING enrolments";
    if (args.unenrol) return "Un-enrolling";
    if (args.reactivate) return "Reactivating";
    return "Enrolling";
}

type Country = { id: Id; name: string; code: string; region: string };

type EnrolmentStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";

/** One enrolment of one tracked entity, flattened with everything an UPDATE needs. */
type Enrolment = {
    trackedEntity: Id;
    orgUnit: Id;
    enrollment: Id;
    status: EnrolmentStatus;
    enrolledAt: string;
    occurredAt: string;
    program: Id;
};

/**
 * What the run decided to do with one (country, module) pair.
 *
 * "create" registers a new tracked entity; "activate" revives an existing cancelled or completed
 * enrolment instead of creating a second one; "cancel" is the normal un-enrol; "delete" is the
 * escape hatch that really does remove the tracked entity and everything under it.
 */
type Action = "create" | "activate" | "cancel" | "delete" | "skip";

type Target = {
    country: Country;
    module: GlassModuleName;
    action: Action;
    status: string;
    detail: string;
    /** Every enrolment already recorded for this pair, across all its tracked entities. */
    enrolments: Enrolment[];
};

/**
 * The spellings to show a caller: the display names with the spaces taken out, because a value
 * containing spaces cannot survive StringsSeparatedByCommas (see the --modules note in the header).
 */
const CLI_MODULE_NAMES = Object.values(MODULE_NAMES).map(name => name.replace(/\s/g, ""));

/**
 * Accepts the module name in any spelling a caller is likely to type — the display name
 * ("AMR - Individual"), the enrolment code ("AMR_INDIVIDUAL"), or anything in between — by
 * comparing on letters and digits alone.
 */
function parseModuleName(value: string): GlassModuleName | undefined {
    const normalize = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const target = normalize(value);

    return Object.values(MODULE_NAMES).find(
        name => normalize(name) === target || normalize(MODULE_ENROLMENT_CODES[name]) === target
    );
}

async function getGeneralInfo(api: D2Api): Promise<GlassGeneralInfo> {
    return api.dataStore("glass").get<GlassGeneralInfo>("general").getData() as Promise<GlassGeneralInfo>;
}

/**
 * The tracked entity type to register with, and the org units the program is assigned to. A country
 * that is not assigned cannot be enrolled — DHIS2 rejects it — so we check up front rather than
 * letting the import fail halfway through.
 */
async function getProgramInfo(api: D2Api, programId: Id): Promise<{ trackedEntityType: Id; orgUnitIds: Set<Id> }> {
    const program = await api
        .get<{ trackedEntityType: { id: Id }; organisationUnits: { id: Id }[] }>(`/programs/${programId}`, {
            fields: "trackedEntityType[id],organisationUnits[id]",
        })
        .getData();

    return {
        trackedEntityType: program.trackedEntityType.id,
        orgUnitIds: new Set(program.organisationUnits.map(orgUnit => orgUnit.id)),
    };
}

async function getCountries(api: D2Api, countryLevel: number): Promise<Country[]> {
    const response = await api.models.organisationUnits
        .get({
            fields: { id: true, name: true, code: true, parent: { code: true, name: true } },
            filter: { level: { eq: countryLevel.toString() } },
            paging: false,
        })
        .getData();

    return response.objects.map(orgUnit => ({
        id: orgUnit.id,
        name: orgUnit.name,
        code: orgUnit.code ?? "",
        region: orgUnit.parent?.code || orgUnit.parent?.name || "",
    }));
}

/**
 * Existing enrolments for a module, as country id -> enrolments. Queried once per module over the
 * whole instance rather than once per pair: the program holds a few hundred rows in total, so this
 * is a handful of requests no matter how many countries the run targets.
 *
 * The enrolment id and status come back too, because un-enrolling cancels an enrolment rather than
 * deleting the tracked entity, so every action here needs to know which enrolments are live.
 */
async function getEnrolledCountries(api: D2Api, programId: Id, module: GlassModuleName): Promise<Map<Id, Enrolment[]>> {
    const byCountry = new Map<Id, Enrolment[]>();

    for (let page = 1; ; page++) {
        const response = await api.tracker.trackedEntities
            .get({
                program: programId,
                ouMode: "ALL",
                filter: `${ENROLMENT_MODULE_ATTRIBUTE_ID}:eq:${MODULE_ENROLMENT_CODES[module]}`,
                fields: {
                    trackedEntity: true,
                    orgUnit: true,
                    enrollments: {
                        enrollment: true,
                        status: true,
                        enrolledAt: true,
                        occurredAt: true,
                        program: true,
                        orgUnit: true,
                    },
                },
                page,
                pageSize: PAGE_SIZE,
            })
            .getData();

        const instances = response.instances ?? [];
        instances.forEach(instance => {
            const orgUnit = instance.orgUnit;
            const trackedEntity = instance.trackedEntity;
            if (!orgUnit || !trackedEntity) return;

            const enrolments = (instance.enrollments ?? []).map(enrollment => ({
                trackedEntity,
                orgUnit,
                enrollment: enrollment.enrollment,
                status: enrollment.status,
                enrolledAt: enrollment.enrolledAt,
                occurredAt: enrollment.occurredAt,
                program: enrollment.program,
            }));

            byCountry.set(orgUnit, [...(byCountry.get(orgUnit) ?? []), ...enrolments]);
        });

        if (instances.length < PAGE_SIZE) break;
    }

    return byCountry;
}

/** An enrolment moved to a new status, as a tracker UPDATE payload. */
function buildEnrolmentWithStatus(enrolment: Enrolment, status: EnrolmentStatus): D2TrackerEnrollmentToPost {
    return {
        enrollment: enrolment.enrollment,
        trackedEntity: enrolment.trackedEntity,
        program: enrolment.program,
        orgUnit: enrolment.orgUnit,
        enrolledAt: enrolment.enrolledAt,
        occurredAt: enrolment.occurredAt,
        status,
        events: [],
    };
}

function buildTrackedEntity(
    target: Target,
    programId: Id,
    trackedEntityType: Id,
    enrolledAt: string
): D2TrackedEntityInstanceToPost {
    const trackedEntity = generateUid();
    const attributes = [{ attribute: ENROLMENT_MODULE_ATTRIBUTE_ID, value: MODULE_ENROLMENT_CODES[target.module] }];

    return {
        trackedEntity,
        trackedEntityType,
        orgUnit: target.country.id,
        attributes,
        enrollments: [
            {
                enrollment: generateUid(),
                trackedEntity,
                program: programId,
                orgUnit: target.country.id,
                enrolledAt,
                occurredAt: enrolledAt,
                status: "ACTIVE",
                events: [],
                attributes,
            },
        ],
    };
}

/**
 * Posts one chunk and reports how many objects the server accepted, plus any errors.
 *
 * `countedType` says which half of the bundle report corresponds one-to-one with the work: creating
 * a pair writes both a tracked entity and an enrolment, so the top-level stats would double-count.
 */
async function postChunk(
    api: D2Api,
    request: TrackerPostRequest,
    strategy: "CREATE" | "UPDATE" | "DELETE",
    countedType: "TRACKED_ENTITY" | "ENROLLMENT",
    dryRun: boolean
): Promise<{ written: number; errors: string[] }> {
    const postResponse = await api.tracker
        .postAsync(
            {
                importStrategy: strategy,
                importMode: dryRun ? "VALIDATE" : "COMMIT",
                // One rejected pair must not roll back the rest of the chunk.
                atomicMode: "OBJECT",
                skipRuleEngine: true,
            },
            request
        )
        .getData();

    const result = await api.system.waitFor("TRACKER_IMPORT_JOB", postResponse.response.id).getData();
    const report = result as unknown as {
        bundleReport?: { typeReportMap?: Record<string, { stats?: Stats }> };
        validationReport?: { errorReports?: { uid: string; message: string }[] };
    };

    const stats = report.bundleReport?.typeReportMap?.[countedType]?.stats;

    return {
        written: (stats?.created ?? 0) + (stats?.updated ?? 0) + (stats?.deleted ?? 0),
        errors: (report.validationReport?.errorReports ?? []).map(error => `${error.uid}: ${error.message}`),
    };
}

type Stats = { created?: number; updated?: number; deleted?: number };

/** country,module pairs from a CSV. Header, blank lines and # comments are all optional noise. */
function readPairsFile(path: string): { country: string; module: string }[] {
    return _.compact(
        fs
            .readFileSync(path, "utf8")
            .split(/\r?\n/)
            .map(line => {
                const [country, module] = line.split(",").map(value => value.trim());
                if (!country || !module || country.startsWith("#")) return undefined;
                if (!parseModuleName(module)) return undefined; // drops a "country,module" header row
                return { country, module };
            })
    );
}

function writeReport(targets: Target[]): string {
    const path = `module_enrolment_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    const rows = targets.map(target =>
        [
            target.country.code,
            target.country.name,
            target.country.id,
            target.country.region,
            target.module,
            target.action,
            target.status,
            target.detail,
        ]
            .map(value => `"${String(value).replace(/"/g, '""')}"`)
            .join(",")
    );

    fs.writeFileSync(
        path,
        ["country_code,country_name,country_id,region,module,action,status,detail", ...rows, ""].join("\n")
    );
    return path;
}

const cmd = command({
    name: "enrol-countries",
    description: "Enrol countries (or whole WHO regions) into GLASS modules, or un-enrol them",
    args: {
        countries: option({
            type: optional(StringsSeparatedByCommas),
            long: "countries",
            description: "ISO3 codes or org unit ids, e.g. ESP,FRA,XKX",
        }),
        regions: option({
            type: optional(StringsSeparatedByCommas),
            long: "regions",
            description: "WHO region codes (AFR, AMR, EMR, EUR, SEAR, WPR, NA), or ALL",
        }),
        modules: option({
            type: optional(StringsSeparatedByCommas),
            long: "modules",
            description: `Module names without spaces, or ALL. One of: ${CLI_MODULE_NAMES.join(", ")}`,
        }),
        enrolledIn: option({
            type: optional(StringsSeparatedByCommas),
            long: "enrolledIn",
            description: "Select every country already enrolled in these modules, e.g. AMR",
        }),
        file: option({
            type: optional(string),
            long: "file",
            description: "CSV of country,module pairs",
        }),
        enrolledAt: option({
            type: optional(string),
            long: "enrolledAt",
            description: "Enrolment date as YYYY-MM-DD (default: today)",
        }),
        unenrol: flag({
            type: boolean,
            long: "unenrol",
            description: "Cancel the enrolments instead of creating them (reversible, keeps focal points)",
        }),
        reactivate: flag({
            type: boolean,
            long: "reactivate",
            description: "Set cancelled or completed enrolments back to ACTIVE",
        }),
        delete: flag({
            type: boolean,
            long: "delete",
            description: "Escape hatch: really delete the tracked entities, losing their focal points",
        }),
        commit: flag({
            type: boolean,
            long: "commit",
            description: "Actually write. Without it the run only reports and validates.",
        }),
    },
    handler: async args => {
        const dryRun = !args.commit;
        const enrolledAt = args.enrolledAt ?? new Date().toISOString().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(enrolledAt)) throw new Error(`--enrolledAt must be YYYY-MM-DD: ${enrolledAt}`);

        const envVars = getEnvVars();
        const api = getD2APiFromInstance(getInstance(envVars));
        console.log(`[auth] ${envVars.url} using ${describeAuth(envVars)}`);
        await warmUpSession(api);

        const generalInfo = await getGeneralInfo(api);
        const programId = generalInfo.enrolmentProgram || ENROLMENT_PROGRAM_ID;
        if (programId !== ENROLMENT_PROGRAM_ID) {
            console.warn(
                `[warn] glass/general.enrolmentProgram is ${programId}, but the app reads ${ENROLMENT_PROGRAM_ID}. Using the datastore value.`
            );
        }

        const { trackedEntityType, orgUnitIds } = await getProgramInfo(api, programId);
        const countries = await getCountries(api, generalInfo.countryLevel);
        const countriesByKey = new Map(
            countries.flatMap(country => {
                const entries: [string, Country][] = [[country.id.toUpperCase(), country]];
                if (country.code) entries.push([country.code.toUpperCase(), country]);
                return entries;
            })
        );

        // --- resolve the targeted (country, module) pairs -------------------------------------

        const modules = (args.modules ?? []).flatMap(value =>
            value.toUpperCase() === "ALL" ? Object.values(MODULE_NAMES) : [value]
        );
        const regions = args.regions ?? [];
        const allRegions = regions.some(region => region.toUpperCase() === "ALL");

        const knownRegions = new Set(countries.map(country => country.region.toUpperCase()));
        const unknownRegions = allRegions ? [] : regions.filter(region => !knownRegions.has(region.toUpperCase()));

        const unknownCountries = (args.countries ?? []).filter(value => !countriesByKey.get(value.toUpperCase()));
        const unknownEnrolledIn = (args.enrolledIn ?? []).filter(value => !parseModuleName(value));

        const filePairs = args.file ? readPairsFile(args.file) : [];
        const unknownFileCountries = filePairs
            .map(pair => pair.country)
            .filter(value => !countriesByKey.get(value.toUpperCase()));

        // A typo must not silently enrol a smaller set than intended.
        const unknown = [
            ...[...unknownCountries, ...unknownFileCountries].map(value => `unknown country: ${value}`),
            ...unknownRegions.map(value => `unknown region: ${value}`),
            ...[...modules, ...unknownEnrolledIn]
                .filter(value => !parseModuleName(value))
                .map(value => `unknown module: ${value} — expected one of ${CLI_MODULE_NAMES.join(", ")}, or ALL`),
        ];
        if (!_.isEmpty(unknown)) return fail(`Cannot resolve the requested scope:\n  ${unknown.join("\n  ")}`);

        // Enrolments are read at most once per module, and shared with the classification below.
        const enrolmentCache = new Map<GlassModuleName, Map<Id, Enrolment[]>>();
        const enrolmentsFor = async (module: GlassModuleName): Promise<Map<Id, Enrolment[]>> => {
            const cached = enrolmentCache.get(module);
            if (cached) return cached;
            const enrolments = await getEnrolledCountries(api, programId, module);
            enrolmentCache.set(module, enrolments);
            return enrolments;
        };

        // --enrolledIn selects the countries that already have those modules, so a scope like
        // "everything already doing AMR" stays correct as enrolments change, instead of being a
        // list pasted from an earlier query.
        const enrolledInCountryIds = _.flatten(
            await Promise.all(
                _.compact((args.enrolledIn ?? []).map(parseModuleName)).map(async module =>
                    [...(await enrolmentsFor(module)).entries()]
                        // Only an ACTIVE enrolment counts as enrolled, exactly as the app reads it.
                        .filter(([, enrolments]) => enrolments.some(isActive))
                        .map(([countryId]) => countryId)
                )
            )
        );

        const selectedRegions = new Set(regions.map(region => region.toUpperCase()));
        const selectedCountries = _.uniqBy(
            [
                ...(args.countries ?? []).map(value => countriesByKey.get(value.toUpperCase())),
                ...enrolledInCountryIds.map(id => countriesByKey.get(id.toUpperCase())),
                ...countries.filter(country => allRegions || selectedRegions.has(country.region.toUpperCase())),
            ],
            country => country?.id
        );

        const pairs = _.uniqBy(
            [
                ..._.compact(selectedCountries).flatMap(country =>
                    _.compact(modules.map(parseModuleName)).map(module => ({ country, module }))
                ),
                ...filePairs.map(pair => ({
                    country: countriesByKey.get(pair.country.toUpperCase()) as Country,
                    module: parseModuleName(pair.module) as GlassModuleName,
                })),
            ],
            pair => `${pair.country.id}-${pair.module}`
        );

        if (_.isEmpty(pairs))
            return fail("Nothing selected. Pass --countries, --regions and/or --enrolledIn with --modules, or --file.");

        // --- classify -------------------------------------------------------------------------

        const enrolledByModule = new Map(
            await Promise.all(
                _.uniq(pairs.map(pair => pair.module)).map(
                    async module => [module, await enrolmentsFor(module)] as const
                )
            )
        );

        const targets: Target[] = _.sortBy(pairs, [
            pair => pair.country.region,
            pair => pair.country.name,
            pair => pair.module,
        ]).map(({ country, module }): Target => {
            const enrolments = enrolledByModule.get(module)?.get(country.id) ?? [];
            const active = enrolments.filter(isActive);
            const trackedEntityCount = _.uniq(enrolments.map(enrolment => enrolment.trackedEntity)).length;
            const duplicates =
                trackedEntityCount > 1 ? `${trackedEntityCount} tracked entities exist for this pair` : "";
            const base = { country, module, enrolments };

            if (args.delete) {
                return _.isEmpty(enrolments)
                    ? { ...base, action: "skip", status: "nothing to delete", detail: "" }
                    : {
                          ...base,
                          action: "delete",
                          status: "will DELETE",
                          detail: _.compact([
                              `${trackedEntityCount} tracked entities and their focal points`,
                              duplicates,
                          ]).join("; "),
                      };
            }

            if (args.unenrol) {
                return _.isEmpty(active)
                    ? { ...base, action: "skip", status: "not enrolled", detail: "" }
                    : { ...base, action: "cancel", status: "will un-enrol", detail: duplicates };
            }

            if (args.reactivate) {
                const revivable = enrolments.filter(enrolment => !isActive(enrolment));
                if (!_.isEmpty(active))
                    return { ...base, action: "skip", status: "already active", detail: duplicates };
                return _.isEmpty(revivable)
                    ? { ...base, action: "skip", status: "not enrolled", detail: "" }
                    : {
                          ...base,
                          action: "activate",
                          status: "will reactivate",
                          detail: _.uniq(revivable.map(enrolment => enrolment.status)).join(", "),
                      };
            }

            // Enrol.
            if (!_.isEmpty(active)) {
                return { ...base, action: "skip", status: "already enrolled", detail: duplicates };
            }
            if (!_.isEmpty(enrolments)) {
                // Previously un-enrolled: revive it rather than registering a second tracked entity,
                // so the country keeps the focal point contacts recorded against the original.
                return {
                    ...base,
                    action: "activate",
                    status: "will re-enrol",
                    detail: `reviving ${_.uniq(enrolments.map(enrolment => enrolment.status)).join(", ")} enrolment`,
                };
            }
            if (!orgUnitIds.has(country.id)) {
                return {
                    ...base,
                    action: "skip",
                    status: "blocked",
                    detail: `org unit not assigned to program ${programId}`,
                };
            }
            return { ...base, action: "create", status: "will enrol", detail: "" };
        });

        // --- report ---------------------------------------------------------------------------

        console.log(`\n${modeLabel(args)} — ${targets.length} (country, module) pairs\n`);
        const nameWidth = _.max(targets.map(target => target.country.name.length)) ?? 0;
        _.toPairs(_.groupBy(targets, target => target.country.region)).forEach(([region, regionTargets]) => {
            console.log(`  ${region}`);
            regionTargets.forEach(target =>
                console.log(
                    `    ${(target.country.code || target.country.id).padEnd(5)} ${target.country.name.padEnd(
                        nameWidth
                    )} ${target.module.padEnd(17)} ${target.status}${target.detail ? ` — ${target.detail}` : ""}`
                )
            );
        });

        const counts = _.countBy(targets, target => target.status);
        console.log(
            `\n  ${_.toPairs(counts)
                .map(([status, n]) => `${status}: ${n}`)
                .join(", ")}`
        );

        const toWrite = targets.filter(target => target.action !== "skip");
        if (_.isEmpty(toWrite)) {
            console.log("\nNothing to do.");
            console.log(`Report: ${writeReport(targets)}`);
            return;
        }

        // --- write (or validate) ----------------------------------------------------------------

        console.log(
            dryRun
                ? `\n[dry run] asking the server to validate ${toWrite.length} pairs (nothing is persisted). Pass --commit to write.`
                : `\n[commit] writing ${toWrite.length} pairs...`
        );

        // Each action maps to one tracker import: a create writes tracked entities, an activate or a
        // cancel updates enrolments in place, and a delete removes tracked entities outright.
        const creations = toWrite
            .filter(target => target.action === "create")
            .map(target => buildTrackedEntity(target, programId, trackedEntityType, enrolledAt));

        const statusChanges = toWrite
            .filter(target => target.action === "activate" || target.action === "cancel")
            .flatMap(target =>
                (target.action === "activate"
                    ? target.enrolments.filter(enrolment => !isActive(enrolment))
                    : target.enrolments.filter(isActive)
                ).map(enrolment =>
                    buildEnrolmentWithStatus(enrolment, target.action === "activate" ? "ACTIVE" : "CANCELLED")
                )
            );

        const deletions = _.uniqBy(
            toWrite
                .filter(target => target.action === "delete")
                .flatMap(target => target.enrolments)
                .map(({ trackedEntity, orgUnit }) => ({ trackedEntity, orgUnit })),
            ({ trackedEntity }) => trackedEntity
        );

        const errors: string[] = [];
        let written = 0;
        let expected = 0;

        const runBatches = async <T>(
            items: T[],
            toRequest: (chunk: T[]) => TrackerPostRequest,
            strategy: "CREATE" | "UPDATE" | "DELETE",
            countedType: "TRACKED_ENTITY" | "ENROLLMENT"
        ) => {
            expected += items.length;
            for (const chunk of _.chunk(items, CHUNK_SIZE)) {
                const result = await postChunk(api, toRequest(chunk), strategy, countedType, dryRun);
                written += result.written;
                errors.push(...result.errors);
            }
        };

        await runBatches(creations, chunk => ({ trackedEntities: chunk }), "CREATE", "TRACKED_ENTITY");
        await runBatches(statusChanges, chunk => ({ enrollments: chunk }), "UPDATE", "ENROLLMENT");
        await runBatches(
            deletions,
            chunk => ({ trackedEntities: chunk as D2TrackedEntityInstanceToPost[] }),
            "DELETE",
            "TRACKED_ENTITY"
        );

        errors.forEach(error => console.error(`  [error] ${error}`));

        console.log(
            dryRun
                ? `\n[dry run] validation ${
                      _.isEmpty(errors) ? "passed" : `reported ${errors.length} error(s)`
                  }. Nothing was written.`
                : `\n[commit] wrote ${written} of ${expected} object(s)${
                      _.isEmpty(errors) ? "" : `, ${errors.length} error(s)`
                  }.`
        );
        console.log(`Report: ${writeReport(targets)}`);

        if (!_.isEmpty(errors)) process.exitCode = 1;
    },
});

run(cmd, process.argv.slice(2));
