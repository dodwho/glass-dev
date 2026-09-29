import { D2Api } from "../../types/d2-api";
import { Id } from "../../domain/entities/Ref";
import { promiseMapConcurrent } from "../../utils/promises";
import consoleLogger from "../../utils/consoleLogger";
import {
    AMC_PRODUCT_REGISTER_PROGRAM_ID,
    AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID,
} from "../../domain/entities/data-entry/amc/amcProgramIds";

/**
 * Resolving "every org unit that actually holds AMC data", rather than trusting the hand-maintained
 * DataStore key glass/amc-recalculation.
 *
 * That key is an operator-edited snapshot: nothing in the app writes its org unit or period lists.
 * It drifts — on the WHO instance it lists 218 org units of which only ~97 hold any AMC data, while
 * omitting at least one country that does.
 *
 * The probe is count-only (pageSize=1, totalPages=true, no field bodies transferred), one request
 * per country per source program. Only the two SOURCE programs are probed: calculated consumption is
 * an output, so a country with calculated data but no source data has nothing to recalculate from.
 */

export type Country = { id: Id; code: string; name: string };

// Kosovo is not always a level-3 org unit; the AMC scripts add it by hardcoded uid where it is
// missing. The uid does not exist on every instance — where it doesn't, every query naming it fails
// with E1003 — so it is only added after confirming it is really there.
const KOSOVO = { id: "I8AMbKhxlj9", code: "601624", name: "Kosovo" };

export async function fetchAmcCountries(api: D2Api): Promise<Country[]> {
    const { objects } = await api.models.organisationUnits
        .get({ fields: { id: true, name: true, code: true }, filter: { level: { eq: "3" } }, paging: false })
        .getData();

    const countries: Country[] = objects.map(ou => ({ id: ou.id, code: ou.code ?? "", name: ou.name }));

    if (!countries.some(country => country.id === KOSOVO.id)) {
        const { objects: found } = await api.models.organisationUnits
            .get({ fields: { id: true }, filter: { id: { eq: KOSOVO.id } }, paging: false })
            .getData();
        if (found.length > 0) countries.push(KOSOVO);
    }

    return countries;
}

async function countProductRegisterTrackedEntities(api: D2Api, orgUnit: Id): Promise<number> {
    const response = await api.tracker.trackedEntities
        .get({
            fields: { trackedEntity: true },
            program: AMC_PRODUCT_REGISTER_PROGRAM_ID,
            orgUnit,
            ouMode: "SELECTED",
            pageSize: 1,
            totalPages: true,
        })
        .getData();

    return response.total ?? 0;
}

async function countRawSubstanceEvents(api: D2Api, orgUnit: Id): Promise<number> {
    const response = await api.tracker.events
        .get({
            fields: { event: true },
            program: AMC_RAW_SUBSTANCE_CONSUMPTION_PROGRAM_ID,
            orgUnit,
            ouMode: "SELECTED",
            pageSize: 1,
            totalPages: true,
        })
        .getData();

    return response.total ?? 0;
}

/**
 * Returns the org units holding product-level or substance-level AMC source data, in country order.
 * A failed probe is treated as "has data": excluding a country because one count request timed out
 * would silently drop it from the recalculation, which is the failure mode this exists to prevent.
 */
export async function findOrgUnitsWithAmcData(
    api: D2Api,
    countries: Country[],
    concurrency: number
): Promise<{ orgUnitsIds: Id[]; probeFailures: number }> {
    let probeFailures = 0;

    const results = await promiseMapConcurrent(
        countries,
        async country => {
            try {
                const [products, substances] = await Promise.all([
                    countProductRegisterTrackedEntities(api, country.id),
                    countRawSubstanceEvents(api, country.id),
                ]);
                return { country, hasData: products > 0 || substances > 0, products, substances };
            } catch (error) {
                probeFailures++;
                consoleLogger.warn(
                    `[${new Date().toISOString()}] Scope probe failed for ${country.code || country.id} (${
                        error instanceof Error ? error.message : String(error)
                    }) — including it rather than risk skipping data`
                );
                return { country, hasData: true, products: -1, substances: -1 };
            }
        },
        concurrency
    );

    const withData = results.filter(result => result.hasData);

    withData
        .filter(result => result.products >= 0)
        .forEach(result =>
            consoleLogger.debug(
                `[${new Date().toISOString()}]   ${result.country.code || result.country.id}: products=${
                    result.products
                }, substances=${result.substances}`
            )
        );

    consoleLogger.info(
        `[${new Date().toISOString()}] Scope probe: ${withData.length} of ${
            countries.length
        } countries hold AMC source data${probeFailures ? ` (${probeFailures} probes failed and were included)` : ""}`
    );

    return { orgUnitsIds: withData.map(result => result.country.id), probeFailures };
}

/** Inclusive year range as period strings. */
export function buildPeriodRange(fromYear: number, toYear: number): string[] {
    if (toYear < fromYear) throw new Error(`Invalid period range: ${fromYear}..${toYear}`);
    return Array.from({ length: toYear - fromYear + 1 }, (_, index) => String(fromYear + index));
}
