import _ from "lodash";
import { logger } from "../../../../utils/logger";
import { Id } from "../../../entities/Ref";
import { Future, FutureData } from "../../../entities/Future";
import {
    CODE_PRODUCT_NOT_HAVE_ATC,
    COMB_CODE_PRODUCT_NOT_HAVE_ATC,
    GlassAtcVersionData,
} from "../../../entities/GlassAtcVersionData";
import {
    AMC_RAW_SUBSTANCE_CONSUMPTION_CALCULATED_STAGE_ID,
    AMR_GLASS_AMC_TEA_PRODUCT_ID,
} from "../../../../data/repositories/data-entry/AMCProductDataDefaultRepository";
import { AMCProductDataRepository } from "../../../repositories/data-entry/AMCProductDataRepository";
import {
    ProductRegisterProgramMetadata,
    ProgramStage,
    ProgramStageDataElement,
} from "../../../entities/data-entry/amc/ProductRegisterProgram";
import {
    ProductDataTrackedEntity,
    Event,
    EventDataValue,
} from "../../../entities/data-entry/amc/ProductDataTrackedEntity";
import {
    RAW_SUBSTANCE_CONSUMPTION_CALCULATED_KEYS,
    RawSubstanceConsumptionCalculated,
} from "../../../entities/data-entry/amc/RawSubstanceConsumptionCalculated";
import { getConsumptionDataProductLevel } from "./utils/getConsumptionDataProductLevel";
import { AMCSubstanceDataRepository } from "../../../repositories/data-entry/AMCSubstanceDataRepository";
import { mapRawSubstanceCalculatedToSubstanceCalculated } from "./utils/mapRawSubstanceCalculatedToSubstanceCalculated";
import { updateRecalculatedConsumptionData } from "./utils/updateRecalculatedConsumptionData";
import { Maybe } from "../../../../utils/ts-utils";
import { AtcRemapper, matchCalculatedEvents } from "./utils/matchCalculatedEvents";
import { RecalculationResult, recalculationResult } from "./utils/recalculationResult";
import { AMR_GLASS_AMC_TEA_ATC, AMR_GLASS_AMC_TEA_COMBINATION } from "../../../entities/data-entry/amc/amcProgramIds";

const IMPORT_STRATEGY_UPDATE = "UPDATE";
const IMPORT_STRATEGY_CREATE_AND_UPDATE = "CREATE_AND_UPDATE";

export class RecalculateConsumptionDataProductLevelForAllUseCase {
    constructor(
        private amcProductDataRepository: AMCProductDataRepository,
        private amcSubstanceDataRepository: AMCSubstanceDataRepository
    ) {}
    /**
     * Recalculates a single org unit/period. Public so a caller that owns the loop (the CLI, which
     * needs per-pair error isolation and checkpointing) can drive it without re-fetching the program
     * metadata for every pair.
     *
     * Reports `hadSourceData` so the caller can tell whether this org unit/period actually holds
     * product-level registrations.
     */
    public calculateByOrgUnitAndPeriod(
        productRegisterProgramMetadata: ProductRegisterProgramMetadata,
        orgUnitId: Id,
        period: string,
        atcCurrentVersionData: GlassAtcVersionData,
        atcVersionKey: string,
        allowCreationIfNotExist: boolean,
        importCalculationChunkSize: Maybe<number>,
        remapAtc: AtcRemapper
    ): FutureData<RecalculationResult> {
        logger.info(
            `[${new Date().toISOString()}] Calculating consumption data of product level for orgUnitsId ${orgUnitId} and period ${period}`
        );
        return this.getTrackedEntitiesAndRawSubstanceConsumptionCalculatedEvents(
            productRegisterProgramMetadata,
            orgUnitId,
            period
        ).flatMap(data => {
            const { productDataTrackedEntities, currentRawSubstanceConsumptionCalculatedByProductId } = data;

            if (!productDataTrackedEntities || !productDataTrackedEntities?.length) {
                logger.info(
                    `[${new Date().toISOString()}] Product level: there are no product data for orgUnitId ${orgUnitId} and period ${period}`
                );
                return recalculationResult(false);
            }

            if (
                !allowCreationIfNotExist &&
                (_.isEmpty(currentRawSubstanceConsumptionCalculatedByProductId) ||
                    Object.values(currentRawSubstanceConsumptionCalculatedByProductId || {}).every(
                        rawSubstanceConsumptionCalculated => rawSubstanceConsumptionCalculated.length === 0
                    ))
            ) {
                logger.info(
                    `[${new Date().toISOString()}] Product level: there are no current calculated data to update for orgUnitId ${orgUnitId} and period ${period}`
                );
                return recalculationResult(true);
            }

            return getConsumptionDataProductLevel({
                orgUnitId,
                period,
                productRegisterProgramMetadata,
                productDataTrackedEntities,
                atcCurrentVersionData,
                atcVersionKey,
            })
                .flatMap(newRawSubstanceConsumptionCalculatedData => {
                    if (_.isEmpty(newRawSubstanceConsumptionCalculatedData)) {
                        logger.error(
                            `[${new Date().toISOString()}] Product level: there are no new calculated data to update current data for orgUnitId ${orgUnitId} and period ${period}`
                        );
                        return Future.success(undefined);
                    }

                    const rawSubstanceConsumptionCalculatedStageMetadata =
                        productRegisterProgramMetadata?.programStages.find(
                            ({ id }) => id === AMC_RAW_SUBSTANCE_CONSUMPTION_CALCULATED_STAGE_ID
                        );
                    if (!rawSubstanceConsumptionCalculatedStageMetadata) {
                        logger.error(
                            `[${new Date().toISOString()}] Cannot find Raw Substance Consumption Calculated program stage metadata with id ${AMC_RAW_SUBSTANCE_CONSUMPTION_CALCULATED_STAGE_ID}`
                        );
                        return Future.error("Cannot find Raw Substance Consumption Calculated program stage metadata");
                    }

                    const {
                        withEventId: rawSubstanceConsumptionCalculatedDataToUpdate,
                        withoutEventId: rawSubstanceConsumptionCalculatedDataToCreate,
                        remapMatches,
                    } = matchCalculatedEvents({
                        currentRows: Object.values(currentRawSubstanceConsumptionCalculatedByProductId).flat(),
                        nextRows: newRawSubstanceConsumptionCalculatedData,
                        remapAtc,
                    });

                    if (remapMatches) {
                        logger.info(
                            `[${new Date().toISOString()}] Product level: ${remapMatches} row(s) for orgUnitId ${orgUnitId} and period ${period} matched their stored event only after applying the ATC change table (their ATC code was superseded in this version)`
                        );
                    }

                    const eventIdsToUpdate = rawSubstanceConsumptionCalculatedDataToUpdate.map(
                        ({ eventId }) => eventId
                    );

                    // Counts only. Spelling out every UID added ~17 KB per org unit/period here and
                    // again at substance level — hundreds of MB across a full run — and the ids are
                    // recoverable from DHIS2 at any time. Deletions are still logged in full below:
                    // those are destructive and need an audit trail.
                    logger.info(
                        `[${new Date().toISOString()}] Updating calculations of product level events in DHIS2 for orgUnitId ${orgUnitId} and period ${period}: ${
                            eventIdsToUpdate.length
                        } events`
                    );

                    if (allowCreationIfNotExist && rawSubstanceConsumptionCalculatedDataToCreate.length) {
                        logger.info(
                            `[${new Date().toISOString()}] Creating Raw Substance Consumption Calculated data events in DHIS2 for orgUnitId ${orgUnitId} and period ${period}: ${
                                rawSubstanceConsumptionCalculatedDataToCreate.length
                            } events`
                        );
                    }

                    const rawSubstanceConsumptionCalculatedDataToImport = allowCreationIfNotExist
                        ? [
                              ...rawSubstanceConsumptionCalculatedDataToUpdate,
                              ...rawSubstanceConsumptionCalculatedDataToCreate,
                          ]
                        : rawSubstanceConsumptionCalculatedDataToUpdate;

                    return this.amcProductDataRepository
                        .importCalculations({
                            importStrategy: allowCreationIfNotExist
                                ? IMPORT_STRATEGY_CREATE_AND_UPDATE
                                : IMPORT_STRATEGY_UPDATE,
                            productDataTrackedEntities: productDataTrackedEntities,
                            rawSubstanceConsumptionCalculatedStageMetadata:
                                rawSubstanceConsumptionCalculatedStageMetadata,
                            rawSubstanceConsumptionCalculatedData: rawSubstanceConsumptionCalculatedDataToImport,
                            orgUnitId: orgUnitId,
                            period: period,
                            chunkSize: importCalculationChunkSize,
                        })
                        .flatMap(response => {
                            const updatedEventIds = new Set(eventIdsToUpdate);
                            const eventIdsNoRecalculated: Id[] = Object.values(
                                currentRawSubstanceConsumptionCalculatedByProductId
                            )
                                .flat()
                                .map(({ eventId }) => eventId)
                                .filter((id): id is Id => id !== undefined && !updatedEventIds.has(id));

                            // Deleting is only safe when nothing needed creating. Rows dropped because
                            // creation is disabled would otherwise leave their stored events deleted with
                            // no replacement written — silent data loss on exactly the rows a new ATC
                            // version remapped.
                            const wouldDeleteWithoutReplacement =
                                !allowCreationIfNotExist && rawSubstanceConsumptionCalculatedDataToCreate.length > 0;

                            if (wouldDeleteWithoutReplacement && eventIdsNoRecalculated.length) {
                                logger.warn(
                                    `[${new Date().toISOString()}] Product level: NOT deleting ${
                                        eventIdsNoRecalculated.length
                                    } unmatched events for orgUnitId ${orgUnitId} and period ${period} because ${
                                        rawSubstanceConsumptionCalculatedDataToCreate.length
                                    } recalculated rows could not be created (run with --calculate to write them): events=${eventIdsNoRecalculated.join(
                                        ","
                                    )}`
                                );
                            }

                            return this.deleteNoRecalculatedEvents(
                                wouldDeleteWithoutReplacement ? [] : eventIdsNoRecalculated,
                                importCalculationChunkSize
                            ).flatMap(() => {
                                if (response.status === "OK") {
                                    logger.success(
                                        `[${new Date().toISOString()}] Calculations of product level updated for orgUnitId ${orgUnitId} and period ${period}: ${
                                            response.stats.updated
                                        } of ${response.stats.total} events updated${
                                            allowCreationIfNotExist
                                                ? ` and ${response.stats.created} of ${response.stats.total} events created`
                                                : ""
                                        }`
                                    );

                                    return this.importSubstanceConsumptionCalculated(
                                        rawSubstanceConsumptionCalculatedDataToImport,
                                        orgUnitId,
                                        period,
                                        allowCreationIfNotExist,
                                        importCalculationChunkSize,
                                        remapAtc
                                    );
                                }
                                if (response.status === "ERROR") {
                                    logger.error(
                                        `[${new Date().toISOString()}] Error updating calculations of product level updated for orgUnitId ${orgUnitId} and period ${period}: ${JSON.stringify(
                                            response.validationReport.errorReports
                                        )}`
                                    );
                                }

                                if (response.status === "WARNING") {
                                    logger.warn(
                                        `[${new Date().toISOString()}] Warning updating calculations of product level updated for orgUnitId ${orgUnitId} and period ${period}: updated=${
                                            response.stats.updated
                                        }, ${
                                            allowCreationIfNotExist ? `created=${response.stats.created}, ` : ""
                                        } total=${response.stats.total} and warning=${JSON.stringify(
                                            response.validationReport.warningReports
                                        )}`
                                    );

                                    return this.importSubstanceConsumptionCalculated(
                                        rawSubstanceConsumptionCalculatedDataToImport,
                                        orgUnitId,
                                        period,
                                        allowCreationIfNotExist,
                                        importCalculationChunkSize,
                                        remapAtc
                                    );
                                }

                                return Future.success(undefined);
                            });
                        });
                })
                .map((): RecalculationResult => ({ hadSourceData: true }));
        });
    }

    private deleteNoRecalculatedEvents(
        eventIdsNoRecalculated: Id[],
        importCalculationChunkSize: Maybe<number>
    ): FutureData<void> {
        if (eventIdsNoRecalculated.length) {
            logger.error(
                `[${new Date().toISOString()}] Product level: these events could not be recalculated so they will be deleted: events=${eventIdsNoRecalculated.join(
                    ","
                )}`
            );

            return this.amcProductDataRepository
                .deleteRawSubstanceConsumptionCalculatedById(eventIdsNoRecalculated, importCalculationChunkSize)
                .flatMap(response => {
                    if (response.status === "OK") {
                        logger.success(
                            `[${new Date().toISOString()}] Product level: no recalculated events deleted=${
                                response.stats.deleted
                            } of ${response.stats.total} events to delete`
                        );
                    }
                    if (response.status === "ERROR") {
                        logger.error(
                            `[${new Date().toISOString()}] Product level: error deleting no recalculated events=${JSON.stringify(
                                response.validationReport.errorReports
                            )}`
                        );
                    }
                    if (response.status === "WARNING") {
                        logger.warn(
                            `[${new Date().toISOString()}] Product level: warning deleting no recalculated events=deleted=${
                                response.stats.deleted
                            }, total=${response.stats.total} and warning=${JSON.stringify(
                                response.validationReport.warningReports
                            )}`
                        );
                    }
                    return Future.success(undefined);
                });
        } else {
            logger.info(`[${new Date().toISOString()}] Product level: all the events were recalculated.`);
            return Future.success(undefined);
        }
    }

    private getTrackedEntitiesAndRawSubstanceConsumptionCalculatedEvents(
        productRegisterProgramMetadata: ProductRegisterProgramMetadata,
        orgUnitId: Id,
        period: string
    ): FutureData<{
        productDataTrackedEntities: ProductDataTrackedEntity[];
        currentRawSubstanceConsumptionCalculatedByProductId: Record<string, RawSubstanceConsumptionCalculated[]>;
    }> {
        logger.info(
            `[${new Date().toISOString()}] Getting product data tracked entities and events in raw substance consumption calculated stage at product level data for period ${period} and organisation unit id ${orgUnitId}`
        );
        return this.amcProductDataRepository
            .getAllProductRegisterAndRawProductConsumptionByPeriod(orgUnitId, period)
            .flatMap(productDataTrackedEntities => {
                const validProductDataTrackedEntitiesToCalculate = productDataTrackedEntities.filter(
                    ({ attributes }) => {
                        const productWithoutAtcCode = attributes.some(
                            ({ id, value }) =>
                                (id === AMR_GLASS_AMC_TEA_ATC && value === CODE_PRODUCT_NOT_HAVE_ATC) ||
                                (id === AMR_GLASS_AMC_TEA_COMBINATION && value === COMB_CODE_PRODUCT_NOT_HAVE_ATC)
                        );
                        return !productWithoutAtcCode;
                    }
                );
                const rawSubstanceConsumptionCalculatedStageMetadata =
                    productRegisterProgramMetadata?.programStages.find(
                        ({ id }) => id === AMC_RAW_SUBSTANCE_CONSUMPTION_CALCULATED_STAGE_ID
                    );
                if (!rawSubstanceConsumptionCalculatedStageMetadata) {
                    logger.error(
                        `[${new Date().toISOString()}] Cannot find Raw Substance Consumption Calculated program stage metadata with id=${AMC_RAW_SUBSTANCE_CONSUMPTION_CALCULATED_STAGE_ID}`
                    );
                    return Future.error("Cannot find Raw Substance Consumption Calculated program stage metadata");
                }

                const currentRawSubstanceConsumptionCalculatedByProductId: Record<
                    string,
                    RawSubstanceConsumptionCalculated[]
                > = validProductDataTrackedEntitiesToCalculate.reduce((acc, productDataTrackedEntity) => {
                    const productId = productDataTrackedEntity.attributes.find(
                        ({ id }) => id === AMR_GLASS_AMC_TEA_PRODUCT_ID
                    )?.value;
                    if (!productId) {
                        return acc;
                    }

                    return {
                        ...acc,
                        [productId]: getCurrentRawSubstanceConsumptionCalculated(
                            productId,
                            productDataTrackedEntity.events,
                            rawSubstanceConsumptionCalculatedStageMetadata
                        ),
                    };
                }, {});

                return Future.success({
                    productDataTrackedEntities: validProductDataTrackedEntitiesToCalculate,
                    currentRawSubstanceConsumptionCalculatedByProductId,
                });
            });
    }

    private importSubstanceConsumptionCalculated(
        rawSubstanceConsumptionCalculatedData: RawSubstanceConsumptionCalculated[],
        orgUnitId: string,
        period: string,
        allowCreationIfNotExist: boolean,
        importCalculationChunkSize: Maybe<number>,
        remapAtc: AtcRemapper
    ): FutureData<void> {
        const recalculatedSubstanceConsumptionData = mapRawSubstanceCalculatedToSubstanceCalculated(
            rawSubstanceConsumptionCalculatedData,
            period
        );

        return this.amcSubstanceDataRepository
            .getAllCalculatedSubstanceConsumptionDataByByPeriod(orgUnitId, period)
            .flatMap(currentCalculatedConsumptionData => {
                return updateRecalculatedConsumptionData(
                    orgUnitId,
                    period,
                    recalculatedSubstanceConsumptionData,
                    currentCalculatedConsumptionData,
                    this.amcSubstanceDataRepository,
                    allowCreationIfNotExist,
                    importCalculationChunkSize,
                    remapAtc
                );
            });
    }
}

function getCurrentRawSubstanceConsumptionCalculated(
    productId: string,
    events: Event[],
    rawSubstanceConsumptionCalculatedStage: ProgramStage
): RawSubstanceConsumptionCalculated[] {
    return events
        .map(event => {
            const consumptionData = event.dataValues.reduce((acc, eventDataValue: EventDataValue) => {
                const programStageDataElement: ProgramStageDataElement | undefined =
                    rawSubstanceConsumptionCalculatedStage?.dataElements.find(
                        dataElement => dataElement.id === eventDataValue.id
                    );
                if (
                    programStageDataElement &&
                    RAW_SUBSTANCE_CONSUMPTION_CALCULATED_KEYS.includes(programStageDataElement.code)
                ) {
                    switch (programStageDataElement.valueType) {
                        case "TEXT":
                            return {
                                ...acc,
                                [programStageDataElement.code]: programStageDataElement.optionSetValue
                                    ? programStageDataElement.optionSet.options.find(
                                          option => option.code === eventDataValue.value
                                      )?.code
                                    : eventDataValue.value,
                            };
                        case "NUMBER":
                        case "INTEGER":
                        case "INTEGER_POSITIVE":
                        case "INTEGER_ZERO_OR_POSITIVE":
                            return {
                                ...acc,
                                [programStageDataElement.code]: programStageDataElement.optionSetValue
                                    ? programStageDataElement.optionSet.options.find(
                                          option => option.code === eventDataValue.value
                                      )?.code
                                    : parseFloat(eventDataValue.value),
                            };
                        default:
                            return {
                                ...acc,
                                [programStageDataElement.code]: eventDataValue.value,
                            };
                    }
                }
                return acc;
            }, {});
            if (Object.keys(consumptionData).length) {
                return {
                    ...consumptionData,
                    AMR_GLASS_AMC_TEA_PRODUCT_ID: productId,
                    eventId: event.eventId,
                };
            }
        })
        .filter(Boolean) as RawSubstanceConsumptionCalculated[];
}
