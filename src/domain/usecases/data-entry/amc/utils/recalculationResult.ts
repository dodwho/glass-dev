import { Future, FutureData } from "../../../../entities/Future";

/**
 * What a single org unit/period recalculation reports back to its caller.
 *
 * `hadSourceData` says whether this level found any source data for the pair, which the caller needs
 * because product level and substance level both write calculated consumption into the same DHIS2
 * program: when both levels hold data for one org unit and period, neither may delete the events it
 * cannot match, since those belong to the other level.
 */
export type RecalculationResult = { hadSourceData: boolean };

export function recalculationResult(hadSourceData: boolean): FutureData<RecalculationResult> {
    return Future.success({ hadSourceData });
}
