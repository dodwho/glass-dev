import { ConsoleLogger, ProgramLogger, initLogger, BatchLogContent } from "@eyeseetea/d2-logger";
import { Instance } from "../data/entities/Instance";
import { Id } from "../domain/entities/Base";
import { getD2ApiAuth } from "./d2-api";

export const GLOBAL_ORG_UNIT = "H8RixfF8ugH";
const LOGS_PROGRAM = "zARxYmOD18Z";
const MESSAGE_DATA_ELEMENT = "BjUzF5E4eR8";
const MESSAGE_TYPE_DATA_ELEMENT = "NpS5LoLuhgS";

export let logger: ProgramLogger | ConsoleLogger;
export type { BatchLogContent };

export async function setupLogger(instance: Instance, options?: { isDebug?: boolean; orgUnitId?: Id }): Promise<void> {
    const { isDebug = false, orgUnitId } = options ?? {};

    const programLogger = await initLogger({
        type: "program",
        debug: isDebug,
        d2ApiOptions: { baseUrl: instance.url, auth: getD2ApiAuth(instance) },
        programId: LOGS_PROGRAM,
        organisationUnitId: orgUnitId || GLOBAL_ORG_UNIT,
        dataElements: {
            messageId: MESSAGE_DATA_ELEMENT,
            messageTypeId: MESSAGE_TYPE_DATA_ELEMENT,
        },
    });
    logger = catchLogErrors(programLogger);
}

// d2-logger 1.2 lets a failed write to the logs program reject, and log calls are not awaited, so on Node an
// unhandled rejection would end the process (e.g. the AMC server mid-recalculation). Report it instead, as
// d2-logger did before 1.2.
function catchLogErrors(programLogger: ProgramLogger): ProgramLogger {
    return new Proxy(programLogger, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
                const result = value.apply(target, args);
                return result instanceof Promise
                    ? result.catch(error => console.error(`[logger] Could not write the log to DHIS2: ${error}`))
                    : result;
            };
        },
    });
}

export async function setupConsoleLogger(options?: { isDebug?: boolean }): Promise<void> {
    const { isDebug = false } = options ?? {};

    logger = await initLogger({
        type: "console",
        debug: isDebug,
    });
}

export async function setupLoggerForTesting(): Promise<void> {
    logger = await initLogger({
        type: "console",
    });
}
