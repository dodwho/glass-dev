import _ from "lodash";
import { logger } from "../../../../utils/logger";
import { Id } from "../../../entities/Ref";
import { Future, FutureData } from "../../../entities/Future";
import { CODE_PRODUCT_NOT_HAVE_ATC, GlassAtcVersionData } from "../../../entities/GlassAtcVersionData";
import { AtcRemapper } from "./utils/matchCalculatedEvents";
import { RecalculationResult, recalculationResult } from "./utils/recalculationResult";
import { RawSubstanceConsumptionData } from "../../../entities/data-entry/amc/RawSubstanceConsumptionData";
import { SubstanceConsumptionCalculated } from "../../../entities/data-entry/amc/SubstanceConsumptionCalculated";
import { AMCSubstanceDataRepository } from "../../../repositories/data-entry/AMCSubstanceDataRepository";
import { getConsumptionDataSubstanceLevel } from "./utils/getConsumptionDataSubstanceLevel";
import { updateRecalculatedConsumptionData } from "./utils/updateRecalculatedConsumptionData";
import { Maybe } from "../../../../utils/ts-utils";

export class RecalculateConsumptionDataSubstanceLevelForAllUseCase {
    constructor(private amcSubstanceDataRepository: AMCSubstanceDataRepository) {}
    /**
     * Recalculates a single org unit/period. The caller owns the loop so that a failure on one pair
     * does not abandon the rest of the run, and so the ATC version and change table are resolved
     * once rather than per pair.
     *
     * Reports `hadSourceData` so the caller can tell whether this org unit/period actually holds
     * substance-level submissions.
     */
    public calculateByOrgUnitAndPeriod(
        orgUnitId: Id,
        period: string,
        currentATCVersion: string,
        currentATCData: GlassAtcVersionData,
        allowCreationIfNotExist: boolean,
        importCalculationChunkSize: Maybe<number>,
        remapAtc: AtcRemapper,
        preserveUnmatchedEvents = false
    ): FutureData<RecalculationResult> {
        logger.info(
            `[${new Date().toISOString()}] Calculating consumption data of substance level for orgUnitsId ${orgUnitId} and period ${period}`
        );
        return this.getDataForRecalculations(orgUnitId, period).flatMap(
            ({ rawSubstanceConsumptionData, currentCalculatedConsumptionData }) => {
                if (_.isEmpty(rawSubstanceConsumptionData)) {
                    logger.info(
                        `[${new Date().toISOString()}] Substance level: there are no raw substance consumption data for orgUnitId ${orgUnitId} and period ${period}`
                    );
                    return recalculationResult(false);
                }

                if (
                    !allowCreationIfNotExist &&
                    (!currentCalculatedConsumptionData || _.isEmpty(currentCalculatedConsumptionData))
                ) {
                    logger.info(
                        `[${new Date().toISOString()}] Substance level: there are no current calculated data to update for orgUnitId ${orgUnitId} and period ${period}`
                    );
                    return recalculationResult(true);
                }

                return getConsumptionDataSubstanceLevel({
                    orgUnitId,
                    period,
                    // atcRepository removed — change-table approach no longer loads historical DataStore objects
                    rawSubstanceConsumptionData,
                    currentAtcVersionKey: currentATCVersion,
                    atcCurrentVersionData: currentATCData,
                }).flatMap(newCalculatedConsumptionData => {
                    if (_.isEmpty(newCalculatedConsumptionData)) {
                        logger.error(
                            `[${new Date().toISOString()}] Substance level: there are no new calculated data to update current data for orgUnitId ${orgUnitId} and period ${period}`
                        );
                        return recalculationResult(true);
                    }

                    return updateRecalculatedConsumptionData(
                        orgUnitId,
                        period,
                        newCalculatedConsumptionData,
                        currentCalculatedConsumptionData,
                        this.amcSubstanceDataRepository,
                        allowCreationIfNotExist,
                        importCalculationChunkSize,
                        remapAtc,
                        preserveUnmatchedEvents
                    ).map(() => ({ hadSourceData: true }));
                });
            }
        );
    }

    private getDataForRecalculations(
        orgUnitId: Id,
        period: string
    ): FutureData<{
        rawSubstanceConsumptionData: RawSubstanceConsumptionData[] | undefined;
        currentCalculatedConsumptionData: SubstanceConsumptionCalculated[] | undefined;
    }> {
        logger.info(
            `[${new Date().toISOString()}] Getting raw substance consumption data and current calculated consumption data for orgUnitId ${orgUnitId} and period ${period}`
        );
        return Future.joinObj({
            rawSubstanceConsumptionData: this.amcSubstanceDataRepository.getAllRawSubstanceConsumptionDataByByPeriod(
                orgUnitId,
                period
            ),
            currentCalculatedConsumptionData:
                this.amcSubstanceDataRepository.getAllCalculatedSubstanceConsumptionDataByByPeriod(orgUnitId, period),
        }).flatMap(({ rawSubstanceConsumptionData, currentCalculatedConsumptionData }) => {
            const validRawSubstanceConsumptionData = rawSubstanceConsumptionData?.filter(
                ({ atc_manual }) => atc_manual !== CODE_PRODUCT_NOT_HAVE_ATC
            );
            return Future.success({
                rawSubstanceConsumptionData: validRawSubstanceConsumptionData,
                currentCalculatedConsumptionData,
            });
        });
    }
}
