import { boolean, command, flag, number, option, run } from "cmd-ts";

import { setupLogger, logger } from "../utils/logger";
import { getApiUrlOptions, getInstance, warmUpSession } from "./common";
import { getD2APiFromInstance } from "../utils/d2-api";
import { DataStoreClient } from "../data/data-store/DataStoreClient";
import { AMCProductDataDefaultRepository } from "../data/repositories/data-entry/AMCProductDataDefaultRepository";
import { GlassATCDefaultRepository } from "../data/repositories/GlassATCDefaultRepository";
import { AMCSubstanceDataDefaultRepository } from "../data/repositories/data-entry/AMCSubstanceDataDefaultRepository";
import { GlassModuleDefaultRepository } from "../data/repositories/GlassModuleDefaultRepository";
import { disableRecalculations, runAmcRecalculation } from "./commands/amcRecalculate";
import consoleLogger from "../utils/consoleLogger";

/**
 * Scheduled entry point: bundled by `yarn build-amc-recalculate` and run periodically by cron.
 * It only does work when the DataStore key glass/amc-recalculation has recalculate=true, and clears
 * that flag when it finishes. For ad-hoc local runs use cliAMCEnv.ts, which takes its connection
 * details from the environment and supports --force.
 */
async function main() {
    const cmd = command({
        name: "cliAMC",
        description:
            "Recalculate AMC consumption (product level and substance level) for the org units and periods armed in the DataStore.",
        args: {
            ...getApiUrlOptions(),
            debug: flag({ type: boolean, long: "debug", description: "Print debug logs to the console" }),
            calculate: flag({
                type: boolean,
                long: "calculate",
                description: "Create calculated events that do not exist yet, not just update existing ones",
            }),
            delay: option({
                type: number,
                long: "delay",
                defaultValue: () => 0,
                description: "Milliseconds to pause between org unit/period pairs (default 0)",
            }),
        },
        handler: async args => {
            const instance = getInstance(args);
            const api = getD2APiFromInstance(instance);
            await setupLogger(instance, { isDebug: args.debug });
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

                const summary = await runAmcRecalculation(repositories, {
                    allowCreationIfNotExist: args.calculate,
                    force: false,
                    delayMs: args.delay,
                    dryRun: false,
                });

                summary.failures.forEach(({ orgUnitId, period, error }) =>
                    logger.error(`[${new Date().toISOString()}] FAILED orgUnit=${orgUnitId} period=${period}: ${error}`)
                );

                logger.info(`[${new Date().toISOString()}] Waiting for next AMC recalculations...`);
            } catch (err) {
                await disableRecalculations(atcRepository).catch(() => undefined);
                await logger.error(
                    `[${new Date().toISOString()}] ERROR - AMC recalculations were not properly executed: ${err}. They will run again on the next iteration if re-enabled.`
                );
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
