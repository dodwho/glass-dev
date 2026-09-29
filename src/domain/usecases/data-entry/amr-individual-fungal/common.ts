import _ from "lodash";
import { Country } from "../../../entities/Country";
import { CustomDataColumns } from "../../../entities/data-entry/amr-individual-fungal-external/RISIndividualFungalData";
import { Future, FutureData } from "../../../entities/Future";
import { getTEAValueFromOrganisationUnitCountryEntry } from "../utils/getTEAValueFromOrganisationUnitCountryEntry";
import { ConsistencyError, ImportSummary } from "../../../entities/data-entry/ImportSummary";
import { generateId, Id } from "../../../entities/Ref";
import {
    TrackerEnrollment,
    TrackerEvent,
    TrackerTrackedEntity,
    TrackerTrackedEntityAttribute,
} from "../../../entities/TrackedEntityInstance";
import {
    AMR_INDIVIDUAL_FUNGAL_DATE_COLUMNS,
    MANDATORY_TEI_ATTRIBUTES,
    checkAdmissionDate,
    checkCountry,
    checkMandatoryAttribute,
    checkPeriod,
    checkSpecimenDate,
    checkSpecimenDateNotInFuture,
} from "./RISIndividualFungalFileValidations";
import { parseDateStrict, validateAllDateFieldsInRow } from "../utils/dateValidation";

const AMR_GLASS_AMR_TET_PATIENT = "CcgnfemKr5U";

const AMR_GLASS_AMR_DET_SAMPLE_DATE = "Xtn5zEL9mGx";

export function mapIndividualFungalDataItemsToEntities(
    individualFungalDataItems: CustomDataColumns[],
    orgUnit: string,
    AMRIProgramIDl: string,
    AMRDataProgramStageIdl: string,
    countryCode: string,
    period: string,
    allCountries: Country[],
    metadata: Record<"programAttributes" | "programStageDataElements", any> // TODO: type this properly and fix clean architecture violation
): FutureData<TrackerTrackedEntity[]> {
    const trackedEntities = individualFungalDataItems.map(dataItem => {
        const valueByKey = new Map<string, string | number | undefined>();
        for (const item of dataItem) {
            valueByKey.set(item.key, item.value);
        }

        const attributes: TrackerTrackedEntityAttribute[] = metadata.programAttributes.map(
            (attr: { id: string; name: string; code: string; valueType: string }) => {
                const currentValue = valueByKey.get(attr.code);

                if (attr.valueType === "ORGANISATION_UNIT" && typeof currentValue === "string") {
                    return {
                        attribute: attr.id,
                        value: getTEAValueFromOrganisationUnitCountryEntry(allCountries, currentValue, true),
                    };
                }

                return {
                    attribute: attr.id,
                    value: currentValue ?? "",
                };
            }
        );
        const AMRDataStage: { dataElement: string; value: string }[] = metadata.programStageDataElements.map(
            (de: { id: string; name: string; code: string }) => {
                return {
                    dataElement: de.id,
                    value: valueByKey.get(de.code) ?? "",
                };
            }
        );

        const sampleDateStr =
            AMRDataStage.find(de => de.dataElement === AMR_GLASS_AMR_DET_SAMPLE_DATE)?.value ?? `${period}-01-01`;
        const sampleDate = parseDateStrict(sampleDateStr) ?? period;

        const createdAt = new Date().toISOString().split("T")[0] ?? period;
        const trackedEntityId = generateId();

        const events: TrackerEvent[] = [
            {
                program: AMRIProgramIDl,
                event: generateId(),
                programStage: AMRDataProgramStageIdl,
                orgUnit,
                dataValues: AMRDataStage,
                occurredAt: sampleDate,
                status: "COMPLETED",
            },
        ];
        const enrollments: TrackerEnrollment[] = [
            {
                orgUnit,
                program: AMRIProgramIDl,
                trackedEntity: trackedEntityId,
                enrollment: generateId(),
                trackedEntityType: AMR_GLASS_AMR_TET_PATIENT,
                attributes: attributes,
                events: events,
                enrolledAt: sampleDate,
                occurredAt: sampleDate,
                createdAt: createdAt,
                createdAtClient: createdAt,
                updatedAt: createdAt,
                updatedAtClient: createdAt,
                status: "COMPLETED",
                orgUnitName: countryCode,
                followUp: false,
                deleted: false,
                storedBy: "",
            },
        ];

        const entity: TrackerTrackedEntity = {
            orgUnit,
            trackedEntity: trackedEntityId,
            trackedEntityType: AMR_GLASS_AMR_TET_PATIENT,
            enrollments: enrollments,
            // The tracked entity type requires these attributes at tracked entity level as well as on
            // the enrollment; runCustomValidations has already guaranteed every row carries a value.
            attributes: MANDATORY_TEI_ATTRIBUTES.map(({ id }) => ({
                attribute: id,
                value: attributes.find(at => at.attribute === id)?.value.toString() ?? "",
            })),
        };
        return entity;
    });
    return Future.success(trackedEntities);
}

/**
 * File line of every tracked entity, enrollment and event id of entities built from consecutive file rows,
 * so errors DHIS2 reports against any of those objects can be traced back to the row.
 */
export function getLineNumbersByTrackerId(
    trackedEntities: TrackerTrackedEntity[],
    firstLine: number
): { id: Id; lineNo: number }[] {
    return trackedEntities.flatMap((trackedEntity, index) => {
        const lineNo = firstLine + index;
        return [
            trackedEntity.trackedEntity,
            ...trackedEntity.enrollments.flatMap(enrollment => [
                enrollment.enrollment,
                ...enrollment.events.map(event => event.event),
            ]),
        ].map(id => ({ id, lineNo }));
    });
}

type CustomValidationFunction = (dataItem: CustomDataColumns) => string | null;

export function runCustomValidations(
    risIndividualFungalDataItems: CustomDataColumns[],
    orgUnit: string,
    period: string,
    fileLineStart = 2
): FutureData<ImportSummary> {
    // Step 1: date format validation across all rows — collect every bad cell before blocking
    const dateFormatErrors = risIndividualFungalDataItems.flatMap((dataItem, index) => {
        const line = fileLineStart + index;
        const row: Record<string, string> = Object.fromEntries(
            dataItem
                .filter(item => item.value !== undefined && item.value !== null)
                .map(item => [item.key, item.value?.toString() ?? ""])
        );
        // Grouped per column and kind of problem, not per cell, so a file with a bad date on every row gives
        // one error with its lines instead of one error per row. The lines identify each offending value.
        return validateAllDateFieldsInRow(row, AMR_INDIVIDUAL_FUNGAL_DATE_COLUMNS, line).map(err => ({
            error:
                err.error === "date_format"
                    ? `Invalid date format in column "${err.column}". Expected format: YYYY-MM-DD (e.g., 2024-09-23). Please update your file and re-upload.`
                    : `Invalid date in column "${err.column}": the date does not exist on the calendar. Please correct it and re-upload.`,
            line: err.row,
        }));
    });

    // Step 2: if any date format errors exist, return them immediately — business logic
    // relies on parseDateStrict which only works on valid ISO dates, so we must not
    // proceed until every date field is in the correct format.
    if (dateFormatErrors.length > 0) {
        const groupedFormatErrors = _(dateFormatErrors)
            .groupBy(e => e.error)
            .mapValues(v => v.map(e => e.line))
            .value();
        const blockingErrors: ConsistencyError[] = Object.keys(groupedFormatErrors).map(error => ({
            error,
            count: groupedFormatErrors[error]?.length ?? 0,
            lines: groupedFormatErrors[error] ?? [],
        }));
        return Future.success({
            status: "ERROR",
            importCount: { ignored: 0, imported: 0, deleted: 0, updated: 0, total: 0 },
            nonBlockingErrors: [],
            blockingErrors,
        });
    }

    // Step 3: all dates are valid ISO — run business logic checks
    const validations: CustomValidationFunction[] = [
        (dataItem: CustomDataColumns) => checkCountry(dataItem, orgUnit),
        (dataItem: CustomDataColumns) => checkPeriod(dataItem, period),
        (dataItem: CustomDataColumns) => checkSpecimenDate(dataItem, period),
        (dataItem: CustomDataColumns) => checkSpecimenDateNotInFuture(dataItem),
        (dataItem: CustomDataColumns) => checkAdmissionDate(dataItem),
        // One check per attribute so each one is reported with its own list of offending file lines.
        ...MANDATORY_TEI_ATTRIBUTES.map(
            ({ column }) =>
                (dataItem: CustomDataColumns) =>
                    checkMandatoryAttribute(dataItem, column)
        ),
    ];
    const businessErrors = risIndividualFungalDataItems.flatMap((dataItem, index) => {
        const line = fileLineStart + index;
        return validations.map(validation => {
            const error = validation(dataItem);
            if (error) {
                return {
                    error: error,
                    line: line,
                };
            }
            return null;
        });
    });

    const groupedErrors = _(businessErrors)
        .omitBy(_.isNil)
        .groupBy(error => error?.error)
        .mapValues(value => value.map(el => el?.line || 0))
        .value();
    const blockingErrors: ConsistencyError[] = Object.keys(groupedErrors).map(error => ({
        error: error,
        count: groupedErrors[error]?.length || 0,
        lines: groupedErrors[error] || [],
    }));
    const summary: ImportSummary = {
        status: "ERROR",
        importCount: { ignored: 0, imported: 0, deleted: 0, updated: 0, total: 0 },
        nonBlockingErrors: [],
        blockingErrors: blockingErrors,
    };
    return Future.success(summary);
}
