/* Golden files: what DHIS2 must hold after each test import, saved from a trusted build and compared on every
   run, so a change of build tool or library cannot silently change the data written.
   E2E_UPDATE_GOLDEN=1 rewrites them (only do this on a build whose output has been checked). */
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { expect, TestInfo } from "@playwright/test";
import { Snapshot } from "./dhis2";

type GoldenPart = { count: number; sha256: string; lines?: string[] };

// Small parts keep every line, so a failure shows exactly which values changed; large ones keep a fingerprint.
const maxStoredLines = 2000;
const goldenDir = path.join(__dirname, "..", "golden");

const fingerprint = (lines: string[]): GoldenPart => ({
    count: lines.length,
    sha256: createHash("sha256").update(lines.join("\n")).digest("hex"),
    ...(lines.length <= maxStoredLines ? { lines } : {}),
});

export async function expectGolden(name: string, snapshot: Snapshot, testInfo: TestInfo) {
    const actual = Object.fromEntries(Object.entries(snapshot).map(([part, lines]) => [part, fingerprint(lines)]));
    const file = path.join(goldenDir, `${name}.json`);
    await testInfo.attach(`${name}.actual.json`, {
        body: JSON.stringify(snapshot, null, 2),
        contentType: "application/json",
    });

    if (process.env.E2E_UPDATE_GOLDEN === "1") {
        fs.mkdirSync(goldenDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(actual, null, 2) + "\n");
        testInfo.annotations.push({ type: "golden", description: `Wrote ${path.relative(process.cwd(), file)}` });
        return;
    }
    if (!fs.existsSync(file)) throw new Error(`No golden file ${name}.json: create it with E2E_UPDATE_GOLDEN=1`);

    const expected = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, GoldenPart>;
    expect(Object.keys(actual).sort(), `${name}: snapshot parts`).toEqual(Object.keys(expected).sort());
    for (const [part, golden] of Object.entries(expected)) {
        const current = actual[part];
        if (current?.sha256 === golden.sha256) continue;
        if (golden.lines && current?.lines) {
            const missing = golden.lines.filter(line => !current.lines?.includes(line)).slice(0, 10);
            const extra = current.lines.filter(line => !golden.lines?.includes(line)).slice(0, 10);
            expect({ missing, extra }, `${name}.${part} differs from the golden file`).toEqual({
                missing: [],
                extra: [],
            });
        }
        expect(current, `${name}.${part} differs from the golden file`).toEqual(golden);
    }
}
