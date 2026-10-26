import _ from "lodash";
import { WaitForResponse } from "@eyeseetea/d2-api/api/system";
import { Future, FutureData } from "../../../domain/entities/Future";
import { D2Api } from "../../../types/d2-api";
import consoleLogger from "../../../utils/consoleLogger";
import { apiToFuture } from "../../../utils/futures";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Waits for a DHIS2 background job (an async import) and returns its summary, as api.system.waitFor does, except that
 * a status check that fails or hangs is retried instead of failing the save. The job goes on in DHIS2 either way, so
 * giving up on one dropped check reported "the import stopped" for data that was being stored. Each check is a read
 * with its own time limit; the job itself may run as long as it needs.
 */
export function waitForJob<Type extends keyof WaitForResponse>(
    api: Pick<D2Api, "request">,
    jobType: Type,
    id: string,
    options: { intervalMs?: number; checkTimeoutMs?: number; attemptsPerCheck?: number; retryDelayMs?: number } = {}
): FutureData<WaitForResponse[Type] | null> {
    const { intervalMs = 1000, checkTimeoutMs = 60_000, attemptsPerCheck = 5, retryDelayMs = 2000 } = options;

    const read = async <Data>(url: string): Promise<Data> => {
        for (let attempt = 1; ; attempt++) {
            try {
                return await apiToFuture(
                    api.request<Data>({ method: "get", url, timeout: checkTimeoutMs })
                ).toPromise();
            } catch (error) {
                if (attempt >= attemptsPerCheck) throw error;
                consoleLogger.error(`Status check of job ${id} failed (attempt ${attempt}), retrying: ${error}`);
                await sleep(Math.min(retryDelayMs * 2 ** (attempt - 1), 30_000));
            }
        }
    };

    // Deferred so the checks start when the future runs, as with apiToFuture.
    return Future.success<void, string>(undefined).flatMap(() =>
        Future.fromPromise(
            (async () => {
                while (!_.some(await read<{ completed?: boolean }[]>(`/system/tasks/${jobType}/${id}`), "completed"))
                    await sleep(intervalMs);
                return read<WaitForResponse[Type] | null>(`/system/taskSummaries/${jobType}/${id}`);
            })()
        )
    );
}
