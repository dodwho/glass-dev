import { logger } from "../../../../../utils/logger";
import { Future, FutureData } from "../../../../entities/Future";
import { Id } from "../../../../entities/Ref";
import { SubstanceConsumptionCalculated } from "../../../../entities/data-entry/amc/SubstanceConsumptionCalculated";
import { AMCSubstanceDataRepository } from "../../../../repositories/data-entry/AMCSubstanceDataRepository";
import { Maybe } from "../../../../../types/utils";
import { AtcRemapper, matchCalculatedEvents } from "./matchCalculatedEvents";

const IMPORT_STRATEGY_UPDATE = "UPDATE";
const IMPORT_STRATEGY_CREATE_AND_UPDATE = "CREATE_AND_UPDATE";

export function updateRecalculatedConsumptionData(
    orgUnitId: Id,
    period: string,
    newCalculatedConsumptionData: SubstanceConsumptionCalculated[],
    currentCalculatedConsumptionData: Maybe<SubstanceConsumptionCalculated[]>,
    amcSubstanceDataRepository: AMCSubstanceDataRepository,
    allowCreationIfNotExist: boolean,
    importCalculationChunkSize: Maybe<number>,
    remapAtc: AtcRemapper,
    /**
     * Suppresses deletion of stored events this recalculation did not match. Set when another
     * pipeline has already written calculated consumption for this org unit and period, so the
     * unmatched events are not stale rows but the other pipeline's output.
     */
    preserveUnmatchedEvents = false
): FutureData<void> {
    const {
        withEventId: newCalculatedConsumptionDataWithIds,
        withoutEventId: newCalculatedConsumptionDataWithoutIds,
        remapMatches,
    } = matchCalculatedEvents({
        currentRows: currentCalculatedConsumptionData || [],
        nextRows: newCalculatedConsumptionData,
        remapAtc,
    });

    if (remapMatches) {
        logger.info(
            `[${new Date().toISOString()}] Substance level: ${remapMatches} row(s) for orgUnitId ${orgUnitId} and period ${period} matched their stored event only after applying the ATC change table (their ATC code was superseded in this version)`
        );
    }

    const eventIdsToUpdate = newCalculatedConsumptionDataWithIds.map(({ eventId }) => eventId);

    // Counts only — see the note at the product-level call site.
    logger.info(
        `[${new Date().toISOString()}] Updating calculations of substance level events in DHIS2 for orgUnitId ${orgUnitId} and period ${period}: ${
            eventIdsToUpdate.length
        } events`
    );

    if (allowCreationIfNotExist && newCalculatedConsumptionDataWithoutIds.length) {
        logger.info(
            `[${new Date().toISOString()}] Creating calculated consumption data events in DHIS2 for orgUnitId ${orgUnitId} and period ${period}: ${
                newCalculatedConsumptionDataWithoutIds.length
            } events`
        );
    }

    return amcSubstanceDataRepository
        .importCalculations({
            importStrategy: allowCreationIfNotExist ? IMPORT_STRATEGY_CREATE_AND_UPDATE : IMPORT_STRATEGY_UPDATE,
            orgUnitId: orgUnitId,
            calculatedConsumptionSubstanceLevelData: allowCreationIfNotExist
                ? [...newCalculatedConsumptionDataWithIds, ...newCalculatedConsumptionDataWithoutIds]
                : newCalculatedConsumptionDataWithIds,
            chunkSize: importCalculationChunkSize,
        })
        .flatMap(({ response }) => {
            if (response.status === "OK") {
                logger.success(
                    `[${new Date().toISOString()}] Calculations of substance level updated for orgUnitId ${orgUnitId} and period ${period}: ${
                        response.stats.updated
                    } of ${response.stats.total} events updated${
                        allowCreationIfNotExist
                            ? ` and ${response.stats.created} of ${response.stats.total} events created`
                            : ""
                    }`
                );
            }
            if (response.status === "ERROR") {
                logger.error(
                    `[${new Date().toISOString()}] Error updating calculations of substance level updated for orgUnitId ${orgUnitId} and period ${period}: ${JSON.stringify(
                        response.validationReport.errorReports
                    )}`
                );
            }
            if (response.status === "WARNING") {
                logger.warn(
                    `[${new Date().toISOString()}] Warning updating calculations of substance level updated for orgUnitId ${orgUnitId} and period ${period}: updated=${
                        response.stats.updated
                    }, ${allowCreationIfNotExist ? `created=${response.stats.created}, ` : ""} total=${
                        response.stats.total
                    } and warning=${JSON.stringify(response.validationReport.warningReports)}`
                );
            }

            const updatedEventIds = new Set(eventIdsToUpdate);
            const eventIdsNoRecalculated = (currentCalculatedConsumptionData || [])
                .map(({ eventId }) => eventId)
                .filter((id): id is Id => id !== undefined && !updatedEventIds.has(id));

            if (eventIdsNoRecalculated.length) {
                if (preserveUnmatchedEvents) {
                    logger.warn(
                        `[${new Date().toISOString()}] Substance level: NOT deleting ${
                            eventIdsNoRecalculated.length
                        } unmatched events for orgUnitId ${orgUnitId} and period ${period} because product level data was also calculated for this org unit and period — they are that pipeline's output, not stale rows`
                    );
                    return Future.success(undefined);
                }

                // Deleting is only safe when the recalculation produced nothing that needed creating.
                // If rows were dropped because creation is disabled, deleting the events they would
                // have replaced destroys data with no replacement written.
                if (!allowCreationIfNotExist && newCalculatedConsumptionDataWithoutIds.length) {
                    logger.warn(
                        `[${new Date().toISOString()}] Substance level: NOT deleting ${
                            eventIdsNoRecalculated.length
                        } unmatched events for orgUnitId ${orgUnitId} and period ${period} because ${
                            newCalculatedConsumptionDataWithoutIds.length
                        } recalculated rows could not be created (run with --calculate to write them): events=${eventIdsNoRecalculated.join(
                            ","
                        )}`
                    );
                    return Future.success(undefined);
                }
                return deleteNoRecalculatedEvents(
                    amcSubstanceDataRepository,
                    eventIdsNoRecalculated,
                    importCalculationChunkSize
                );
            } else {
                logger.info(`[${new Date().toISOString()}] Substance level: all the events were recalculated.`);
                return Future.success(undefined);
            }
        });
}

function deleteNoRecalculatedEvents(
    amcSubstanceDataRepository: AMCSubstanceDataRepository,
    eventIdsNoRecalculated: Id[],
    importCalculationChunkSize: Maybe<number>
): FutureData<void> {
    logger.error(
        `[${new Date().toISOString()}] Substance level: these events could not be recalculated so they will be deleted: events=${eventIdsNoRecalculated.join(
            ","
        )}`
    );
    return amcSubstanceDataRepository
        .deleteCalculatedSubstanceConsumptionDataById(eventIdsNoRecalculated, importCalculationChunkSize)
        .flatMap(response => {
            if (response.status === "OK") {
                logger.success(
                    `[${new Date().toISOString()}] Substance level: no recalculated events deleted=${
                        response.stats.deleted
                    } of ${response.stats.total} events to delete`
                );
            }
            if (response.status === "ERROR") {
                logger.error(
                    `[${new Date().toISOString()}] Substance level: error deleting no recalculated events: ${JSON.stringify(
                        response.validationReport.errorReports
                    )}`
                );
            }
            if (response.status === "WARNING") {
                logger.warn(
                    `[${new Date().toISOString()}] Substance level: warning deleting no recalculatedevents: deleted=${
                        response.stats.deleted
                    }, total=${response.stats.total} and warning=${JSON.stringify(
                        response.validationReport.warningReports
                    )}`
                );
            }
            return Future.success(undefined);
        });
}
