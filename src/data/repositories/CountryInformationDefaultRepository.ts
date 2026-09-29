import _ from "lodash";
import { D2Api, MetadataPick } from "@eyeseetea/d2-api/2.34";
import {
    CountryInformation,
    ENROLMENT_MODULE_ATTRIBUTE_ID,
    ENROLMENT_PROGRAM_ID,
    MODULE_ENROLMENT_CODES,
} from "../../domain/entities/CountryInformation";
import { GlassModuleName } from "../../domain/entities/GlassModule";
import { Future, FutureData } from "../../domain/entities/Future";
import { CountryInformationRepository } from "../../domain/repositories/CountryInformationRepository";
import { getD2APiFromInstance } from "../../utils/d2-api";
import { apiToFuture } from "../../utils/futures";
import { Instance } from "../entities/Instance";
import { getCurrentYear } from "../../utils/currentPeriodHelper";
import { D2TrackerTrackedEntity } from "@eyeseetea/d2-api/api/trackerTrackedEntities";
import { D2TrackerEvent } from "@eyeseetea/d2-api/api/trackerEvents";

/** The worst duplication seen on the instance is four; this leaves ample headroom. */
const MAX_ENROLMENTS_PER_COUNTRY_MODULE = 50;

export class CountryInformationDefaultRepository implements CountryInformationRepository {
    private api: D2Api;

    //TODO: @cache does not work with futures
    // I've created here an manual in memory cache to avoid many requests
    private inmemoryCache: Record<string, unknown> = {};

    constructor(instance: Instance) {
        this.api = getD2APiFromInstance(instance);
    }

    get(countryId: string, module: string): FutureData<CountryInformation> {
        let countryName = "";

        return this.getOrgUnits(countryId)
            .flatMap(orgUnits => {
                countryName = orgUnits.find(ou => ou.id === countryId)?.shortName || "";

                return Future.joinObj({
                    program: this.getProgram(),
                    teis: this.getTEIs(countryId, module),
                    orgUnits: Future.success(orgUnits),
                });
            })
            .map(({ program, teis, orgUnits }) => {
                const country = orgUnits.find(ou => ou.id === countryId);
                const countryLevel = country?.level || 0;
                countryName = country?.shortName || "";
                const regionName =
                    orgUnits.find(ou => ou.id !== countryId && ou.level === countryLevel - 1)?.shortName || "";

                const enrollments = _.flatMap(teis, tei => tei.enrollments ?? []);
                const activeEnrollments = enrollments.filter(enrollment => enrollment.status === "ACTIVE");

                // A module is available to the country only while an enrolment is ACTIVE: un-enrolling
                // cancels the enrolment rather than deleting it, so that the national focal point
                // contacts recorded against it survive and the country can be re-enrolled.
                const activeEnrollment = _.first(activeEnrollments);

                // Fall back to the most recent cancelled/completed enrolment purely so the page can
                // still show when the country was last enrolled. It never grants access.
                const enrollmentToShow = activeEnrollment ?? _.maxBy(enrollments, ({ enrolledAt }) => enrolledAt ?? "");

                const events = _.flatMap(
                    _.isEmpty(activeEnrollments) ? _.compact([enrollmentToShow]) : activeEnrollments,
                    enrollment => enrollment.events ?? []
                );
                const programstageDataElements = program?.programStages[0]?.programStageDataElements || [];

                return {
                    module,
                    WHORegion: regionName,
                    country: countryName,
                    year: getCurrentYear(),
                    nationalFocalPointId: activeEnrollment?.enrollment,
                    enrolmentStatus: enrollmentToShow?.status || "",
                    enrolmentDate: enrollmentToShow?.enrolledAt || "",
                    nationalFocalPoints:
                        events.map((event: D2TrackerEvent) => {
                            return {
                                id: event.event,
                                values: programstageDataElements.map(programStageDataElement => {
                                    const dataValue = event.dataValues.find(
                                        dv => dv.dataElement === programStageDataElement.dataElement.id
                                    );

                                    return {
                                        id: programStageDataElement.dataElement.id,
                                        name: programStageDataElement.dataElement.shortName,
                                        value: dataValue?.value || "",
                                    };
                                }),
                            };
                        }) || [],
                };
            })
            .mapError(error => {
                if (error.includes("Organisation unit is not part of the search scope")) {
                    return `Organisation unit is not part of the search scope: ${countryName}`;
                } else {
                    return error;
                }
            });
    }

    private getOrgUnits(countryId: string): FutureData<D2OrgUnit[]> {
        const cacheKey = `orgUnits-${countryId}`;

        return this.getFromCacheOrRemote(
            cacheKey,
            apiToFuture(
                this.api.get<D2OrgUnitsResponse>(`/organisationUnits/${countryId}`, {
                    fields: Object.keys(orgUnitFields).join(","),
                    includeAncestors: true,
                })
            ).map(response => response.organisationUnits)
        );
    }

    /**
     * Every tracked entity for this (country, module), not just the first.
     *
     * A country can legitimately carry more than one — the enrolment program allows repeat
     * enrolment and the instance has pairs with up to four — so which enrolment is active cannot be
     * decided from a single row. The caller picks the active one across all of them.
     */
    private getTEIs(countryId: string, module: string): FutureData<D2TrackerTrackedEntity[]> {
        const cacheKey = `TEI-${countryId}-${module}`;

        // "AMR - Individual" --> "AMR_INDIVIDUAL", the code of its option in the "Module" option set.
        const moduleCode = MODULE_ENROLMENT_CODES[module as GlassModuleName];
        if (!moduleCode) return Future.success([]);

        const filterStr = `${ENROLMENT_MODULE_ATTRIBUTE_ID}:eq:${moduleCode}`;

        return this.getFromCacheOrRemote(
            cacheKey,
            apiToFuture(
                this.api.tracker.trackedEntities.get({
                    orgUnit: countryId,
                    fields: { $all: true },
                    program: ENROLMENT_PROGRAM_ID,
                    page: 1,
                    pageSize: MAX_ENROLMENTS_PER_COUNTRY_MODULE,
                    filter: filterStr,
                    ouMode: "SELECTED",
                })
            ).map(response => response.instances)
        );
    }

    private getProgram(): FutureData<D2Program | undefined> {
        const cacheKey = `program`;

        return this.getFromCacheOrRemote(
            cacheKey,
            apiToFuture(
                this.api.models.programs.get({
                    fields: programFields,
                    includeAncestors: true,
                    filter: { id: { eq: ENROLMENT_PROGRAM_ID } },
                })
            ).map(response => response.objects[0])
        );
    }

    private getFromCacheOrRemote<T>(cacheKey: string, future: FutureData<T>): FutureData<T> {
        if (this.inmemoryCache[cacheKey]) {
            const orgUnits = this.inmemoryCache[cacheKey] as T;
            return Future.success(orgUnits);
        } else {
            return future.map(response => {
                this.inmemoryCache[cacheKey] = response;

                return response;
            });
        }
    }
}

const programFields = {
    id: true,
    programStages: {
        programStageDataElements: {
            id: true,
            sortOrder: true,
            dataElement: { id: true, shortName: true },
        },
    },
} as const;

type D2Program = MetadataPick<{
    programs: { fields: typeof programFields };
}>["programs"][number];

export interface D2OrgUnitsResponse {
    organisationUnits: D2OrgUnit[];
    pager: {
        pageSize: number;
        total: number;
        page: number;
    };
}

const orgUnitFields = {
    id: true,
    shortName: true,
    level: true,
} as const;

type D2OrgUnit = MetadataPick<{
    organisationUnits: { fields: typeof orgUnitFields };
}>["organisationUnits"][number];
