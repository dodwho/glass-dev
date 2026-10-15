/* Runs one cycle of a GLASS batch server (async uploads or async deletions) from source against DEV, as the
   cron does, so the tests do not wait for the real cron. Refuses to run when the queue holds anything other
   than this test run's uploads: one cycle processes the whole queue. */
import { spawn } from "child_process";
import path from "path";
import { expect, TestInfo } from "@playwright/test";
import { get, getTestUploadIds } from "./dhis2";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { root, getInstance, writesAllowed } = require("../env");

const servers = {
    uploads: { script: "src/scripts/cliAsyncUploads.ts", queue: "async-uploads" },
    deletions: { script: "src/scripts/cliAsyncDeletions.ts", queue: "async-deletions" },
} as const;

// Tokens for other instances are never passed on: the server must log in to DEV with DEV's own credentials.
const otherInstanceTokens = ["DHIS2_TOKEN_PROD", "DHIS2_TOKEN_PREPROD", "DHIS2_TOKEN_TRAINING"].flatMap(name => [
    name,
    `REACT_APP_${name}`,
]);

const getQueue = (name: string) => get<{ uploadId: string }[]>(`dataStore/glass/${name}`);

export async function runServerCycle(server: keyof typeof servers, testInfo: TestInfo) {
    if (!writesAllowed()) throw new Error("Batch servers write to DHIS2: run with E2E_ALLOW_WRITES=1 against DEV");
    const { script, queue } = servers[server];

    const queued = await getQueue(queue);
    const testUploads = await getTestUploadIds();
    const others = queued.filter(item => !testUploads.has(item.uploadId));
    if (others.length > 0)
        throw new Error(`${queue} on DEV holds ${others.length} upload(s) that are not test uploads: not running`);
    expect(queued.length, `${queue}: test uploads waiting`).toBeGreaterThan(0);

    const env: NodeJS.ProcessEnv = { ...process.env, REACT_APP_DHIS2_BASE_URL: getInstance().url };
    otherInstanceTokens.forEach(name => delete env[name]);

    const output: string[] = [];
    const tsNode = path.join(root, "node_modules", "ts-node", "dist", "bin.js");
    const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [tsNode, "--transpile-only", script], { cwd: root, env });
        child.stdout.on("data", chunk => output.push(String(chunk)));
        child.stderr.on("data", chunk => output.push(String(chunk)));
        child.on("error", reject);
        child.on("close", resolve);
    });
    await testInfo.attach(`${server}-server.log`, { body: output.join(""), contentType: "text/plain" });

    expect(exitCode, `${server} server exit code (log attached)`).toBe(0);
    const left = (await getQueue(queue)).filter(item => testUploads.has(item.uploadId));
    expect(left, `${queue}: test uploads still queued after one cycle`).toEqual([]);
}
