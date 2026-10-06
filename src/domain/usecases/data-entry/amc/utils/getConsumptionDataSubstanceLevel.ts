import { Id } from "../../../../entities/Ref";
import { Future, FutureData } from "../../../../entities/Future";
import { GlassAtcVersionData } from "../../../../entities/GlassAtcVersionData";
import { RawSubstanceConsumptionData } from "../../../../entities/data-entry/amc/RawSubstanceConsumptionData";
import { SubstanceConsumptionCalculated } from "../../../../entities/data-entry/amc/SubstanceConsumptionCalculated";
import { calculateConsumptionSubstanceLevelData } from "./calculationConsumptionSubstanceLevelData";
import { logger } from "../../../../../utils/logger";
import { Maybe } from "../../../../../types/utils";

// === CHANGE-TABLE APPROACH ===
// atcRepository and getListOfAtcVersionsByKeys removed — historical ATC versions are no longer
// loaded from DataStore.  calculateConsumptionSubstanceLevelData now derives historical DDD
// values directly from the change table embedded in the current ATC version object.

export function getConsumptionDataSubstanceLevel(params: {
    orgUnitId: Id;
    period: string;
    rawSubstanceConsumptionData: Maybe<RawSubstanceConsumptionData[]>;
    atcCurrentVersionData: GlassAtcVersionData;
    currentAtcVersionKey: string;
}): FutureData<SubstanceConsumptionCalculated[]> {
    const { orgUnitId, period, rawSubstanceConsumptionData, atcCurrentVersionData, currentAtcVersionKey } = params;

    if (!rawSubstanceConsumptionData) {
        logger.error(
            `[${new Date().toISOString()}] Cannot find Raw Substance Consumption Data for orgUnitsId ${orgUnitId} and period ${period} for calculations`
        );
        return Future.error("Cannot find Raw Substance Consumption Data");
    }

    const calculatedConsumptionSubstanceLevelData = calculateConsumptionSubstanceLevelData(
        period,
        orgUnitId,
        rawSubstanceConsumptionData,
        atcCurrentVersionData,
        currentAtcVersionKey
    );
    return Future.success(calculatedConsumptionSubstanceLevelData);
}
