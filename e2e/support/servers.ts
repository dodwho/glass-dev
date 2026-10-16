/* Runs one cycle of a GLASS batch server (async uploads or async deletions) from source against DEV, as the
   cron does, so the tests do not wait for the real cron. Refuses to run when the queue holds anything other
   than this test run's uploads: one cycle processes the whole queue. */
import { spawn } from "child_process";
import path from "path";
import { expect, TestInfo } from "@playwright/test";
import { dhis2Url } from "./config";
import { get, getTestUploadIds } from "./dhis2";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { root, getInstance, writesAllowed } = require("../env");

/* The servers run from this checkout with the Node that runs the tests. E2E_SERVER_ROOT and E2E_SERVER_NODE run them from
   another checkout with another Node instead (for example the 1.6.45 release on Node 16, as production runs it). */
const serverRoot = process.env.E2E_SERVER_ROOT ?? root;
const serverNode = process.env.E2E_SERVER_NODE ?? process.execPath;

const servers = {
    uploads: { script: "src/scripts/cliAsyncUploads.ts", queue: "async-uploads" },
    deletions: { script: "src/scripts/cliAsyncDeletions.ts", queue: "async-deletions" },
} as const;

// Tokens for other instances are never passed on: the server must log in to DEV with DEV's own credentials.
const otherInstanceTokens = ["DHIS2_TOKEN_PROD", "DHIS2_TOKEN_PREPROD", "DHIS2_TOKEN_TRAINING"].flatMap(name => [
    name,
    `REACT_APP_${name}`,
]);

export type QueueItem = { uploadId: string; type?: string; status?: string; attempts?: number };

export const getQueue = (name: "async-uploads" | "async-deletions") => get<QueueItem[]>(`dataStore/glass/${name}`);

/** Replaces the async-uploads queue on DEV (through the browser-test server, which only allows writes to DEV). */
export async function setUploadsQueue(items: QueueItem[]) {
    if (!writesAllowed())
        throw new Error("Changing the queue writes to DHIS2: run with E2E_ALLOW_WRITES=1 against DEV");
    const response = await fetch(`${dhis2Url}/api/dataStore/glass/async-uploads`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(items),
    });
    if (!response.ok) throw new Error(`PUT async-uploads: ${response.status} ${await response.text()}`);
}

type CycleOptions = {
    /** Queue entries that are not real uploads, put there on purpose by the test (for example one that always fails). */
    fakeUploadIds?: string[];
    /** False when the test expects some of its uploads to still be queued after the cycle (it checks that itself). */
    expectQueueEmptied?: boolean;
};

export async function runServerCycle(server: keyof typeof servers, testInfo: TestInfo, options: CycleOptions = {}) {
    const { fakeUploadIds = [], expectQueueEmptied = true } = options;
    if (!writesAllowed()) throw new Error("Batch servers write to DHIS2: run with E2E_ALLOW_WRITES=1 against DEV");
    const { script, queue } = servers[server];

    const queued = await getQueue(queue);
    const testUploads = await getTestUploadIds();
    const others = queued.filter(item => !testUploads.has(item.uploadId) && !fakeUploadIds.includes(item.uploadId));
    if (others.length > 0)
        throw new Error(`${queue} on DEV holds ${others.length} upload(s) that are not test uploads: not running`);
    expect(queued.length, `${queue}: test uploads waiting`).toBeGreaterThan(0);

    const env: NodeJS.ProcessEnv = { ...process.env, REACT_APP_DHIS2_BASE_URL: getInstance().url };
    otherInstanceTokens.forEach(name => delete env[name]);

    const output: string[] = [];
    const tsNode = path.join(serverRoot, "node_modules", "ts-node", "dist", "bin.js");
    const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(serverNode, [tsNode, "--transpile-only", script], { cwd: serverRoot, env });
        child.stdout.on("data", chunk => output.push(String(chunk)));
        child.stderr.on("data", chunk => output.push(String(chunk)));
        child.on("error", reject);
        child.on("close", resolve);
    });
    await testInfo.attach(`${server}-server.log`, { body: output.join(""), contentType: "text/plain" });

    expect(exitCode, `${server} server exit code (log attached)`).toBe(0);
    if (!expectQueueEmptied) return;
    const left = (await getQueue(queue)).filter(item => testUploads.has(item.uploadId));
    expect(left, `${queue}: test uploads still queued after one cycle`).toEqual([]);
}
