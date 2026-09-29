import { boolean, command, flag, number, option, optional, run, string } from "cmd-ts";
import "dotenv/config";

import { setupConsoleLogger, logger } from "../utils/logger";
import { describeAuth, getEnvVars, getInstance, StringsSeparatedByCommas, warmUpSession } from "./common";
import { getD2APiFromInstance } from "../utils/d2-api";
import { DataStoreClient } from "../data/data-store/DataStoreClient";
import { AMCProductDataDefaultRepository } from "../data/repositories/data-entry/AMCProductDataDefaultRepository";
import { GlassATCDefaultRepository } from "../data/repositories/GlassATCDefaultRepository";
import { AMCSubstanceDataDefaultRepository } from "../data/repositories/data-entry/AMCSubstanceDataDefaultRepository";
import { GlassModuleDefaultRepository } from "../data/repositories/GlassModuleDefaultRepository";
import { disableRecalculations, runAmcRecalculation } from "./commands/amcRecalculate";
import { buildPeriodRange, fetchAmcCountries, findOrgUnitsWithAmcData } from "./commands/resolveAmcScope";
import consoleLogger from "../utils/consoleLogger";

// The AMC module (BVnik5xiXGJ) declares startPeriod 2016. Substance data exists from 2014, so pass
// --from-year 2014 to include the two legacy years the module's own window excludes.
const DEFAULT_FROM_YEAR = 2016;

async function main() {
    const cmd = command({
        name: "cliAMCEnv",
        description:
            "Recalculate AMC consumption (product level and substance level) for the configured org units and periods, reading connection details from the environment.",
        args: {
            debug: flag({ type: boolean, long: "debug", description: "Print debug logs to the console" }),
            calculate: flag({
                type: boolean,
                long: "calculate",
                description:
                    "Create calculated events that do not exist yet, not just update existing ones. Strongly recommended: without it, rows whose ATC code was remapped by the new version cannot be rewritten.",
            }),
            force: flag({
                type: boolean,
                long: "force",
                description:
                    "Run even when the DataStore 'recalculate' flag is false, and leave the flag untouched afterwards",
            }),
            all: flag({
                type: boolean,
                long: "all",
                description:
                    "Recalculate every org unit that actually holds AMC product-level or substance-level data, resolved by probing the data instead of trusting the DataStore list. Combine with --from-year/--to-year.",
            }),
            orgUnits: option({
                type: optional(StringsSeparatedByCommas),
                long: "orgUnits",
                description: "Comma-separated org unit ids, overriding the DataStore list",
            }),
            periods: option({
                type: optional(StringsSeparatedByCommas),
                long: "periods",
                description: "Comma-separated periods (years), overriding the DataStore list",
            }),
            fromYear: option({
                type: number,
                long: "from-year",
                defaultValue: () => DEFAULT_FROM_YEAR,
                description: `First period when using --all (default ${DEFAULT_FROM_YEAR}, the AMC module's startPeriod)`,
            }),
            toYear: option({
                type: number,
                long: "to-year",
                defaultValue: () => new Date().getFullYear(),
                description: "Last period when using --all (default: current year)",
            }),
            concurrency: option({
                type: number,
                long: "concurrency",
                defaultValue: () => 6,
                description: "Parallel count requests during --all scope resolution (default 6)",
            }),
            delay: option({
                type: number,
                long: "delay",
                defaultValue: () => 0,
                description: "Milliseconds to pause between org unit/period pairs (default 0)",
            }),
            retryAttempts: option({
                type: number,
                long: "retry-attempts",
                defaultValue: () => 3,
                description:
                    "Attempts per level before a pair is recorded as failed (default 3). Only transient failures are retried; a 4xx is reported immediately. Use 1 to disable.",
            }),
            retryDelay: option({
                type: number,
                long: "retry-delay",
                defaultValue: () => 2000,
                description: "First retry backoff in milliseconds (default 2000); doubles per attempt with full jitter",
            }),
            audit: option({
                type: optional(string),
                long: "audit",
                description:
                    "Path for the per-pair audit CSV (default: AMC_recalculation_<timestamp>.csv in the working directory)",
            }),
            checkpoint: option({
                type: optional(string),
                long: "checkpoint",
                description: "Path to a file recording completed pairs, so an interrupted run can resume",
            }),
            dryRun: flag({
                type: boolean,
                long: "dry-run",
                description: "Resolve and print the scope, then exit without reading or writing tracker data",
            }),
            plan: flag({
                type: boolean,
                long: "plan",
                description:
                    "Rehearsal: run the full pipeline for real but intercept every write, reporting what WOULD be created, updated and deleted. Changes nothing.",
            }),
        },
        handler: async args => {
            const envVars = getEnvVars();
            consoleLogger.info(
                `[${new Date().toISOString()}] >>> Target instance: ${envVars.url} (auth: ${describeAuth(envVars)})${
                    args.calculate
                        ? " | --calculate ENABLED (will create events)"
                        : " | UPDATE-ONLY (no events created)"
                }`
            );

            const instance = getInstance(envVars);
            const api = getD2APiFromInstance(instance);
            await setupConsoleLogger({ isDebug: args.debug });
            await warmUpSession(api);

            const dataStoreClient = new DataStoreClient(instance);
            const atcRepository = new GlassATCDefaultRepository(dataStoreClient);
            const repositories = {
                amcProductDataRepository: new AMCProductDataDefaultRepository(api),
                amcSubstanceDataRepository: new AMCSubstanceDataDefaultRepository(api),
                atcRepository,
                glassModuleRepository: new GlassModuleDefaultRepository(dataStoreClient),
            };

            try {
                logger.info(`[${new Date().toISOString()}] Starting AMC recalculations...`);

                const periods = args.periods ?? (args.all ? buildPeriodRange(args.fromYear, args.toYear) : undefined);

                const summary = await runAmcRecalculation(repositories, {
                    allowCreationIfNotExist: args.calculate,
                    force: args.force,
                    orgUnitsIds: args.orgUnits,
                    periods,
                    resolveOrgUnitsFromData: args.all
                        ? async () => {
                              const countries = await fetchAmcCountries(api);
                              consoleLogger.info(
                                  `[${new Date().toISOString()}] --all: probing ${
                                      countries.length
                                  } countries for AMC source data...`
                              );
                              const { orgUnitsIds } = await findOrgUnitsWithAmcData(api, countries, args.concurrency);
                              return orgUnitsIds;
                          }
                        : undefined,
                    delayMs: args.delay,
                    retryAttempts: args.retryAttempts,
                    retryBaseDelayMs: args.retryDelay,
                    auditPath: args.audit,
                    checkpointPath: args.plan ? undefined : args.checkpoint,
                    dryRun: args.dryRun,
                    plan: args.plan,
                });

                consoleLogger.info(
                    `[${new Date().toISOString()}] DONE - processed=${summary.processed}, failed=${
                        summary.failures.length
                    }, total=${summary.total}`
                );

                // The audit's own summary is the closing report; bothLevels and failures are
                // already part of it, so they are not repeated here.
                consoleLogger.info(
                    `[${new Date().toISOString()}] ${args.plan ? "PLAN (nothing was written)" : "RESULT"}:`
                );
                summary.reportLines.forEach(line => consoleLogger.info(`  ${line}`));

                if (summary.failures.length) {
                    summary.failures.forEach(({ orgUnitId, period, error }) =>
                        consoleLogger.error(`[FAILED] orgUnit=${orgUnitId} period=${period}: ${error}`)
                    );
                    consoleLogger.error(
                        `[${new Date().toISOString()}] ${
                            summary.failures.length
                        } pairs failed. Rerun with the same --checkpoint to retry only those.`
                    );
                    process.exit(1);
                }
            } catch (err) {
                // Only a setup-level failure reaches here; per-pair failures are collected in the
                // summary above. Release the DataStore flag so a scheduled run is not left armed.
                if (!args.force) await disableRecalculations(atcRepository).catch(() => undefined);
                consoleLogger.error(
                    `[${new Date().toISOString()}] AMC recalculations stopped with error: ${err}. Please restart.`
                );
                process.exit(1);
            }
        },
    });

    run(cmd, process.argv.slice(2));
}

main();
