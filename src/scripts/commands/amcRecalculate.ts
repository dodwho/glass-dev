import fs from "node:fs";
import path from "node:path";

import { logger } from "../../utils/logger";
import consoleLogger from "../../utils/consoleLogger";
import { Id } from "../../domain/entities/Ref";
import { Maybe } from "../../types/utils";
import { GlassATCRecalculateDataInfo, getATCChanges } from "../../domain/entities/GlassAtcVersionData";
import { GlassATCRepository } from "../../domain/repositories/GlassATCRepository";
import { GlassModuleRepository } from "../../domain/repositories/GlassModuleRepository";
import { AMCProductDataRepository } from "../../domain/repositories/data-entry/AMCProductDataRepository";
import { AMCSubstanceDataRepository } from "../../domain/repositories/data-entry/AMCSubstanceDataRepository";
import { GetRecalculateDataInfoUseCase } from "../../domain/usecases/data-entry/amc/GetRecalculateDataInfoUseCase";
import { DisableAMCRecalculationsUseCase } from "../../domain/usecases/data-entry/amc/DisableAMCRecalculationsUseCase";
import { GetCurrentATCVersionData } from "../../domain/usecases/data-entry/amc/GetCurrentATCVersionData";
import { GetGlassModuleByIdUseCase } from "../../domain/usecases/GetGlassModuleByIdUseCase";
import { RecalculateConsumptionDataProductLevelForAllUseCase } from "../../domain/usecases/data-entry/amc/RecalculateConsumptionDataProductLevelForAllUseCase";
import { RecalculateConsumptionDataSubstanceLevelForAllUseCase } from "../../domain/usecases/data-entry/amc/RecalculateConsumptionDataSubstanceLevelForAllUseCase";
import { createAtcRemapper } from "../../domain/usecases/data-entry/amc/utils/matchCalculatedEvents";
import {
    ChangeCounts,
    createChangeRecorder,
    recordingProductDataRepository,
    recordingSubstanceDataRepository,
    resetChangeRecorder,
    retryRecordedOperation,
} from "./recordingRepositories";
import { AmcRecalculateAudit, PairOutcome } from "./amcRecalculateAudit";
import { AMC_MODULE_ID } from "../../domain/entities/data-entry/amc/amcProgramIds";
import { sleep } from "../common";

export type AmcRecalculateRepositories = {
    amcProductDataRepository: AMCProductDataRepository;
    amcSubstanceDataRepository: AMCSubstanceDataRepository;
    atcRepository: GlassATCRepository;
    glassModuleRepository: GlassModuleRepository;
};

export type AmcRecalculateOptions = {
    /** Create calculated events that do not exist yet, not just update the ones that do. */
    allowCreationIfNotExist: boolean;
    /** Run even when the DataStore's `recalculate` flag is false, and leave the flag untouched. */
    force: boolean;
    /** Overrides the DataStore's org unit list. */
    orgUnitsIds?: Id[];
    /** Overrides the DataStore's period list. */
    periods?: string[];
    /**
     * Resolves the org unit list from the data itself instead of the DataStore key. Takes precedence
     * over `orgUnitsIds`. Requires `periods` to be supplied by the caller.
     */
    resolveOrgUnitsFromData?: () => Promise<Id[]>;
    /** Pause between org unit/period pairs, to keep request pressure off a busy server. */
    delayMs: number;
    /** File recording completed pairs so an interrupted run can resume. */
    checkpointPath?: string;
    /** Resolve and report the scope, then stop without reading or writing any tracker data. */
    dryRun: boolean;
    /** Where to write the per-pair audit CSV. Defaults to the working directory. */
    auditPath?: string;
    /**
     * Attempts per level before the pair is recorded as failed. 1 disables retrying. Only transient
     * failures are retried — see `isRetryableError`, which rethrows 4xx immediately.
     */
    retryAttempts?: number;
    /** First backoff delay; `retryAsync` doubles it per attempt and applies full jitter. */
    retryBaseDelayMs?: number;
    /**
     * Rehearsal: run the whole pipeline for real — every read, the DDD/ATC arithmetic, the matcher,
     * the create/update/delete classification — but intercept the writes and report what WOULD
     * change. Unlike `dryRun`, which stops at scope resolution, this exercises the actual code path.
     */
    plan?: boolean;
};

export type AmcRecalculateSummary = {
    total: number;
    processed: number;
    skipped: number;
    failures: Array<{ orgUnitId: Id; period: string; error: string }>;
    /** Totals actually written (or, in plan mode, that would have been written). */
    productLevel: ChangeCounts;
    substanceLevel: ChangeCounts;
    /** Human-readable closing report; also the tail of the audit CSV. */
    reportLines: string[];
    /** Pairs holding both product-level and substance-level data — see the warning at the call site. */
    bothLevels: Array<{ orgUnitId: Id; period: string }>;
};

type Pair = { orgUnitId: Id; period: string };

const pairKey = ({ orgUnitId, period }: Pair): string => `${orgUnitId}:${period}`;

export function getRecalculateDataInfo(
    atcRepository: GlassATCRepository
): Promise<GlassATCRecalculateDataInfo | undefined> {
    return new GetRecalculateDataInfoUseCase(atcRepository).execute().toPromise();
}

export function disableRecalculations(atcRepository: GlassATCRepository): Promise<void> {
    return new DisableAMCRecalculationsUseCase(atcRepository).execute().toPromise();
}

function readCheckpoint(checkpointPath: Maybe<string>): Set<string> {
    if (!checkpointPath || !fs.existsSync(checkpointPath)) return new Set();

    const done = fs
        .readFileSync(checkpointPath, "utf8")
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);

    consoleLogger.info(`[${new Date().toISOString()}] Resuming: ${done.length} pairs already completed`);
    return new Set(done);
}

function appendCheckpoint(checkpointPath: Maybe<string>, pair: Pair): void {
    if (!checkpointPath) return;
    fs.mkdirSync(path.dirname(path.resolve(checkpointPath)), { recursive: true });
    fs.appendFileSync(checkpointPath, `${pairKey(pair)}\n`, "utf8");
}

/**
 * Recalculates AMC consumption for a set of org unit/period pairs.
 *
 * The loop lives here rather than inside the use cases so that a failure on one pair does not
 * abandon the other 2,000: each pair is isolated, recorded in the checkpoint on success, and
 * reported in the summary on failure. Product level runs before substance level for each pair,
 * preserving the original ordering (the product pass writes calculated consumption that the
 * substance pass then reads).
 */
export async function runAmcRecalculation(
    repositories: AmcRecalculateRepositories,
    options: AmcRecalculateOptions
): Promise<AmcRecalculateSummary> {
    const { atcRepository, glassModuleRepository } = repositories;
    const {
        allowCreationIfNotExist,
        force,
        delayMs,
        checkpointPath,
        dryRun,
        plan = false,
        retryAttempts = 3,
        retryBaseDelayMs = 2000,
    } = options;

    // The repositories are always decorated: in "apply" they delegate and record, in "plan" they
    // record and suppress the write. Nothing below needs to know which mode this is.
    const recorder = createChangeRecorder();
    const amcProductDataRepository = recordingProductDataRepository(
        repositories.amcProductDataRepository,
        recorder,
        plan ? "plan" : "apply"
    );
    const amcSubstanceDataRepository = recordingSubstanceDataRepository(
        repositories.amcSubstanceDataRepository,
        recorder,
        plan ? "plan" : "apply"
    );

    const recalculateDataInfo = await getRecalculateDataInfo(atcRepository);
    const hasExplicitScope = Boolean(
        (options.resolveOrgUnitsFromData || options.orgUnitsIds?.length) && options.periods?.length
    );

    if (!hasExplicitScope && !recalculateDataInfo) {
        throw new Error(
            "No AMC recalculation scope: the DataStore key glass/amc-recalculation is absent and no --all/--orgUnits/--periods were given"
        );
    }

    if (!force && !hasExplicitScope && !recalculateDataInfo?.recalculate) {
        logger.info(
            `[${new Date().toISOString()}] AMC recalculations are disabled (recalculate=false). Nothing to do.`
        );
        return emptySummary(0, 0);
    }

    const resolvedOrgUnitsIds = options.resolveOrgUnitsFromData
        ? await options.resolveOrgUnitsFromData()
        : options.orgUnitsIds?.length
        ? options.orgUnitsIds
        : recalculateDataInfo?.orgUnitsIds ?? [];

    const orgUnitsIds = Array.from(new Set(resolvedOrgUnitsIds));
    const periods = Array.from(new Set(options.periods?.length ? options.periods : recalculateDataInfo?.periods ?? []));

    if (!orgUnitsIds.length || !periods.length) {
        throw new Error(`Empty scope: ${orgUnitsIds.length} org units x ${periods.length} periods`);
    }

    const allPairs: Pair[] = orgUnitsIds.flatMap(orgUnitId => periods.map(period => ({ orgUnitId, period })));
    const completed = readCheckpoint(checkpointPath);
    const pairs = allPairs.filter(pair => !completed.has(pairKey(pair)));

    consoleLogger.info(
        `[${new Date().toISOString()}] Scope: ${orgUnitsIds.length} org units x ${periods.length} periods = ${
            allPairs.length
        } pairs (${allPairs.length - pairs.length} already done, ${pairs.length} to process)`
    );
    consoleLogger.info(
        `[${new Date().toISOString()}] Periods: ${periods.join(
            ","
        )} | createIfMissing=${allowCreationIfNotExist} | delay=${delayMs}ms | retries=${
            retryAttempts > 1 ? `${retryAttempts} attempts, base ${retryBaseDelayMs}ms` : "disabled"
        }`
    );

    if (dryRun) {
        consoleLogger.info(`[${new Date().toISOString()}] --dry-run: scope resolved, no data read or written.`);
        return emptySummary(allPairs.length, pairs.length);
    }

    // Everything below is fetched once for the whole run: the ATC version, its change table and the
    // product register metadata are identical for every pair.
    const glassModule = await new GetGlassModuleByIdUseCase(glassModuleRepository).execute(AMC_MODULE_ID).toPromise();
    const importCalculationChunkSize = glassModule.chunkSizes?.importCalculations;

    const { currentATCVersion, currentATCData } = await new GetCurrentATCVersionData(atcRepository)
        .execute()
        .toPromise();

    const productRegisterProgramMetadata = await amcProductDataRepository
        .getProductRegisterProgramMetadata()
        .toPromise();

    if (!productRegisterProgramMetadata) throw new Error("Product register program metadata not found");

    const remapAtc = createAtcRemapper(getATCChanges(currentATCData.changes), currentATCData.atcs);

    const productLevel = new RecalculateConsumptionDataProductLevelForAllUseCase(
        amcProductDataRepository,
        amcSubstanceDataRepository
    );
    const substanceLevel = new RecalculateConsumptionDataSubstanceLevelForAllUseCase(amcSubstanceDataRepository);

    logger.info(
        `[${new Date().toISOString()}] START - Recalculating AMC data for ${
            pairs.length
        } org unit/period pairs with ATC version ${currentATCVersion}`
    );

    const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const audit = new AmcRecalculateAudit(
        options.auditPath ?? path.join(process.cwd(), `AMC_recalculation_${plan ? "plan_" : ""}${runTimestamp}.csv`)
    );

    const summary: AmcRecalculateSummary = {
        total: allPairs.length,
        processed: 0,
        skipped: 0,
        failures: [],
        bothLevels: [],
        productLevel: { updates: 0, creates: 0, deletes: 0 },
        substanceLevel: { updates: 0, creates: 0, deletes: 0 },
        reportLines: [],
    };

    // Rolls the pair's recorded counts into the run totals and appends its audit row.
    const recordPair = (
        pair: Pair,
        startedAt: number,
        outcome: PairOutcome,
        detail: { hadProductData: boolean; hadSubstanceData: boolean; reason?: string }
    ): void => {
        summary.productLevel.updates += recorder.productLevel.updates;
        summary.productLevel.creates += recorder.productLevel.creates;
        summary.productLevel.deletes += recorder.productLevel.deletes;
        summary.substanceLevel.updates += recorder.substanceLevel.updates;
        summary.substanceLevel.creates += recorder.substanceLevel.creates;
        summary.substanceLevel.deletes += recorder.substanceLevel.deletes;

        audit.record({
            orgUnitId: pair.orgUnitId,
            period: pair.period,
            outcome,
            durationSeconds: (Date.now() - startedAt) / 1000,
            hadProductData: detail.hadProductData,
            hadSubstanceData: detail.hadSubstanceData,
            productLevel: { ...recorder.productLevel },
            substanceLevel: { ...recorder.substanceLevel },
            reason: detail.reason,
        });
    };

    for (const [index, pair] of pairs.entries()) {
        const { orgUnitId, period } = pair;
        if (delayMs > 0) await sleep(delayMs);

        consoleLogger.info(
            `[${new Date().toISOString()}] (${index + 1}/${pairs.length}) orgUnit=${orgUnitId} period=${period}`
        );

        // Counts are per pair, so the audit row attributes writes to the pair that caused them.
        resetChangeRecorder(recorder);
        const pairStartedAt = Date.now();
        let pairRetries = 0;

        // The two levels are retried independently: each is its own reconciliation, so re-running a
        // level that already succeeded would re-issue its writes for nothing. A 500 from a busy
        // DHIS2, a socket hang-up or a proxy timeout is exactly the transient case retryAsync exists
        // for; a 400 or 409 is not, and isRetryableError rethrows those at once instead of burning
        // the backoff to reach the same outcome.
        const withRetry = <T>(label: string, operation: () => Promise<T>): Promise<T> =>
            retryRecordedOperation(recorder, operation, {
                attempts: retryAttempts,
                baseDelayMs: retryBaseDelayMs,
                onRetry: (attempt, error) => {
                    pairRetries++;
                    const reason = error instanceof Error ? error.message : String(error);
                    const warning =
                        `orgUnit=${orgUnitId} period=${period} ${label} attempt ${attempt}/${retryAttempts} ` +
                        `failed, retrying: ${reason}`;
                    logger.warn(`[${new Date().toISOString()}] ${warning}`);
                    consoleLogger.warn(`[${new Date().toISOString()}] ${warning}`);
                },
            });

        try {
            const productResult = await withRetry("product level", () =>
                productLevel
                    .calculateByOrgUnitAndPeriod(
                        productRegisterProgramMetadata,
                        orgUnitId,
                        period,
                        currentATCData,
                        currentATCVersion,
                        allowCreationIfNotExist,
                        importCalculationChunkSize,
                        remapAtc
                    )
                    .toPromise()
            );

            // Product level and substance level both write calculated consumption into the same
            // DHIS2 program, and each treats everything it did not match as stale and deletes it.
            // Product level runs first, so when this org unit/period also holds product data the
            // substance pass must leave unmatched events alone — they are the product pass's output,
            // and deleting them would discard a whole level's contribution.
            const substanceResult = await withRetry("substance level", () =>
                substanceLevel
                    .calculateByOrgUnitAndPeriod(
                        orgUnitId,
                        period,
                        currentATCVersion,
                        currentATCData,
                        allowCreationIfNotExist,
                        importCalculationChunkSize,
                        remapAtc,
                        productResult.hadSourceData
                    )
                    .toPromise()
            );

            if (productResult.hadSourceData && substanceResult.hadSourceData) {
                const message =
                    `orgUnit=${orgUnitId} period=${period} holds BOTH product-level and substance-level data. ` +
                    `Both levels aggregate into the same calculated consumption program, so their rows can collide ` +
                    `on the same (atc, route, salt, combination, sector, level, status) key. Deletion was suppressed ` +
                    `to avoid losing either side; verify this pair by hand.`;
                logger.warn(`[${new Date().toISOString()}] ${message}`);
                consoleLogger.warn(`[${new Date().toISOString()}] ${message}`);
                summary.bothLevels.push({ orgUnitId, period });
            }

            appendCheckpoint(checkpointPath, pair);
            summary.processed++;

            const hadData = productResult.hadSourceData || substanceResult.hadSourceData;
            recordPair(pair, pairStartedAt, hadData ? "PROCESSED" : "NO_DATA", {
                hadProductData: productResult.hadSourceData,
                hadSubstanceData: substanceResult.hadSourceData,
                // A pair that only succeeded on a second attempt is worth spotting in the CSV: it
                // marks where the server was struggling, even though the outcome was fine.
                reason: pairRetries > 0 ? `recovered after ${pairRetries} retry attempt(s)` : undefined,
            });
        } catch (error) {
            // One bad pair must not abandon the rest of the run. It stays out of the checkpoint, so
            // a rerun with --resume retries exactly the failures.
            const message = error instanceof Error ? error.message : String(error);
            // pairRetries counts both levels, so it is the number of retries this pair consumed, not
            // an attempt count for the level that finally gave up.
            const detail = pairRetries > 0 ? `${message} (after ${pairRetries} retry attempt(s))` : message;
            summary.failures.push({ orgUnitId, period, error: detail });
            recordPair(pair, pairStartedAt, "FAILED", {
                hadProductData: false,
                hadSubstanceData: false,
                reason: detail,
            });
            logger.error(`[${new Date().toISOString()}] FAILED orgUnit=${orgUnitId} period=${period}: ${detail}`);
            consoleLogger.error(
                `[${new Date().toISOString()}] FAILED orgUnit=${orgUnitId} period=${period}: ${detail}`
            );
        }
    }

    // A rehearsal must not consume the DataStore flag either.
    if (!force && !plan) await disableRecalculations(atcRepository);

    logger.success(
        `[${new Date().toISOString()}] END - AMC recalculations finished: processed=${summary.processed}, failed=${
            summary.failures.length
        } of ${pairs.length}`
    );

    summary.reportLines = audit.summarise();
    return summary;
}

function emptySummary(total: number, skipped: number): AmcRecalculateSummary {
    return {
        total,
        processed: 0,
        skipped,
        failures: [],
        bothLevels: [],
        productLevel: { updates: 0, creates: 0, deletes: 0 },
        substanceLevel: { updates: 0, creates: 0, deletes: 0 },
        reportLines: [],
    };
}
